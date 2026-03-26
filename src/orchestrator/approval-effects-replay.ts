import type { IntakePipelineTransition } from '../intake/pipeline-glue.js';
import type { IntakeSource } from '../intake/types.js';

export interface IntakeApprovalReplayInput {
  kind: 'intake';
  source: IntakeSource;
  externalId: string;
  phase: 'triage' | 'reproduction';
  currentTaskTitle: string;
  transition: IntakePipelineTransition;
}

export interface ApprovalEffectsReplayInput {
  version: 1;
  intake?: IntakeApprovalReplayInput;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransition(value: unknown): value is IntakePipelineTransition {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.action === 'complete') {
    return (
      (value.phase === 'triage' || value.phase === 'reproduction') &&
      typeof value.summary === 'string' &&
      typeof value.resolutionCode === 'string' &&
      (value.comment === undefined || typeof value.comment === 'string')
    );
  }

  return (
    (value.action === 'advance' || value.action === 'retry') &&
    (value.phase === 'triage' || value.phase === 'reproduction') &&
    (value.nextPhase === 'reproduction' || value.nextPhase === 'fix') &&
    typeof value.summary === 'string' &&
    (value.comment === undefined || typeof value.comment === 'string') &&
    (value.nextTaskTitle === undefined || typeof value.nextTaskTitle === 'string')
  );
}

function isIntakeReplayInput(value: unknown): value is IntakeApprovalReplayInput {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    value.kind === 'intake' &&
    (value.source === 'github' || value.source === 'sentry') &&
    typeof value.externalId === 'string' &&
    (value.phase === 'triage' || value.phase === 'reproduction') &&
    typeof value.currentTaskTitle === 'string' &&
    isTransition(value.transition)
  );
}

export function createEmptyApprovalEffectsReplayInput(): ApprovalEffectsReplayInput {
  return { version: 1 };
}

export function parseApprovalEffectsReplayInput(value: unknown): ApprovalEffectsReplayInput {
  if (!isPlainObject(value)) {
    throw new Error('Approval effects replay input must be an object');
  }

  if (value.version !== 1) {
    throw new Error(`Unsupported approval effects replay input version: ${String(value.version)}`);
  }

  if (value.intake !== undefined && !isIntakeReplayInput(value.intake)) {
    throw new Error('Approval effects replay input contains invalid intake metadata');
  }

  const replayInput: ApprovalEffectsReplayInput = { version: 1 };
  if (value.intake) {
    replayInput.intake = value.intake;
  }
  return replayInput;
}
