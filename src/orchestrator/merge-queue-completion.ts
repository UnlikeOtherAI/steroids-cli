import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import type { Task } from '../database/queries.js';
import { addAuditEntry } from '../database/queries.js';
import {
  buildApprovalEffectsReplayInput,
  completeTaskWithApprovalEffects,
  loadQueuedApprovalEffectsReplayInput,
} from './automated-approval-effects.js';
import { createEmptyApprovalEffectsReplayInput } from './approval-effects-replay.js';

export interface MergeQueueCompletionOptions {
  config: SteroidsConfig;
  projectPath: string;
  intakeProjectPath?: string;
  mergedSha?: string;
  notes: string;
}

export async function completeMergePendingTask(
  db: Database.Database,
  task: Pick<Task, 'id' | 'title' | 'source_file' | 'section_id'>,
  options: MergeQueueCompletionOptions,
): Promise<void> {
  let replayInput = loadQueuedApprovalEffectsReplayInput(db, task.id);
  if (!replayInput) {
    try {
      replayInput = buildApprovalEffectsReplayInput(task, options.intakeProjectPath ?? options.projectPath);
    } catch (error) {
      replayInput = createEmptyApprovalEffectsReplayInput();
      addAuditEntry(db, task.id, 'merge_pending', 'merge_pending', 'orchestrator', {
        actorType: 'orchestrator',
        category: 'approval_effects_migration_anomaly',
        notes:
          '[approval_effects] Missing queued replay input at merge completion; continuing without intake replay: ' +
          (error instanceof Error ? error.message : String(error)),
      });
    }
  }

  await completeTaskWithApprovalEffects(db, task, {
    actor: 'orchestrator',
    notes: options.notes,
    commitSha: options.mergedSha,
    config: options.config,
    projectPath: options.projectPath,
    intakeProjectPath: options.intakeProjectPath,
    replayInput,
  });
}
