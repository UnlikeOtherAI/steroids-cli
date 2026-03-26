/**
 * Orphaned invocation recovery helpers for wakeup sanitisation.
 * Extracted from wakeup-sanitise.ts to stay under file size limits.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { openDatabase } from '../database/connection.js';
import { loadConfig } from '../config/loader.js';
import { updateTaskStatus, type Task } from '../database/queries.js';
import type { openGlobalDatabase } from './global-db.js';
import { parseReviewerDecisionSignal } from '../orchestrator/reviewer-decision-parser.js';
import type { SanitiseSummary } from './wakeup-sanitise.js';
import {
  applyApprovedOutcome,
  deriveApprovedOutcome,
} from '../orchestrator/reviewer-approval-outcome.js';
import {
  handleUnsafeApprovalSubmission,
  loadSubmissionContext,
  resolveApprovalSafety,
} from '../orchestrator/submission-context.js';

export interface StaleInvocationRow {
  id: number;
  task_id: string;
  role: string;
  started_at_ms: number;
  runner_id: string | null;
  task_status: string | null;
}

export function parseReviewerDecisionFromInvocationLogContent(
  raw: string
): 'approve' | 'reject' | null {
  const stdoutMessages: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        stream?: string;
        msg?: unknown;
      };
      if (parsed.type === 'output' && parsed.stream === 'stdout' && typeof parsed.msg === 'string') {
        stdoutMessages.push(parsed.msg);
      }
    } catch {
      // Legacy/non-JSON logs handled by fallback below.
    }
  }

  const parseCandidates = stdoutMessages.length > 0 ? [stdoutMessages.join('\n'), raw] : [raw];

  for (const candidate of parseCandidates) {
    const decision = parseReviewerDecisionSignal(candidate).decision;
    if (decision === 'approve') return 'approve';
    if (decision === 'reject') return 'reject';
  }
  return null;
}

export function parseReviewerDecisionFromLog(
  projectPath: string,
  invocationId: number
): 'approve' | 'reject' | null {
  const logPath = join(projectPath, '.steroids', 'invocations', `${invocationId}.log`);
  if (!existsSync(logPath)) return null;

  try {
    const raw = readFileSync(logPath, 'utf-8');
    return parseReviewerDecisionFromInvocationLogContent(raw);
  } catch {
    return null;
  }
}

export function shouldSkipInvocation(
  row: StaleInvocationRow,
  activeTaskIds: Set<string>,
  hasActiveMergeLock: boolean,
  hasActiveParallelRunner: boolean,
  globalDb: ReturnType<typeof openGlobalDatabase>['db']
): boolean {
  if (activeTaskIds.has(row.task_id)) return true;
  // Merge lock only blocks merge-role recovery; rebase roles don't hold the lock
  if (hasActiveMergeLock && row.role !== 'rebase_coder' && row.role !== 'rebase_reviewer') return true;
  if (hasActiveParallelRunner && row.runner_id) {
    const runnerRow = globalDb
      .prepare('SELECT pid FROM runners WHERE id = ?')
      .get(row.runner_id) as { pid: number | null } | undefined;
    if (runnerRow) {
      if (runnerRow.pid !== null) {
        try {
          process.kill(runnerRow.pid, 0);
          return true;
        } catch {
          return false;
        }
      }
      return true;
    }
  }
  return false;
}

export function isRunnerProcessDead(
  runnerId: string | null,
  globalDb: ReturnType<typeof openGlobalDatabase>['db']
): boolean {
  // No runner_id means no owner to verify — can't confirm dead (protects manual `steroids loop` runs
  // that don't register in the runners table). Pass 1 (30-min timeout) handles these.
  if (!runnerId) return false;
  const runnerRow = globalDb
    .prepare('SELECT pid FROM runners WHERE id = ?')
    .get(runnerId) as { pid: number | null } | undefined;
  if (!runnerRow) return true;
  if (runnerRow.pid === null) return false;
  try {
    process.kill(runnerRow.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function recoverOrphanedInvocation(
  projectDb: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  row: StaleInvocationRow,
  dryRun: boolean,
  summary: SanitiseSummary,
  source: string
): Promise<void> {
  const completedAtMs = Date.now();
  const durationMs = Math.max(0, completedAtMs - row.started_at_ms);
  const reviewerDecision =
    row.role === 'reviewer' ? parseReviewerDecisionFromLog(projectPath, row.id) : null;

  if (!dryRun) {
    if (reviewerDecision === 'approve' && row.task_status === 'review') {
      projectDb
        .prepare(
          `UPDATE task_invocations
           SET status = 'completed', success = 1, timed_out = 0, exit_code = 0,
               completed_at_ms = ?, duration_ms = ?,
               error = COALESCE(error, ?)
           WHERE id = ? AND status = 'running'`
        )
        .run(completedAtMs, durationMs, `Recovered by sanitise [${source}] (review approve token found).`, row.id);

      const task = projectDb
        .prepare('SELECT id, title, status, source_file, section_id FROM tasks WHERE id = ?')
        .get(row.task_id) as Pick<Task, 'id' | 'title' | 'status' | 'source_file' | 'section_id'> | undefined;

      if (task) {
        const submissionContext = loadSubmissionContext(projectDb, projectPath, row.task_id);
        const approvalSafety = resolveApprovalSafety(projectPath, submissionContext);

        if (!approvalSafety.ok) {
          handleUnsafeApprovalSubmission(projectDb, task, approvalSafety);
        } else {
          const outcome = deriveApprovedOutcome(submissionContext, approvalSafety);
          await applyApprovedOutcome(projectDb, task, outcome, {
            actor: 'orchestrator',
            notes:
              outcome.kind === 'complete'
                ? `Recovered by sanitise [${source}] (DECISION: APPROVE, no-op submission).`
                : `Recovered by sanitise [${source}] (DECISION: APPROVE → merge_pending).`,
            config: loadConfig(projectPath),
            projectPath,
            intakeProjectPath: projectPath,
          });
        }
      }
    } else if (reviewerDecision === 'reject' && row.task_status === 'review') {
      projectDb
        .prepare(
          `UPDATE task_invocations
           SET status = 'completed', success = 1, timed_out = 0, exit_code = 0,
               completed_at_ms = ?, duration_ms = ?,
               error = COALESCE(error, ?)
           WHERE id = ? AND status = 'running'`
        )
        .run(completedAtMs, durationMs, `Recovered by sanitise [${source}] (review reject token found).`, row.id);

      const rejectResult = projectDb
        .prepare(
          `UPDATE tasks
           SET status = 'in_progress', rejection_count = COALESCE(rejection_count, 0) + 1,
               updated_at = datetime('now')
           WHERE id = ? AND status = 'review'`
        )
        .run(row.task_id);

      if (rejectResult.changes > 0) {
        projectDb
          .prepare(
            `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
             SELECT ?, 'review', 'in_progress', 'orchestrator', 'orchestrator', ?, datetime('now')
             WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'in_progress')`
          )
          .run(row.task_id, `Recovered by sanitise [${source}] (DECISION: REJECT).`, row.task_id);
        projectDb
          .prepare('DELETE FROM task_locks WHERE task_id = ?')
          .run(row.task_id);
      }
    } else {
      projectDb
        .prepare(
          `UPDATE task_invocations
           SET status = 'failed', success = 0, timed_out = 1, exit_code = 1,
               completed_at_ms = ?, duration_ms = ?,
               error = COALESCE(error, ?)
           WHERE id = ? AND status = 'running'`
        )
        .run(completedAtMs, durationMs, `Sanitise [${source}] closed orphaned running invocation.`, row.id);

      const resetResult = projectDb
        .prepare(
          `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
           WHERE id = ? AND status = 'in_progress'`
        )
        .run(row.task_id);
      if (resetResult.changes > 0) {
        projectDb
          .prepare('DELETE FROM task_locks WHERE task_id = ?')
          .run(row.task_id);
      }

      // Merge/rebase role recovery: reset merge_pending tasks with orphaned invocations
      if (row.task_status === 'merge_pending') {
        if (row.role === 'merge' || row.role === 'rebase_coder') {
          // Re-queue for merge attempt (will re-discover conflicts if needed)
          projectDb
            .prepare(
              `UPDATE tasks SET merge_phase = 'queued', updated_at = datetime('now')
               WHERE id = ? AND status = 'merge_pending'`
            )
            .run(row.task_id);
        } else if (row.role === 'rebase_reviewer') {
          // Parse rebase reviewer decision from log if available
          const rebaseDecision = parseReviewerDecisionFromLog(projectPath, row.id);
          if (rebaseDecision === 'approve') {
            // Approved — re-queue with merge_phase = 'queued'
            projectDb
              .prepare(
                `UPDATE tasks SET merge_phase = 'queued', updated_at = datetime('now')
                 WHERE id = ? AND status = 'merge_pending'`
              )
              .run(row.task_id);
          } else {
            // Rejected or unknown — increment rebase_attempts, re-enter rebasing
            projectDb
              .prepare(
                `UPDATE tasks SET merge_phase = 'rebasing', rebase_attempts = COALESCE(rebase_attempts, 0) + 1, updated_at = datetime('now')
                 WHERE id = ? AND status = 'merge_pending'`
              )
              .run(row.task_id);
          }
        }
      }
    }
  }

  if (reviewerDecision === 'approve' && row.task_status === 'review') {
    summary.recoveredApprovals += 1;
  } else if (reviewerDecision === 'reject' && row.task_status === 'review') {
    summary.recoveredRejects += 1;
  } else {
    summary.closedStaleInvocations += 1;
  }
}
