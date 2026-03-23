import { getTask, getSubmissionCommitShas, updateTaskStatus } from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { resolveSubmissionCommitHistoryWithRecovery } from '../git/submission-resolution.js';
import type { PoolSlotContext } from '../workspace/types.js';
import type { LeaseFenceContext } from './loop-phases-helpers.js';
import { refreshParallelWorkstreamLease, countCommitRecoveryAttempts } from './loop-phases-helpers.js';
import { submitForReviewWithDurableRef } from './submission-transition.js';
import { pushTaskBranchForDurability } from './push-task-branch.js';
import { COMMIT_RECOVERY_MAX_ATTEMPTS } from './commit-recovery.js';
import { updateSlotStatus } from '../workspace/pool.js';

export async function handleNoOpSubmissionInPool(
  db: ReturnType<typeof openDatabase>['db'],
  task: NonNullable<ReturnType<typeof getTask>>,
  projectPath: string,
  effectiveProjectPath: string,
  poolStartingSha: string,
  poolSlotContext: PoolSlotContext,
  leaseFence: LeaseFenceContext | undefined,
  jsonMode: boolean
): Promise<{ handled: boolean }> {
  const submissionHistory = resolveSubmissionCommitHistoryWithRecovery(
    effectiveProjectPath,
    getSubmissionCommitShas(db, task.id)
  );
  const hasUnresolvedHistory =
    submissionHistory.unreachableShas.length > 0 &&
    submissionHistory.reachableShasOldestFirst.length > 0;

  if (hasUnresolvedHistory) {
    const recoveryAttempts = countCommitRecoveryAttempts(db, task.id) + 1;
    if (recoveryAttempts >= COMMIT_RECOVERY_MAX_ATTEMPTS) {
      updateTaskStatus(
        db,
        task.id,
        'disputed',
        'orchestrator',
        `[commit_recovery] Unresolved submission history persisted through ${recoveryAttempts} no-op retries; escalating to disputed.`
      );
      if (!jsonMode) {
        console.log('\n✗ No-op unresolved-history retries exceeded cap; escalated to disputed.');
      }
      return { handled: true };
    }

    updateTaskStatus(
      db,
      task.id,
      'in_progress',
      'orchestrator',
      '[commit_recovery] No-op submission blocked: unresolved historical submission commits detected; coder must provide explicit SUBMISSION_COMMIT.'
    );
    if (!jsonMode) {
      console.log('\n⟳ No-op blocked due to unresolved submission history; requiring explicit SUBMISSION_COMMIT.');
    }
    return { handled: true };
  }

  if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
    if (!jsonMode) {
      console.log('\n↺ Lease lost before no-op forward; skipping.');
    }
    return { handled: true };
  }
  // Push task branch for durability before submitting for review
  if (poolSlotContext.slot.task_branch) {
    const pushOk = await pushTaskBranchForDurability(db, task.id, effectiveProjectPath, poolSlotContext.slot.task_branch, jsonMode);
    if (!pushOk.ok) return { handled: true };
  }
  updateSlotStatus(poolSlotContext.globalDb, poolSlotContext.slot.id, 'awaiting_review');
  const submitted = submitForReviewWithDurableRef(
    db,
    task.id,
    'orchestrator',
    effectiveProjectPath,
    poolStartingSha,
    '[NO_OP_SUBMISSION] No new commits in pool workspace — reviewer to verify pre-existing work'
  );
  if (!submitted.ok) {
    updateTaskStatus(
      db,
      task.id,
      'failed',
      'orchestrator',
      `Task failed: durable submission write failed (${submitted.error})`
    );
    if (!jsonMode) {
      console.log('\n✗ No-op forward failed (durable submission write failed).');
    }
    return { handled: true };
  }

  if (!jsonMode) {
    console.log('\n→ No changes detected, forwarding to reviewer.');
  }
  return { handled: true };
}
