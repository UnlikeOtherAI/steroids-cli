import type Database from 'better-sqlite3';
import type { Task } from '../database/queries.js';
import { addAuditEntry, getSubmissionCommitShas, updateTaskStatus } from '../database/queries.js';
import { readDurableSubmissionRef } from '../git/submission-durability.js';
import { resolveSubmissionCommitWithRecovery } from '../git/submission-resolution.js';
import { COMMIT_RECOVERY_MAX_ATTEMPTS } from '../commands/commit-recovery.js';
import { countCommitRecoveryAttempts } from '../commands/loop-phases-helpers.js';

interface LatestReviewRow {
  id: number;
  notes: string | null;
  commit_sha: string | null;
  metadata: string | null;
}

interface LatestReviewMetadata {
  durable_ref?: string;
  durable_ref_sha?: string;
}

export interface SubmissionContext {
  latestReviewAuditId: number | null;
  latestReviewNotes: string | null;
  latestReviewCommitSha: string | null;
  approvalCandidateShas: string[];
  latestExpectedSha: string | null;
  isNoOp: boolean;
  durableRefTrusted: boolean;
}

export type ApprovalSafetyResult =
  | { ok: true; approvalSha: string }
  | {
      ok: false;
      reason:
        | 'missing_latest_submission'
        | 'all_submissions_unreachable'
        | 'latest_missing_with_older_reachable';
      attempts: string[];
    };

function loadLatestReviewRow(
  db: Database.Database,
  taskId: string,
): LatestReviewRow | null {
  const row = db
    .prepare(
      `WITH latest_attempt AS (
         SELECT COALESCE(MAX(id), 0) AS boundary_id
         FROM audit
         WHERE task_id = ?
           AND from_status = 'pending'
           AND to_status = 'in_progress'
       )
       SELECT a.id, a.notes, a.commit_sha, a.metadata
       FROM audit a
       JOIN latest_attempt la
       WHERE a.task_id = ?
         AND a.to_status = 'review'
         AND a.id > la.boundary_id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 1`
    )
    .get(taskId, taskId) as LatestReviewRow | undefined;

  return row ?? null;
}

function parseLatestReviewMetadata(raw: string | null): LatestReviewMetadata | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as LatestReviewMetadata;
  } catch {
    return null;
  }
}

export function loadSubmissionContext(
  db: Database.Database,
  projectPath: string,
  taskId: string,
): SubmissionContext {
  const latestReviewRow = loadLatestReviewRow(db, taskId);
  const latestReviewMetadata = parseLatestReviewMetadata(latestReviewRow?.metadata ?? null);
  const submissionCandidates = getSubmissionCommitShas(db, taskId);
  const durableRefState = readDurableSubmissionRef(projectPath, taskId);
  const latestReviewCommitSha = latestReviewRow?.commit_sha ?? null;
  const durableRefTrusted =
    Boolean(latestReviewMetadata?.durable_ref) &&
    Boolean(durableRefState?.sha) &&
    Boolean(latestReviewCommitSha) &&
    durableRefState!.sha === latestReviewCommitSha &&
    (!latestReviewMetadata?.durable_ref_sha || latestReviewMetadata.durable_ref_sha === durableRefState!.sha);

  const approvalCandidateShas =
    durableRefTrusted && durableRefState?.sha
      ? [durableRefState.sha, ...submissionCandidates.filter((sha) => sha !== durableRefState.sha)]
      : submissionCandidates;
  const latestReviewNotes = latestReviewRow?.notes ?? null;

  return {
    latestReviewAuditId: latestReviewRow?.id ?? null,
    latestReviewNotes,
    latestReviewCommitSha,
    approvalCandidateShas,
    latestExpectedSha: approvalCandidateShas[0] ?? null,
    isNoOp: (latestReviewNotes ?? '').startsWith('[NO_OP_SUBMISSION]'),
    durableRefTrusted,
  };
}

export function resolveApprovalSafety(
  projectPath: string,
  submissionContext: SubmissionContext,
): ApprovalSafetyResult {
  const latestExpectedSha = submissionContext.latestExpectedSha;
  if (!latestExpectedSha) {
    return { ok: false, reason: 'missing_latest_submission', attempts: [] };
  }

  const resolution = resolveSubmissionCommitWithRecovery(
    projectPath,
    submissionContext.approvalCandidateShas,
  );
  if (resolution.status !== 'resolved') {
    return {
      ok: false,
      reason: 'all_submissions_unreachable',
      attempts: resolution.attempts,
    };
  }

  if (resolution.sha !== latestExpectedSha) {
    return {
      ok: false,
      reason: 'latest_missing_with_older_reachable',
      attempts: resolution.attempts,
    };
  }

  return { ok: true, approvalSha: resolution.sha };
}

export function handleUnsafeApprovalSubmission(
  db: Database.Database,
  task: Pick<Task, 'id' | 'status'>,
  failure: Extract<ApprovalSafetyResult, { ok: false }>,
  options: { jsonMode?: boolean } = {},
): { ok: false } {
  const recoveryAttempts = countCommitRecoveryAttempts(db, task.id) + 1;
  const attemptsText = failure.attempts.join(' | ') || 'none';

  if (recoveryAttempts >= COMMIT_RECOVERY_MAX_ATTEMPTS) {
    updateTaskStatus(
      db,
      task.id,
      'disputed',
      'orchestrator',
      `[commit_recovery] Escalating after ${recoveryAttempts} attempts (${failure.reason}; attempts: ${attemptsText}).`,
    );
    if (!options.jsonMode) {
      console.log('\n✗ Commit recovery cap reached; task escalated to disputed.');
    }
    return { ok: false };
  }

  updateTaskStatus(
    db,
    task.id,
    'in_progress',
    'orchestrator',
    `[commit_recovery] ${failure.reason} (attempts: ${attemptsText}). ` +
      'Treating task as resubmission. Coder must output exact line: SUBMISSION_COMMIT: <sha> for the commit that implements the task.',
  );
  if (!options.jsonMode) {
    console.log('\n⟳ Reviewer preflight blocked due to unhealthy submission chain; returning to coder.');
  }
  return { ok: false };
}

export function noteDurableRefMismatch(
  db: Database.Database,
  task: Pick<Task, 'id' | 'status'>,
  projectPath: string,
): void {
  const latestReviewRow = loadLatestReviewRow(db, task.id);
  const latestReviewMetadata = parseLatestReviewMetadata(latestReviewRow?.metadata ?? null);
  const latestReviewCommitSha = latestReviewRow?.commit_sha ?? null;
  const durableRefState = readDurableSubmissionRef(projectPath, task.id);

  if (
    !latestReviewMetadata?.durable_ref ||
    !durableRefState?.sha ||
    !latestReviewCommitSha ||
    (durableRefState.sha === latestReviewCommitSha &&
      (!latestReviewMetadata.durable_ref_sha || latestReviewMetadata.durable_ref_sha === durableRefState.sha))
  ) {
    return;
  }

  addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[integrity] Durable ref mismatch: ref=${durableRefState.sha}, latest_audit=${latestReviewCommitSha}. Falling back to submission history.`,
  });
}
