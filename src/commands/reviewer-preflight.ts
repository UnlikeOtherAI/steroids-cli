import {
  getTask,
  getSubmissionCommitShas,
  updateTaskStatus,
  addAuditEntry,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { resolveSubmissionCommitWithRecovery } from '../git/submission-resolution.js';
import { readDurableSubmissionRef } from '../git/submission-durability.js';
import { countCommitRecoveryAttempts } from './loop-phases-helpers.js';
import { COMMIT_RECOVERY_MAX_ATTEMPTS } from './commit-recovery.js';

export type ReviewerSubmissionPreflightResult =
  | { ok: true; submissionCommitSha: string }
  | { ok: false };

export function runReviewerSubmissionPreflight(
  db: ReturnType<typeof openDatabase>['db'],
  task: NonNullable<ReturnType<typeof getTask>>,
  effectiveProjectPath: string,
  jsonMode = false
): ReviewerSubmissionPreflightResult {
  const submissionCandidates = getSubmissionCommitShas(db, task.id);
  const latestSubmissionAudit = db
    .prepare(
      `SELECT commit_sha, metadata
       FROM audit
       WHERE task_id = ?
       AND to_status = 'review'
       AND commit_sha IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(task.id) as { commit_sha: string; metadata: string | null } | undefined;
  let latestSubmissionMetadata: { durable_ref?: string; durable_ref_sha?: string } | null = null;
  if (latestSubmissionAudit?.metadata) {
    try {
      latestSubmissionMetadata = JSON.parse(latestSubmissionAudit.metadata) as {
        durable_ref?: string;
        durable_ref_sha?: string;
      };
    } catch {
      latestSubmissionMetadata = null;
    }
  }
  const durableRefState = readDurableSubmissionRef(effectiveProjectPath, task.id);
  const latestAuditCommitSha = latestSubmissionAudit?.commit_sha ?? null;
  if (latestSubmissionMetadata?.durable_ref && durableRefState && latestAuditCommitSha) {
    const durableShaMatchesAudit = durableRefState.sha === latestAuditCommitSha;
    const durableShaMatchesMetadata =
      !latestSubmissionMetadata.durable_ref_sha ||
      latestSubmissionMetadata.durable_ref_sha === durableRefState.sha;
    if (durableShaMatchesAudit && durableShaMatchesMetadata) {
      const deduped = [durableRefState.sha, ...submissionCandidates.filter((sha) => sha !== durableRefState.sha)];
      submissionCandidates.splice(0, submissionCandidates.length, ...deduped);
    } else {
      addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
        actorType: 'orchestrator',
        notes: `[integrity] Durable ref mismatch: ref=${durableRefState.sha}, latest_audit=${latestAuditCommitSha}. Falling back to submission history.`,
      });
    }
  }

  const submissionResolution = resolveSubmissionCommitWithRecovery(
    effectiveProjectPath,
    submissionCandidates
  );
  const latestCandidate = submissionCandidates[0] ?? null;
  const allUnreachable = submissionResolution.status !== 'resolved';
  const latestMissingWithOlderReachable =
    submissionResolution.status === 'resolved' &&
    latestCandidate !== null &&
    submissionResolution.sha !== latestCandidate;

  if (allUnreachable || latestMissingWithOlderReachable) {
    const recoveryAttempts = countCommitRecoveryAttempts(db, task.id) + 1;
    const reasonTag = allUnreachable ? 'all_submissions_unreachable' : 'latest_missing_with_older_reachable';
    const attemptsText = submissionResolution.attempts.join(' | ') || 'none';

    if (recoveryAttempts >= COMMIT_RECOVERY_MAX_ATTEMPTS) {
      updateTaskStatus(
        db,
        task.id,
        'disputed',
        'orchestrator',
        `[commit_recovery] Escalating after ${recoveryAttempts} attempts (${reasonTag}; attempts: ${attemptsText}).`
      );
      if (!jsonMode) {
        console.log('\n✗ Commit recovery cap reached; task escalated to disputed.');
      }
      return { ok: false };
    }

    updateTaskStatus(
      db,
      task.id,
      'in_progress',
      'orchestrator',
      `[commit_recovery] ${reasonTag} (${submissionResolution.status === 'resolved' ? 'resolved_with_stale_latest' : submissionResolution.reason}; attempts: ${attemptsText}). ` +
      `Treating task as resubmission. Coder must output exact line: SUBMISSION_COMMIT: <sha> for the commit that implements the task.`
    );
    if (!jsonMode) {
      console.log('\n⟳ Reviewer preflight blocked due to unhealthy submission chain; returning to coder.');
    }
    return { ok: false };
  }

  return { ok: true, submissionCommitSha: submissionResolution.sha };
}
