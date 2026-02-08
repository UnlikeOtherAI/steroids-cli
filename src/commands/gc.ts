import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids gc - Garbage collection
 *
 * Cleans up orphaned data, temp files, and optimizes database.
 */

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, isInitialized } from '../database/connection.js';
import type Database from 'better-sqlite3';
import { generateHelp } from '../cli/help.js';

const STEROIDS_DIR = '.steroids';
const TEMP_DIR = 'tmp';
const LOGS_DIR = 'logs';

interface GcResult {
  orphanedIds: number;
  staleRunners: number;
  tempFiles: number;
  vacuumedBytes: number;
}

const HELP = generateHelp({
  command: 'gc',
  description: 'Garbage collection',
  details: `Performs garbage collection to clean up:
- Orphaned IDs (tasks/sections with invalid references)
- Stale runner entries (runners that are no longer active)
- Temp files (leftover temporary files)
- Database optimization (VACUUM to reclaim space)`,
  usage: [
    'steroids gc [options]',
  ],
  options: [
    { long: 'orphaned-ids', description: 'Clean orphaned task/section IDs only' },
    { long: 'stale-runners', description: 'Clean stale runner entries only' },
    { long: 'temp-files', description: 'Clean temp files only' },
    { long: 'vacuum', description: 'Optimize database only' },
  ],
  examples: [
    { command: 'steroids gc', description: 'Run all cleanup operations' },
    { command: 'steroids gc --dry-run', description: 'Preview without making changes' },
    { command: 'steroids gc --orphaned-ids', description: 'Clean orphaned IDs only' },
    { command: 'steroids gc --temp-files --vacuum', description: 'Clean temp files and optimize database' },
  ],
  related: [
    { command: 'steroids purge', description: 'Purge old data' },
    { command: 'steroids backup', description: 'Create backups' },
  ],
});

export async function gcCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag first
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      'orphaned-ids': { type: 'boolean', default: false },
      'stale-runners': { type: 'boolean', default: false },
      'temp-files': { type: 'boolean', default: false },
      vacuum: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const projectPath = process.cwd();
  if (!isInitialized(projectPath)) {
    console.error('Steroids not initialized. Run "steroids init" first.');
    process.exit(1);
  }

  // If no specific option, run all
  const runAll = !values['orphaned-ids'] &&
    !values['stale-runners'] &&
    !values['temp-files'] &&
    !values.vacuum;

  const dryRun = flags.dryRun;
  const result: GcResult = {
    orphanedIds: 0,
    staleRunners: 0,
    tempFiles: 0,
    vacuumedBytes: 0,
  };

  const { db, close } = openDatabase(projectPath);

  try {
    // Clean orphaned IDs
    if (runAll || values['orphaned-ids']) {
      result.orphanedIds = cleanOrphanedIds(db, dryRun);
    }

    // Clean stale runners
    if (runAll || values['stale-runners']) {
      result.staleRunners = cleanStaleRunners(db, dryRun);
    }

    // Clean temp files
    if (runAll || values['temp-files']) {
      result.tempFiles = cleanTempFiles(projectPath, dryRun);
    }

    // Vacuum database
    if (runAll || values.vacuum) {
      result.vacuumedBytes = vacuumDatabase(db, dryRun);
    }
  } finally {
    close();
  }

  outputResult(result, flags.json, dryRun);
}

function cleanOrphanedIds(db: Database.Database, dryRun: boolean): number {
  let count = 0;

  // Find tasks with non-existent section IDs
  const orphanedTasks = db.prepare(`
    SELECT t.id FROM tasks t
    LEFT JOIN sections s ON t.section_id = s.id
    WHERE t.section_id IS NOT NULL AND s.id IS NULL
  `).all() as { id: string }[];

  count += orphanedTasks.length;

  if (!dryRun && orphanedTasks.length > 0) {
    // Set section_id to NULL for orphaned tasks
    db.prepare(`
      UPDATE tasks SET section_id = NULL
      WHERE section_id NOT IN (SELECT id FROM sections)
    `).run();
  }

  // Find audit entries for non-existent tasks
  const orphanedAudit = db.prepare(`
    SELECT a.id FROM audit a
    LEFT JOIN tasks t ON a.task_id = t.id
    WHERE t.id IS NULL
  `).all() as { id: number }[];

  count += orphanedAudit.length;

  if (!dryRun && orphanedAudit.length > 0) {
    db.prepare(`
      DELETE FROM audit
      WHERE task_id NOT IN (SELECT id FROM tasks)
    `).run();
  }

  // Find disputes for non-existent tasks
  try {
    const orphanedDisputes = db.prepare(`
      SELECT d.id FROM disputes d
      LEFT JOIN tasks t ON d.task_id = t.id
      WHERE t.id IS NULL
    `).all() as { id: string }[];

    count += orphanedDisputes.length;

    if (!dryRun && orphanedDisputes.length > 0) {
      db.prepare(`
        DELETE FROM disputes
        WHERE task_id NOT IN (SELECT id FROM tasks)
      `).run();
    }
  } catch {
    // Disputes table might not exist
  }

  return count;
}

function cleanStaleRunners(db: Database.Database, dryRun: boolean): number {
  // Check if runners table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='runners'
  `).get();

  if (!tableExists) {
    return 0;
  }

  // Find runners with expired heartbeats (older than 5 minutes)
  const staleTimeout = 5 * 60 * 1000; // 5 minutes
  const cutoff = new Date(Date.now() - staleTimeout).toISOString();

  const staleRunners = db.prepare(`
    SELECT id FROM runners
    WHERE last_heartbeat < ? OR status = 'dead'
  `).all(cutoff) as { id: string }[];

  if (!dryRun && staleRunners.length > 0) {
    db.prepare(`
      DELETE FROM runners
      WHERE last_heartbeat < ? OR status = 'dead'
    `).run(cutoff);
  }

  return staleRunners.length;
}

function cleanTempFiles(projectPath: string, dryRun: boolean): number {
  const tempDir = join(projectPath, STEROIDS_DIR, TEMP_DIR);
  let count = 0;

  if (!existsSync(tempDir)) {
    return 0;
  }

  try {
    const entries = readdirSync(tempDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(tempDir, entry.name);

      if (entry.isDirectory()) {
        // Check if directory is older than 1 hour
        const stat = statSync(entryPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > 60 * 60 * 1000) {
          count++;
          if (!dryRun) {
            rmSync(entryPath, { recursive: true });
          }
        }
      } else {
        // All temp files can be cleaned
        count++;
        if (!dryRun) {
          unlinkSync(entryPath);
        }
      }
    }
  } catch {
    // Directory read error
  }

  // Also clean lock files that are stale
  const steroidsDir = join(projectPath, STEROIDS_DIR);
  try {
    const entries = readdirSync(steroidsDir);
    for (const entry of entries) {
      if (entry.endsWith('.lock')) {
        const lockPath = join(steroidsDir, entry);
        const stat = statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;

        // Stale if older than 10 minutes
        if (age > 10 * 60 * 1000) {
          count++;
          if (!dryRun) {
            unlinkSync(lockPath);
          }
        }
      }
    }
  } catch {
    // Directory read error
  }

  return count;
}

function vacuumDatabase(db: Database.Database, dryRun: boolean): number {
  if (dryRun) {
    // Estimate freed space with PRAGMA page_count and freelist_count
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const freePages = db.pragma('freelist_count', { simple: true }) as number;
    return (freePages as number) * (pageSize as number);
  }

  // Get size before
  const beforePages = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const beforeSize = (beforePages as number) * (pageSize as number);

  // Run VACUUM
  db.exec('VACUUM');

  // Get size after
  const afterPages = db.pragma('page_count', { simple: true }) as number;
  const afterSize = (afterPages as number) * (pageSize as number);

  return Math.max(0, beforeSize - afterSize);
}

function outputResult(result: GcResult, json: boolean, dryRun: boolean): void {
  const prefix = dryRun ? 'Would ' : '';

  if (json) {
    console.log(JSON.stringify({
      success: true,
      command: 'gc',
      dryRun,
      data: {
        orphanedIds: result.orphanedIds,
        staleRunners: result.staleRunners,
        tempFiles: result.tempFiles,
        vacuumedBytes: result.vacuumedBytes,
      },
      error: null,
    }, null, 2));
    return;
  }

  console.log(`Garbage collection ${dryRun ? '(dry run)' : 'complete'}:`);

  if (result.orphanedIds > 0) {
    console.log(`  \u2713 ${prefix}Removed ${result.orphanedIds} orphaned IDs`);
  } else {
    console.log(`  - No orphaned IDs found`);
  }

  if (result.staleRunners > 0) {
    console.log(`  \u2713 ${prefix}Cleaned ${result.staleRunners} stale runner entries`);
  } else {
    console.log(`  - No stale runners found`);
  }

  if (result.tempFiles > 0) {
    console.log(`  \u2713 ${prefix}Deleted ${result.tempFiles} temp files`);
  } else {
    console.log(`  - No temp files found`);
  }

  if (result.vacuumedBytes > 0) {
    console.log(`  \u2713 ${prefix}Vacuumed database (${formatSize(result.vacuumedBytes)} ${dryRun ? 'potential' : 'saved'})`);
  } else {
    console.log(`  - Database already optimized`);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
