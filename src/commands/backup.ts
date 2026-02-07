/**
 * steroids backup - Backup and restore steroids data
 *
 * Subcommands:
 * - create: Create a backup
 * - restore: Restore from backup
 * - list: List available backups
 * - clean: Clean old backups
 */

import { parseArgs } from 'node:util';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { isInitialized, getDbPath } from '../database/connection.js';
import { parseDuration } from '../cli/flags.js';

const STEROIDS_DIR = '.steroids';
const BACKUP_DIR = 'backup';
const DB_NAME = 'steroids.db';
const CONFIG_NAME = 'steroids.yaml';
const LOGS_DIR = 'logs';

interface BackupInfo {
  timestamp: string;
  path: string;
  size: number;
  includes: string[];
}

const HELP = `
steroids backup - Manage backups

USAGE:
  steroids backup <subcommand> [options]

SUBCOMMANDS:
  create                Create a new backup
  restore <path>        Restore from a backup
  list                  List available backups
  clean                 Clean old backups

CREATE OPTIONS:
  --include-logs        Include log files in backup

RESTORE OPTIONS:
  --yes                 Skip confirmation prompt

CLEAN OPTIONS:
  --older-than <dur>    Remove backups older than duration (e.g., 30d, 7d)
  --yes                 Skip confirmation prompt

EXAMPLES:
  steroids backup create
  steroids backup create --include-logs
  steroids backup list
  steroids backup restore .steroids/backup/2024-01-15T10-30-00/
  steroids backup clean --older-than 30d
`;

export async function backupCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'create':
      await createBackup(subArgs);
      break;
    case 'restore':
      await restoreBackup(subArgs);
      break;
    case 'list':
      await listBackups(subArgs);
      break;
    case 'clean':
      await cleanBackups(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function createBackup(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'include-logs': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids backup create - Create a backup

USAGE:
  steroids backup create [options]

OPTIONS:
  --include-logs        Include log files in backup
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

  const steroidsDir = join(projectPath, STEROIDS_DIR);
  const backupBaseDir = join(steroidsDir, BACKUP_DIR);

  // Create backup directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = join(backupBaseDir, timestamp);
  mkdirSync(backupDir, { recursive: true });

  const includes: string[] = [];

  // Copy database
  const dbPath = join(steroidsDir, DB_NAME);
  if (existsSync(dbPath)) {
    copyFileSync(dbPath, join(backupDir, DB_NAME));
    includes.push('db');
  }

  // Copy database WAL files if they exist
  const walPath = join(steroidsDir, `${DB_NAME}-wal`);
  const shmPath = join(steroidsDir, `${DB_NAME}-shm`);
  if (existsSync(walPath)) {
    copyFileSync(walPath, join(backupDir, `${DB_NAME}-wal`));
  }
  if (existsSync(shmPath)) {
    copyFileSync(shmPath, join(backupDir, `${DB_NAME}-shm`));
  }

  // Copy config
  const configPath = join(steroidsDir, CONFIG_NAME);
  if (existsSync(configPath)) {
    copyFileSync(configPath, join(backupDir, CONFIG_NAME));
    includes.push('config');
  }

  // Optionally copy logs
  if (values['include-logs']) {
    const logsDir = join(steroidsDir, LOGS_DIR);
    if (existsSync(logsDir)) {
      const backupLogsDir = join(backupDir, LOGS_DIR);
      mkdirSync(backupLogsDir, { recursive: true });
      copyDirectoryRecursive(logsDir, backupLogsDir);
      includes.push('logs');
    }
  }

  // Write manifest
  const manifest = {
    timestamp,
    createdAt: new Date().toISOString(),
    includes,
    version: '0.1.0',
  };
  writeFileSync(
    join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // Calculate size
  const size = getDirectorySize(backupDir);

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'backup create',
      data: {
        path: backupDir,
        timestamp,
        includes,
        size,
      },
      error: null,
    }, null, 2));
  } else {
    console.log(`Backup created: ${backupDir}`);
    console.log(`  Includes: ${includes.join(', ')}`);
    console.log(`  Size: ${formatSize(size)}`);
  }
}

async function restoreBackup(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids backup restore <path> - Restore from backup

USAGE:
  steroids backup restore <path> [options]

OPTIONS:
  -y, --yes             Skip confirmation prompt
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const backupPath = positionals[0];
  if (!existsSync(backupPath)) {
    console.error(`Backup not found: ${backupPath}`);
    process.exit(1);
  }

  const manifestPath = join(backupPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`Invalid backup: missing manifest.json`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  if (!values.yes) {
    console.log(`Restoring backup from ${manifest.timestamp}`);
    console.log(`  Includes: ${manifest.includes.join(', ')}`);
    console.log('\nThis will overwrite current data. Continue? (use --yes to skip)');
    process.exit(1);
  }

  const projectPath = process.cwd();
  const steroidsDir = join(projectPath, STEROIDS_DIR);

  // Ensure steroids directory exists
  if (!existsSync(steroidsDir)) {
    mkdirSync(steroidsDir, { recursive: true });
  }

  const restored: string[] = [];

  // Restore database
  const backupDbPath = join(backupPath, DB_NAME);
  if (existsSync(backupDbPath)) {
    copyFileSync(backupDbPath, join(steroidsDir, DB_NAME));
    restored.push('db');

    // Restore WAL files if they exist
    const backupWalPath = join(backupPath, `${DB_NAME}-wal`);
    const backupShmPath = join(backupPath, `${DB_NAME}-shm`);
    if (existsSync(backupWalPath)) {
      copyFileSync(backupWalPath, join(steroidsDir, `${DB_NAME}-wal`));
    }
    if (existsSync(backupShmPath)) {
      copyFileSync(backupShmPath, join(steroidsDir, `${DB_NAME}-shm`));
    }
  }

  // Restore config
  const backupConfigPath = join(backupPath, CONFIG_NAME);
  if (existsSync(backupConfigPath)) {
    copyFileSync(backupConfigPath, join(steroidsDir, CONFIG_NAME));
    restored.push('config');
  }

  // Restore logs
  const backupLogsDir = join(backupPath, LOGS_DIR);
  if (existsSync(backupLogsDir)) {
    const logsDir = join(steroidsDir, LOGS_DIR);
    if (existsSync(logsDir)) {
      rmSync(logsDir, { recursive: true });
    }
    mkdirSync(logsDir, { recursive: true });
    copyDirectoryRecursive(backupLogsDir, logsDir);
    restored.push('logs');
  }

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'backup restore',
      data: {
        backupPath,
        timestamp: manifest.timestamp,
        restored,
      },
      error: null,
    }, null, 2));
  } else {
    console.log(`Restored ${restored.join(', ')} from backup.`);
  }
}

async function listBackups(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids backup list - List available backups

USAGE:
  steroids backup list [options]

OPTIONS:
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  const backupBaseDir = join(projectPath, STEROIDS_DIR, BACKUP_DIR);

  if (!existsSync(backupBaseDir)) {
    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'backup list',
        data: { backups: [] },
        error: null,
      }, null, 2));
    } else {
      console.log('No backups found.');
    }
    return;
  }

  const backups = getBackups(backupBaseDir);

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'backup list',
      data: {
        backups: backups.map(b => ({
          timestamp: b.timestamp,
          path: b.path,
          size: b.size,
          includes: b.includes,
        })),
      },
      error: null,
    }, null, 2));
    return;
  }

  if (backups.length === 0) {
    console.log('No backups found.');
    return;
  }

  console.log('TIMESTAMP              SIZE      INCLUDES');
  console.log('\u2500'.repeat(55));

  for (const backup of backups) {
    const timestamp = backup.timestamp.padEnd(22);
    const size = formatSize(backup.size).padEnd(10);
    const includes = backup.includes.join(', ');
    console.log(`${timestamp}${size}${includes}`);
  }
}

async function cleanBackups(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'older-than': { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids backup clean - Clean old backups

USAGE:
  steroids backup clean [options]

OPTIONS:
  --older-than <dur>    Remove backups older than duration (e.g., 30d, 7d)
  -y, --yes             Skip confirmation prompt
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  const backupBaseDir = join(projectPath, STEROIDS_DIR, BACKUP_DIR);

  if (!existsSync(backupBaseDir)) {
    console.log('No backups found.');
    return;
  }

  const backups = getBackups(backupBaseDir);

  if (backups.length === 0) {
    console.log('No backups found.');
    return;
  }

  let toRemove = backups;

  if (values['older-than']) {
    const durationMs = parseDurationDays(values['older-than']);
    const cutoff = Date.now() - durationMs;
    toRemove = backups.filter(b => {
      const backupTime = new Date(b.timestamp.replace(/-/g, (m, i) =>
        i < 10 ? m : i < 13 ? ':' : ':'
      ).replace('T', 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2')).getTime();
      // Parse ISO-like timestamp
      const parsed = parseBackupTimestamp(b.timestamp);
      return parsed < cutoff;
    });
  }

  if (toRemove.length === 0) {
    console.log('No backups to remove.');
    return;
  }

  const totalSize = toRemove.reduce((sum, b) => sum + b.size, 0);

  if (!values.yes) {
    console.log(`Would remove ${toRemove.length} backups (${formatSize(totalSize)})`);
    console.log('Use --yes to confirm.');
    return;
  }

  for (const backup of toRemove) {
    rmSync(backup.path, { recursive: true });
  }

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'backup clean',
      data: {
        removed: toRemove.length,
        freedBytes: totalSize,
      },
      error: null,
    }, null, 2));
  } else {
    console.log(`Removed ${toRemove.length} backups (${formatSize(totalSize)} freed).`);
  }
}

function getBackups(backupBaseDir: string): BackupInfo[] {
  const backups: BackupInfo[] = [];

  try {
    const entries = readdirSync(backupBaseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const backupPath = join(backupBaseDir, entry.name);
      const manifestPath = join(backupPath, 'manifest.json');

      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          const size = getDirectorySize(backupPath);

          backups.push({
            timestamp: manifest.timestamp || entry.name,
            path: backupPath,
            size,
            includes: manifest.includes || [],
          });
        } catch {
          // Invalid manifest, skip
        }
      } else {
        // No manifest, use directory info
        const size = getDirectorySize(backupPath);
        backups.push({
          timestamp: entry.name,
          path: backupPath,
          size,
          includes: [],
        });
      }
    }
  } catch {
    // Directory read error
  }

  // Sort by timestamp descending (newest first)
  return backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function copyDirectoryRecursive(src: string, dest: string): void {
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function getDirectorySize(directory: string): number {
  let size = 0;

  try {
    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(entryPath);
      } else {
        size += statSync(entryPath).size;
      }
    }
  } catch {
    // Permission denied or other error
  }

  return size;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
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

function parseBackupTimestamp(timestamp: string): number {
  // Format: 2024-01-15T10-30-00
  try {
    const isoString = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    return new Date(isoString).getTime();
  } catch {
    return 0;
  }
}
