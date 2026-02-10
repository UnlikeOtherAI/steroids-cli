/**
 * Retention cleanup for invocation activity logs.
 *
 * These are JSONL files created at:
 *   .steroids/invocations/<invocationId>.log
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupInvocationLogsOptions {
  /**
   * Keep logs within this retention window.
   * If <= 0, no files will be deleted.
   */
  retentionDays?: number;
  /** Preview without deleting files. */
  dryRun?: boolean;
  /** Inject current time for deterministic tests. */
  nowMs?: number;
}

export interface CleanupInvocationLogsResult {
  scannedFiles: number;
  deletedFiles: number;
  freedBytes: number;
  cutoffMs: number;
}

/**
 * Delete old `.steroids/invocations/*.log` files based on mtime.
 *
 * Best-effort: errors are swallowed and reflected as zero deletions.
 */
export function cleanupInvocationLogs(
  projectPath: string,
  options: CleanupInvocationLogsOptions = {}
): CleanupInvocationLogsResult {
  const retentionDays = options.retentionDays ?? 7;
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = retentionDays * DAY_MS;
  const cutoffMs = nowMs - retentionMs;

  if (retentionDays <= 0) {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  const logsDir = join(projectPath, '.steroids', 'invocations');
  if (!existsSync(logsDir)) {
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  let scannedFiles = 0;
  let deletedFiles = 0;
  let freedBytes = 0;

  try {
    const entries = readdirSync(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.log')) continue;

      scannedFiles++;
      const filePath = join(logsDir, entry.name);

      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }

      if (st.mtimeMs >= cutoffMs) continue;

      deletedFiles++;
      freedBytes += st.size;
      if (!options.dryRun) {
        try {
          unlinkSync(filePath);
        } catch {
          // If deletion fails, keep counts as best-effort; this is cleanup code.
        }
      }
    }
  } catch {
    // Directory read error; treat as no-op.
    return { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, cutoffMs };
  }

  return { scannedFiles, deletedFiles, freedBytes, cutoffMs };
}

