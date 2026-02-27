/**
 * Workspace pool reconciliation — reclaim stale slots and locks.
 *
 * Called during runner wakeup to reset state after crashes.
 * Policy: Stale = reset. No state-dependent recovery.
 */

import type Database from 'better-sqlite3';
import type { PoolSlot } from './types.js';

const STALE_SLOT_TTL_MS = 10 * 60 * 1000; // 10 minutes — must exceed clone timeout (5min) + event loop block
const STALE_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes — must exceed worst-case push retry (3×120s = 360s)

export interface ReconcileResult {
  resetSlots: number;
  deletedLocks: number;
  taskIds: string[];  // task_ids from reset slots, to return to pending
}

/**
 * Find and reset stale workspace pool slots and merge locks.
 *
 * Step 1: Slots with heartbeat_at < now - 5min AND status != 'idle' → reset to idle
 * Step 2: Merge locks with heartbeat_at < now - 3min → delete
 */
export function reconcileStaleWorkspaces(globalDb: Database.Database): ReconcileResult {
  const now = Date.now();
  const slotCutoff = now - STALE_SLOT_TTL_MS;
  const lockCutoff = now - STALE_LOCK_TTL_MS;

  // Step 1: Find stale slots
  const staleSlots = globalDb
    .prepare(
      `SELECT id, task_id FROM workspace_pool_slots
       WHERE heartbeat_at < ? AND status != 'idle'`
    )
    .all(slotCutoff) as Array<Pick<PoolSlot, 'id' | 'task_id'>>;

  const taskIds: string[] = [];

  for (const slot of staleSlots) {
    globalDb
      .prepare(
        `UPDATE workspace_pool_slots
         SET status = 'idle', runner_id = NULL, task_id = NULL,
             task_branch = NULL, starting_sha = NULL,
             claimed_at = NULL, heartbeat_at = NULL
         WHERE id = ?`
      )
      .run(slot.id);

    if (slot.task_id) {
      taskIds.push(slot.task_id);
    }
  }

  // Step 2: Delete stale merge locks
  const lockResult = globalDb
    .prepare('DELETE FROM workspace_merge_locks WHERE heartbeat_at < ?')
    .run(lockCutoff);

  return {
    resetSlots: staleSlots.length,
    deletedLocks: lockResult.changes,
    taskIds,
  };
}
