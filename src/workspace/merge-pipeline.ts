/**
 * Merge failure handling for the workspace pool lifecycle.
 * Encapsulates the logic for handling merge/push/rebase failures,
 * incrementing counters, and deciding whether to block or retry.
 */

import type Database from 'better-sqlite3';
import type { PoolSlotContext } from './types.js';
import type { MergeResult } from './git-lifecycle.js';
import {
  incrementTaskConflictCount,
  incrementMergeFailureCount,
  setTaskBlocked,
  returnTaskToPending,
} from '../database/queries.js';
import { releaseSlot } from './pool.js';

const MAX_CONFLICT_COUNT = 3;
const MAX_MERGE_FAILURE_COUNT = 3;

export interface MergeFailureResult {
  taskBlocked: boolean;
  blockStatus?: 'blocked_conflict' | 'blocked_error';
  reason: string;
}

/**
 * Handle a merge pipeline failure: increment counters, check caps,
 * release slot, return task to pending or block.
 */
export function handleMergeFailure(
  projectDb: Database.Database,
  ctx: PoolSlotContext,
  taskId: string,
  mergeResult: MergeResult & { ok: false }
): MergeFailureResult {
  // Release the pool slot back to idle
  releaseSlot(ctx.globalDb, ctx.slot.id);

  // Infrastructure failure (e.g. missing remote base branch) — block immediately
  if (mergeResult.infrastructure) {
    setTaskBlocked(
      projectDb,
      taskId,
      'blocked_error',
      `Infrastructure failure: ${mergeResult.reason}`
    );
    return {
      taskBlocked: true,
      blockStatus: 'blocked_error',
      reason: `Blocked: ${mergeResult.reason}`,
    };
  }

  if (mergeResult.conflict) {
    // Rebase conflict path
    const conflictCount = incrementTaskConflictCount(projectDb, taskId);

    if (conflictCount >= MAX_CONFLICT_COUNT) {
      setTaskBlocked(
        projectDb,
        taskId,
        'blocked_conflict',
        `Rebase conflict on ${conflictCount} consecutive attempts: ${mergeResult.reason}`
      );
      return {
        taskBlocked: true,
        blockStatus: 'blocked_conflict',
        reason: `Blocked after ${conflictCount} rebase conflicts`,
      };
    }

    // Return to pending for full retry
    returnTaskToPending(
      projectDb,
      taskId,
      'orchestrator',
      `Rebase conflict (attempt ${conflictCount}/${MAX_CONFLICT_COUNT}): ${mergeResult.reason}`
    );
    return {
      taskBlocked: false,
      reason: `Rebase conflict (attempt ${conflictCount}/${MAX_CONFLICT_COUNT})`,
    };
  }

  // General merge failure (push failure, ff-only failure, etc.)
  const mergeFailureCount = incrementMergeFailureCount(projectDb, taskId);

  if (mergeFailureCount >= MAX_MERGE_FAILURE_COUNT) {
    setTaskBlocked(
      projectDb,
      taskId,
      'blocked_error',
      `Merge pipeline failed ${mergeFailureCount} times: ${mergeResult.reason}`
    );
    return {
      taskBlocked: true,
      blockStatus: 'blocked_error',
      reason: `Blocked after ${mergeFailureCount} merge failures`,
    };
  }

  // Return to pending for full retry
  returnTaskToPending(
    projectDb,
    taskId,
    'orchestrator',
    `Merge failure (attempt ${mergeFailureCount}/${MAX_MERGE_FAILURE_COUNT}): ${mergeResult.reason}`
  );
  return {
    taskBlocked: false,
    reason: `Merge failure (attempt ${mergeFailureCount}/${MAX_MERGE_FAILURE_COUNT})`,
  };
}
