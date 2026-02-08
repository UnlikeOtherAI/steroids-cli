import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids purge - Purge completed tasks, orphaned IDs, and old logs
 *
 * Subcommands:
 * - tasks: Purge completed tasks older than specified duration
 * - ids: Purge orphaned IDs
 * - logs: Purge old logs
 * - all: Purge everything
 */

import { parseArgs } from 'node:util';
import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { openDatabase, isInitialized } from '../database/connection.js';
import type Database from 'better-sqlite3';
import { generateHelp } from '../cli/help.js';

const STEROIDS_DIR = '.steroids';
const LOGS_DIR = 'logs';
const BACKUP_DIR = 'backup';

interface PurgeResult {
  tasks: number;
  auditEntries: number;
  disputes: number;
  orphanedIds: number;
  logBytes: number;
  logFiles: number;
}

const HELP = generateHelp({
  command: 'purge',
  description: 'Purge old data',
  details: 'Remove completed tasks, orphaned IDs, and old log files to free up space and clean the database.',
  usage: [
    'steroids purge <subcommand> [options]',
  ],
  subcommands: [
    { name: 'tasks', description: 'Purge completed tasks' },
    { name: 'ids', description: 'Purge orphaned IDs' },
    { name: 'logs', description: 'Purge old logs' },
    { name: 'all', description: 'Purge everything' },
  ],
  options: [
    { long: 'older-than', description: 'Purge data older than duration (tasks, logs)', values: '<dur> (e.g., 30d, 7d)' },
    { short: 'y', long: 'yes', description: 'Skip confirmation prompt' },
    { long: 'keep-audit', description: 'Preserve audit trail (tasks)' },
    { long: 'backup', description: 'Backup before purge (tasks, all)' },
  ],
  examples: [
    { command: 'steroids purge tasks --older-than 30d --dry-run', description: 'Preview purging old tasks' },
    { command: 'steroids purge tasks --older-than 30d --yes --backup', description: 'Purge tasks with backup' },
    { command: 'steroids purge ids', description: 'Clean orphaned IDs' },
    { command: 'steroids purge logs --older-than 7d', description: 'Remove logs older than 7 days' },
    { command: 'steroids purge all --yes --backup', description: 'Purge everything with backup' },
  ],
  related: [
    { command: 'steroids gc', description: 'Garbage collection' },
    { command: 'steroids backup', description: 'Manage backups' },
  ],
});

export async function purgeCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'tasks':
      await purgeTasks(subArgs, flags);
      break;
    case 'ids':
      await purgeIds(subArgs, flags);
      break;
    case 'logs':
      await purgeLogs(subArgs, flags);
      break;
    case 'all':
      await purgeAll(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function purgeTasks(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'older-than': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      'keep-audit': { type: 'boolean', default: false },
      backup: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids purge tasks - Purge completed tasks

USAGE:
  steroids purge tasks [options]

OPTIONS:
  --older-than <dur>    Purge tasks older than duration (e.g., 30d)
  --dry-run             Preview without making changes
  -y, --yes             Skip confirmation prompt
  --keep-audit          Preserve audit trail
  --backup              Backup before purge
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  if (!isInitialized(projectPath)) {
    console.error('Steroids not initialized. Run "steroids init" first.');
    process.exit(1);
  }

  // Create backup if requested
  if (values.backup && !values['dry-run']) {
    const { backupCommand } = await import('./backup.js');
    await backupCommand(['create'], flags);
  }

  const { db, close } = openDatabase(projectPath);

  try {
    const result = purgeCompletedTasks(
      db,
      values['older-than'],
      values['dry-run'] ?? false,
      values['keep-audit'] ?? false
    );

    if (!values['dry-run'] && !values.yes && result.tasks > 0) {
      console.log(`Would purge:`);
      console.log(`  ${result.tasks} completed tasks`);
      console.log(`  ${result.auditEntries} audit entries`);
      console.log(`  ${result.disputes} resolved disputes`);
      console.log('\nRun with --yes to confirm.');
      return;
    }

    outputPurgeResult('tasks', result, values.json ?? false, values['dry-run'] ?? false);
  } finally {
    close();
  }
}

async function purgeIds(args: string[], _flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids purge ids - Purge orphaned IDs

USAGE:
  steroids purge ids [options]

OPTIONS:
  --dry-run             Preview without making changes
  -y, --yes             Skip confirmation prompt
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  if (!isInitialized(projectPath)) {
    console.error('Steroids not initialized. Run "steroids init" first.');
    process.exit(1);
  }

  const { db, close } = openDatabase(projectPath);

  try {
    const count = purgeOrphanedIds(db, values['dry-run'] ?? false);

    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'purge ids',
        dryRun: values['dry-run'] ?? false,
        data: { orphanedIds: count },
        error: null,
      }, null, 2));
    } else {
      const prefix = values['dry-run'] ? 'Would remove' : 'Removed';
      console.log(`${prefix} ${count} orphaned IDs.`);
    }
  } finally {
    close();
  }
}

async function purgeLogs(args: string[], _flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'older-than': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids purge logs - Purge old logs

USAGE:
  steroids purge logs [options]

OPTIONS:
  --older-than <dur>    Purge logs older than duration (e.g., 7d)
  --dry-run             Preview without making changes
  -y, --yes             Skip confirmation prompt
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  const logsDir = join(projectPath, STEROIDS_DIR, LOGS_DIR);

  if (!existsSync(logsDir)) {
    console.log('No logs found.');
    return;
  }

  const result = purgeLogFiles(logsDir, values['older-than'], values['dry-run'] ?? false);

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'purge logs',
      dryRun: values['dry-run'] ?? false,
      data: {
        files: result.logFiles,
        bytes: result.logBytes,
      },
      error: null,
    }, null, 2));
  } else {
    const prefix = values['dry-run'] ? 'Would purge' : 'Purged';
    console.log(`${prefix} ${formatSize(result.logBytes)} of logs (${result.logFiles} files).`);
  }
}

async function purgeAll(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      backup: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids purge all - Purge everything

USAGE:
  steroids purge all [options]

OPTIONS:
  --dry-run             Preview without making changes
  -y, --yes             Skip confirmation prompt
  --backup              Backup before purge
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  if (!values.yes && !values['dry-run']) {
    console.log('This will purge ALL steroids data including:');
    console.log('  - All completed tasks');
    console.log('  - All audit entries');
    console.log('  - All disputes');
    console.log('  - All orphaned IDs');
    console.log('  - All logs');
    console.log('\nRun with --yes to confirm, or --backup to create backup first.');
    return;
  }

  const projectPath = process.cwd();
  if (!isInitialized(projectPath)) {
    console.error('Steroids not initialized. Run "steroids init" first.');
    process.exit(1);
  }

  // Create backup if requested
  if (values.backup && !values['dry-run']) {
    const { backupCommand } = await import('./backup.js');
    await backupCommand(['create', '--include-logs'], flags);
    console.log('');
  }

  const dryRun = values['dry-run'] ?? false;
  const result: PurgeResult = {
    tasks: 0,
    auditEntries: 0,
    disputes: 0,
    orphanedIds: 0,
    logBytes: 0,
    logFiles: 0,
  };

  const { db, close } = openDatabase(projectPath);

  try {
    // Purge completed tasks
    const taskResult = purgeCompletedTasks(db, undefined, dryRun, false);
    result.tasks = taskResult.tasks;
    result.auditEntries = taskResult.auditEntries;
    result.disputes = taskResult.disputes;

    // Purge orphaned IDs
    result.orphanedIds = purgeOrphanedIds(db, dryRun);
  } finally {
    close();
  }

  // Purge logs
  const logsDir = join(projectPath, STEROIDS_DIR, LOGS_DIR);
  if (existsSync(logsDir)) {
    const logResult = purgeLogFiles(logsDir, undefined, dryRun);
    result.logBytes = logResult.logBytes;
    result.logFiles = logResult.logFiles;
  }

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'purge all',
      dryRun,
      data: result,
      error: null,
    }, null, 2));
  } else {
    const prefix = dryRun ? 'Would purge' : 'Purged';
    console.log(`${prefix} all data.`);
    if (result.tasks > 0) console.log(`  ${result.tasks} completed tasks`);
    if (result.auditEntries > 0) console.log(`  ${result.auditEntries} audit entries`);
    if (result.disputes > 0) console.log(`  ${result.disputes} disputes`);
    if (result.orphanedIds > 0) console.log(`  ${result.orphanedIds} orphaned IDs`);
    if (result.logBytes > 0) console.log(`  ${formatSize(result.logBytes)} of logs`);
  }
}

function purgeCompletedTasks(
  db: Database.Database,
  olderThan: string | undefined,
  dryRun: boolean,
  keepAudit: boolean
): { tasks: number; auditEntries: number; disputes: number } {
  let cutoff: string | null = null;

  if (olderThan) {
    const durationMs = parseDurationDays(olderThan);
    cutoff = new Date(Date.now() - durationMs).toISOString();
  }

  // Count tasks to purge
  let sql = `SELECT id FROM tasks WHERE status = 'completed'`;
  if (cutoff) {
    sql += ` AND updated_at < ?`;
  }

  const tasksToDelete = cutoff
    ? (db.prepare(sql).all(cutoff) as { id: string }[])
    : (db.prepare(sql).all() as { id: string }[]);

  const taskIds = tasksToDelete.map(t => t.id);

  if (taskIds.length === 0) {
    return { tasks: 0, auditEntries: 0, disputes: 0 };
  }

  // Count audit entries
  let auditCount = 0;
  if (!keepAudit) {
    const placeholders = taskIds.map(() => '?').join(',');
    auditCount = (db.prepare(
      `SELECT COUNT(*) as count FROM audit WHERE task_id IN (${placeholders})`
    ).get(...taskIds) as { count: number }).count;
  }

  // Count disputes
  let disputeCount = 0;
  try {
    const placeholders = taskIds.map(() => '?').join(',');
    disputeCount = (db.prepare(
      `SELECT COUNT(*) as count FROM disputes WHERE task_id IN (${placeholders})`
    ).get(...taskIds) as { count: number }).count;
  } catch {
    // Disputes table might not exist
  }

  if (!dryRun) {
    const placeholders = taskIds.map(() => '?').join(',');

    // Delete audit entries
    if (!keepAudit) {
      db.prepare(`DELETE FROM audit WHERE task_id IN (${placeholders})`).run(...taskIds);
    }

    // Delete disputes
    try {
      db.prepare(`DELETE FROM disputes WHERE task_id IN (${placeholders})`).run(...taskIds);
    } catch {
      // Disputes table might not exist
    }

    // Delete tasks
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);
  }

  return {
    tasks: taskIds.length,
    auditEntries: auditCount,
    disputes: disputeCount,
  };
}

function purgeOrphanedIds(db: Database.Database, dryRun: boolean): number {
  let count = 0;

  // Find and remove orphaned audit entries
  const orphanedAudit = db.prepare(`
    SELECT COUNT(*) as count FROM audit
    WHERE task_id NOT IN (SELECT id FROM tasks)
  `).get() as { count: number };
  count += orphanedAudit.count;

  if (!dryRun && orphanedAudit.count > 0) {
    db.prepare(`
      DELETE FROM audit WHERE task_id NOT IN (SELECT id FROM tasks)
    `).run();
  }

  // Find and remove orphaned disputes
  try {
    const orphanedDisputes = db.prepare(`
      SELECT COUNT(*) as count FROM disputes
      WHERE task_id NOT IN (SELECT id FROM tasks)
    `).get() as { count: number };
    count += orphanedDisputes.count;

    if (!dryRun && orphanedDisputes.count > 0) {
      db.prepare(`
        DELETE FROM disputes WHERE task_id NOT IN (SELECT id FROM tasks)
      `).run();
    }
  } catch {
    // Disputes table might not exist
  }

  // Fix orphaned task section references
  const orphanedTasks = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE section_id IS NOT NULL
    AND section_id NOT IN (SELECT id FROM sections)
  `).get() as { count: number };
  count += orphanedTasks.count;

  if (!dryRun && orphanedTasks.count > 0) {
    db.prepare(`
      UPDATE tasks SET section_id = NULL
      WHERE section_id IS NOT NULL
      AND section_id NOT IN (SELECT id FROM sections)
    `).run();
  }

  return count;
}

function purgeLogFiles(
  logsDir: string,
  olderThan: string | undefined,
  dryRun: boolean
): { logFiles: number; logBytes: number } {
  let cutoffMs = 0;

  if (olderThan) {
    cutoffMs = Date.now() - parseDurationDays(olderThan);
  }

  let totalFiles = 0;
  let totalBytes = 0;

  try {
    const entries = readdirSync(logsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filePath = join(logsDir, entry.name);
      const stat = statSync(filePath);

      // If olderThan specified, only purge files older than cutoff
      if (cutoffMs > 0 && stat.mtimeMs >= cutoffMs) {
        continue;
      }

      totalFiles++;
      totalBytes += stat.size;

      if (!dryRun) {
        unlinkSync(filePath);
      }
    }
  } catch {
    // Directory read error
  }

  return { logFiles: totalFiles, logBytes: totalBytes };
}

function outputPurgeResult(
  type: string,
  result: { tasks: number; auditEntries: number; disputes: number },
  json: boolean,
  dryRun: boolean
): void {
  if (json) {
    console.log(JSON.stringify({
      success: true,
      command: `purge ${type}`,
      dryRun,
      data: result,
      error: null,
    }, null, 2));
    return;
  }

  const prefix = dryRun ? 'Would purge' : 'Purged';
  console.log(`${prefix}:`);
  console.log(`  ${result.tasks} completed tasks`);
  console.log(`  ${result.auditEntries} audit entries`);
  console.log(`  ${result.disputes} resolved disputes`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function parseDurationDays(duration: string): number {
  const match = duration.match(/^(\d+)(d|w|m)?$/);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}. Use format: 30d, 7d, 2w`);
  }

  const num = parseInt(match[1], 10);
  const unit = match[2] || 'd';

  switch (unit) {
    case 'd':
      return num * 24 * 60 * 60 * 1000;
    case 'w':
      return num * 7 * 24 * 60 * 60 * 1000;
    case 'm':
      return num * 30 * 24 * 60 * 60 * 1000;
    default:
      return num * 24 * 60 * 60 * 1000;
  }
}
