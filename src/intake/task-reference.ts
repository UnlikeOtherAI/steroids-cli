import type { Task } from '../database/queries.js';
import { DEFAULT_INTAKE_PIPELINE_SOURCE_FILE, type IntakeTaskPhase } from './task-templates.js';
import type { IntakeSource } from './types.js';

export interface IntakeTaskReference {
  phase: IntakeTaskPhase;
  source: IntakeSource;
  externalId: string;
}

const INTAKE_TASK_TITLE_PATTERN =
  /^(Triage|Reproduce|Fix) intake report (github|sentry)#([^:]+): /;

export function parseIntakeTaskReference(task: Pick<Task, 'title' | 'source_file'>): IntakeTaskReference | null {
  if (task.source_file !== DEFAULT_INTAKE_PIPELINE_SOURCE_FILE) {
    return null;
  }

  const match = task.title.match(INTAKE_TASK_TITLE_PATTERN);
  if (!match) {
    return null;
  }

  const phase = match[1] === 'Triage'
    ? 'triage'
    : (match[1] === 'Reproduce' ? 'reproduction' : 'fix');

  return {
    phase,
    source: match[2] as IntakeSource,
    externalId: match[3],
  };
}
