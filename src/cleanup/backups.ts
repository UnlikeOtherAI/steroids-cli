/**
 * Retention cleanup for timestamped backups.
 *
 * These are stored in directories at:
 *   .steroids/backup/YYYY-MM-DDTHH-mm-ss/
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
 * Parse a backup directory name to a timestamp.
 * Format: 2024-01-15T10-30-00 or YYYY-MM-DD
 */
function parseBackupTimestamp(name: string): number | null {
  // Try ISO-like format: 2024-01-15T10-30-00
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (isoMatch) {
    const [_, y, m, d, hh, mm, ss] = isoMatch.map(Number);
    return new Date(y, m - 1, d, hh, mm, ss).getTime();
  }

  // Try date-only format: 2024-01-15
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (dateMatch) {
    const [_, y, m, d] = dateMatch.map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  return null;
}

/**
 * Delete old `.steroids/backup/` directories based on date in name.
 */
export function cleanupBackups(
  projectPath: string,
  options: CleanupBackupsOptions = {}
): CleanupBackupsResult {
  const retentionDays = options.retentionDays ?? 30; // Default 30 days for backups
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
      if (!entry.isDirectory()) continue;

      const backupTime = parseBackupTimestamp(entry.name);
      if (backupTime === null) continue;

      // Check if backup is older than retention
      if (backupTime >= cutoffMs) continue;

      const fullPath = join(backupDir, entry.name);
      
      // Calculate size before deleting
      const size = getDirectorySize(fullPath);
      
      scannedFiles++;
      deletedFiles++;
      freedBytes += size;

      if (!options.dryRun) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
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
