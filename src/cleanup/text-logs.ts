/**
 * Retention cleanup for date-based text logs.
 *
 * These are stored in directories at:
 *   .steroids/logs/YYYY-MM-DD/
 */

import { existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CleanupInvocationLogsResult } from './invocation-logs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENTLY_MODIFIED_MS = 60_000; // 60 seconds

export type CleanupTextLogsResult = CleanupInvocationLogsResult;

export interface CleanupTextLogsOptions {
  retentionDays?: number;
  dryRun?: boolean;
  nowMs?: number;
}

/**
 * Parse a YYYY-MM-DD directory name to a Date.
 * Returns null if the name doesn't match the expected format.
 */
function parseDateDir(name: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const d = new Date(year, month, day);
  // Round-trip check: reject non-calendar dates like 2024-13-40
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

/**
 * Delete old `.steroids/logs/YYYY-MM-DD/` directories based on date in name.
 *
 * Deletes entire date directories whose date is older than the retention window.
 * Skips files modified in the last 60 seconds (runner may be writing).
 * Tolerates ENOENT errors (files may disappear during cleanup).
 */
export function cleanupTextLogs(
  projectPath: string,
  options: CleanupTextLogsOptions = {},
): CleanupTextLogsResult {
  const retentionDays = options.retentionDays ?? 7;
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - retentionDays * DAY_MS;

  if (retentionDays <= 0) {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  const logsDir = join(projectPath, '.steroids', 'logs');
  if (!existsSync(logsDir)) {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  let scannedFiles = 0;
  let deletedFiles = 0;
  let freedBytes = 0;

  try {
    const dateDirs = readdirSync(logsDir, { withFileTypes: true });
    for (const dirEntry of dateDirs) {
      if (!dirEntry.isDirectory()) continue;
      const dirDate = parseDateDir(dirEntry.name);
      if (!dirDate) continue;

      // Check if entire directory is older than retention
      if (dirDate.getTime() >= cutoffMs) continue;

      const dirPath = join(logsDir, dirEntry.name);
      let files;
      try {
        files = readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue; // ENOENT — directory may have been removed
      }

      let allDeleted = true;
      for (const file of files) {
        if (!file.isFile()) { allDeleted = false; continue; }
        scannedFiles++;
        const filePath = join(dirPath, file.name);

        let st;
        try {
          st = statSync(filePath);
        } catch {
          continue; // ENOENT
        }

        // Skip recently modified files (runner may be writing)
        if (nowMs - st.mtimeMs < RECENTLY_MODIFIED_MS) {
          allDeleted = false;
          continue;
        }

        deletedFiles++;
        freedBytes += st.size;
        if (!options.dryRun) {
          try {
            unlinkSync(filePath);
          } catch {
            allDeleted = false; // deletion failed, don't remove parent
          }
        }
      }

      // Try to remove the empty date directory (best-effort)
      if (allDeleted && !options.dryRun) {
        try {
          rmdirSync(dirPath);
        } catch {
          // Directory not empty or already gone — tolerate
        }
      }
    }
  } catch {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  return { scannedFiles, deletedFiles, freedBytes, cutoffMs };
}
