import {
  getTask,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import {
  handleUnsafeApprovalSubmission,
  loadSubmissionContext,
  noteDurableRefMismatch,
  resolveApprovalSafety,
} from '../orchestrator/submission-context.js';

export type ReviewerSubmissionPreflightResult =
  | { ok: true; submissionCommitSha: string }
  | { ok: false };

export function runReviewerSubmissionPreflight(
  db: ReturnType<typeof openDatabase>['db'],
  task: NonNullable<ReturnType<typeof getTask>>,
  effectiveProjectPath: string,
  jsonMode = false
): ReviewerSubmissionPreflightResult {
  const submissionContext = loadSubmissionContext(db, effectiveProjectPath, task.id);
  if (!submissionContext.durableRefTrusted) {
    noteDurableRefMismatch(db, task, effectiveProjectPath);
  }
  const approvalSafety = resolveApprovalSafety(effectiveProjectPath, submissionContext);

  if (!approvalSafety.ok) {
    return handleUnsafeApprovalSubmission(db, task, approvalSafety, { jsonMode });
  }

  return { ok: true, submissionCommitSha: approvalSafety.approvalSha };
}
