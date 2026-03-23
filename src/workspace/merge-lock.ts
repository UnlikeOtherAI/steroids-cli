/**
 * Workspace merge lock — serializes merge-to-base operations.
 *
 * Lives in global.db alongside workspace_pool_slots so both can be
 * updated in the same transaction when needed.
 */

import type Database from 'better-sqlite3';

const STALE_LOCK_TTL_MS = 90_000; // 90s — merge queue uses heartbeats, so stale = missed ~3 heartbeat cycles

/**
 * Attempt to acquire the merge lock for a project.
 *
 * When `tryOnce` is true, makes a single attempt and returns immediately.
 * Otherwise polls every `pollMs` until `timeoutMs` elapses.
 * Reclaims stale locks older than 90 seconds.
 *
 * Returns true if the lock was acquired.
 */
export function acquireWorkspaceMergeLock(
  globalDb: Database.Database,
  projectId: string,
  runnerId: string,
  slotId: number,
  timeoutMs: number = 300_000,
  pollMs: number = 5_000,
  tryOnce: boolean = false
): boolean {
  const attemptAcquire = (): boolean => {
    return globalDb.transaction(() => {
      const existing = globalDb
        .prepare('SELECT * FROM workspace_merge_locks WHERE project_id = ?')
        .get(projectId) as {
        id: number;
        runner_id: string;
        heartbeat_at: number;
      } | undefined;

      if (existing) {
        const age = Date.now() - existing.heartbeat_at;
        if (age > STALE_LOCK_TTL_MS) {
          globalDb
            .prepare('DELETE FROM workspace_merge_locks WHERE id = ?')
            .run(existing.id);
        } else {
          return false;
        }
      }

      const now = Date.now();
      try {
        globalDb
          .prepare(
            `INSERT INTO workspace_merge_locks
             (project_id, runner_id, slot_id, acquired_at, heartbeat_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(projectId, runnerId, slotId, now, now);
        return true;
      } catch (error: any) {
        if (error.message?.includes('UNIQUE constraint')) {
          return false;
        }
        throw error;
      }
    }).immediate();
  };

  if (tryOnce) {
    return attemptAcquire();
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (attemptAcquire()) {
      return true;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const delay = Math.min(pollMs, remaining);
    const end = Date.now() + delay;
    while (Date.now() < end) {
      // busy-wait — acceptable for merge lock polling
    }
  }

  return false;
}

/**
 * Release the merge lock for a project.
 */
export function releaseWorkspaceMergeLock(
  globalDb: Database.Database,
  projectId: string
): void {
  globalDb
    .prepare('DELETE FROM workspace_merge_locks WHERE project_id = ?')
    .run(projectId);
}

/**
 * Refresh the merge lock heartbeat.
 * Called by the same 30s interval timer used for slot heartbeats.
 */
export function refreshWorkspaceMergeLockHeartbeat(
  globalDb: Database.Database,
  projectId: string,
  runnerId: string
): void {
  globalDb
    .prepare(
      `UPDATE workspace_merge_locks
       SET heartbeat_at = ?
       WHERE project_id = ? AND runner_id = ?`
    )
    .run(Date.now(), projectId, runnerId);
}
