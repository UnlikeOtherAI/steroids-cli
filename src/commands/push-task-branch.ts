/**
 * Push the task branch to remote for durability.
 *
 * Called BEFORE submitForReviewWithDurableRef to ensure the task branch
 * exists on the remote before the reviewer phase starts. Does NOT set
 * approved_sha — that happens later when the reviewer approves.
 */

import { updateTaskStatus } from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { pushWithRetriesAsync } from '../workspace/git-helpers.js';

export async function pushTaskBranchForDurability(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  slotPath: string,
  taskBranch: string,
  jsonMode: boolean
): Promise<{ ok: boolean }> {
  const result = await pushWithRetriesAsync(slotPath, 'origin', taskBranch, 3, [1000, 4000, 16000], true);

  if (!result.success) {
    updateTaskStatus(
      db,
      taskId,
      'blocked_error',
      'orchestrator',
      `Task branch push failed: ${result.error ?? 'unknown error'}. Remote may be unreachable.`
    );
    if (!jsonMode) {
      console.warn(`\n✗ Task branch push failed: ${result.error ?? 'unknown error'}`);
    }
    return { ok: false };
  }

  return { ok: true };
}
