import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import { addAuditEntry, getTask, type Task } from '../database/queries.js';
import {
  buildApprovalEffectsReplayInput,
  completeTaskWithApprovalEffects,
} from './automated-approval-effects.js';
import type { ApprovalEffectsReplayInput } from './approval-effects-replay.js';
import type { ApprovalSafetyResult, SubmissionContext } from './submission-context.js';

export type ApprovedOutcome =
  | { kind: 'complete'; commitSha: string }
  | { kind: 'queue_merge'; approvedSha: string };

export function deriveApprovedOutcome(
  submissionContext: SubmissionContext,
  approvalSafety: Extract<ApprovalSafetyResult, { ok: true }>,
): ApprovedOutcome {
  if (submissionContext.isNoOp) {
    return { kind: 'complete', commitSha: approvalSafety.approvalSha };
  }

  return { kind: 'queue_merge', approvedSha: approvalSafety.approvalSha };
}

export async function applyApprovedOutcome(
  db: Database.Database,
  task: Pick<Task, 'id' | 'title' | 'source_file' | 'section_id'>,
  outcome: ApprovedOutcome,
  options: {
    actor: string;
    notes: string;
    config: SteroidsConfig;
    projectPath: string;
    intakeProjectPath?: string;
    hooksEnabled?: boolean;
    verbose?: boolean;
    replayInput?: ApprovalEffectsReplayInput;
  },
): Promise<void> {
  if (outcome.kind === 'complete') {
    await completeTaskWithApprovalEffects(db, task, {
      actor: options.actor,
      notes: options.notes,
      commitSha: outcome.commitSha,
      config: options.config,
      projectPath: options.projectPath,
      intakeProjectPath: options.intakeProjectPath,
      hooksEnabled: options.hooksEnabled,
      verbose: options.verbose,
      replayInput: options.replayInput,
    });
    return;
  }

  const currentTask = getTask(db, task.id);
  if (!currentTask) {
    throw new Error(`Task not found: ${task.id}`);
  }

  const replayInput =
    options.replayInput ??
    buildApprovalEffectsReplayInput(task, options.intakeProjectPath ?? options.projectPath);

  db.transaction(() => {
    db.prepare(
      `UPDATE tasks
       SET status = 'merge_pending',
           merge_phase = 'queued',
           approved_sha = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(outcome.approvedSha, task.id);

    addAuditEntry(db, task.id, currentTask.status, 'merge_pending', options.actor, {
      actorType: 'orchestrator',
      notes: options.notes,
      commitSha: outcome.approvedSha,
      metadata: {
        approved_sha: outcome.approvedSha,
        approval_effects_replay: replayInput,
      },
    });
  })();
}
