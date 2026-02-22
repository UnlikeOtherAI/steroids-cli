/**
 * Retention cleanup for timestamped backups.
 *
 * These are stored in directories at:
 *   .steroids/backup/YYYY-MM-DDTHH-mm-ss/
 * Or as pre-migration files:
 *   .steroids/backup/pre-migrate-YYYY-MM-DDTHH-mm-ss-SSSZ.db
 */

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CleanupInvocationLogsResult } from './invocation-logs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type CleanupBackupsResult = CleanupInvocationLogsResult;

export interface CleanupBackupsOptions {
  /**
   * Keep backups within this retention window.
   * If <= 0, no files will be deleted.
   */
  retentionDays?: number;
  /** Preview without deleting files. */
  dryRun?: boolean;
  /** Inject current time for deterministic tests. */
  nowMs?: number;
}

/**
 * Parse a backup directory or file name to a timestamp.
 * Format: 2024-01-15T10-30-00 or YYYY-MM-DD or pre-migrate-YYYY-MM-DDTHH-mm-ss-SSSZ.db
 */
function parseBackupTimestamp(name: string): number | null {
  // Try migration backup file format: pre-migrate-2024-01-15T10-30-00-000Z.db
  const migrateMatch = /^pre-migrate-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z/.exec(name);
  if (migrateMatch) {
    const [_, y, m, d, hh, mm, ss, ms] = migrateMatch.map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms));
    return isNaN(date.getTime()) ? null : date.getTime();
  }

  // Try ISO-like format: 2024-01-15T10-30-00
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (isoMatch) {
    const [_, y, m, d, hh, mm, ss] = isoMatch.map(Number);
    // Use UTC consistently to match migration backups
    const date = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
    return isNaN(date.getTime()) ? null : date.getTime();
  }

  // Try date-only format: 2024-01-15
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (dateMatch) {
    const [_, y, m, d] = dateMatch.map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return isNaN(date.getTime()) ? null : date.getTime();
  }

  return null;
}

/**
 * Delete old `.steroids/backup/` directories and pre-migrate files based on date in name.
 */
export function cleanupBackups(
  projectPath: string,
  options: CleanupBackupsOptions = {}
): CleanupBackupsResult {
  const retentionDays = options.retentionDays ?? 30;
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (retentionDays * DAY_MS);

  if (retentionDays <= 0) {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  const backupDir = join(projectPath, '.steroids', 'backup');
  if (!existsSync(backupDir)) {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  let scannedFiles = 0;
  let deletedFiles = 0;
  let freedBytes = 0;

  try {
    const entries = readdirSync(backupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;

      const backupTime = parseBackupTimestamp(entry.name);
      if (backupTime === null) continue;

      scannedFiles++;

      // Check if backup is older than retention
      if (backupTime >= cutoffMs) continue;

      const fullPath = join(backupDir, entry.name);
      
      // Calculate size before deleting
      let size = 0;
      if (entry.isDirectory()) {
        size = getDirectorySize(fullPath);
      } else {
        try {
          const st = statSync(fullPath);
          size = st.size;
          
          // Also include size of associated WAL/SHM files if we're going to delete them
          if (entry.name.endsWith('.db')) {
            try { size += statSync(`${fullPath}-wal`).size; } catch {}
            try { size += statSync(`${fullPath}-shm`).size; } catch {}
          }
        } catch {
          continue; // File may have disappeared
        }
      }
      
      deletedFiles++;
      freedBytes += size;

      if (!options.dryRun) {
        try {
          if (entry.isDirectory()) {
            rmSync(fullPath, { recursive: true, force: true });
          } else {
            rmSync(fullPath, { force: true });
            
            // Also try to delete associated WAL/SHM if it's a .db file
            if (entry.name.endsWith('.db')) {
              try { rmSync(`${fullPath}-wal`, { force: true }); } catch {}
              try { rmSync(`${fullPath}-shm`, { force: true }); } catch {}
            }
          }
        } catch {
          // If deletion fails, decrement counts to reflect actual work
          deletedFiles--;
          freedBytes -= size;
        }
      }
    }
  } catch {
    // Directory read error
  }

  return { scannedFiles, deletedFiles, freedBytes, cutoffMs };
}

/**
 * Helper to calculate directory size synchronously.
 */
function getDirectorySize(dir: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          size += statSync(fullPath).size;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return size;
}
