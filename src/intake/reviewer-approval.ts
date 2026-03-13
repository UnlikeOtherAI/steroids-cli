import type Database from 'better-sqlite3';
import type { Task } from '../database/queries.js';
import {
  createSection,
  createTask,
  getSectionByName,
} from '../database/queries.js';
import { getIntakeReport, updateIntakeReportState } from '../database/intake-queries.js';
import type { StoredIntakeReport } from '../database/intake-queries.js';
import {
  deriveIntakePipelineTransition,
  parseIntakeResultFile,
  type IntakePipelineTransition,
} from './pipeline-glue.js';
import {
  buildIntakeTaskTemplate,
  getIntakeTaskSectionName,
  type IntakeTaskPhase,
} from './task-templates.js';
import { DEFAULT_INTAKE_PIPELINE_SOURCE_FILE } from './task-templates.js';
import type { IntakeSource } from './types.js';

interface IntakeTaskReference {
  phase: IntakeTaskPhase;
  source: IntakeSource;
  externalId: string;
}

export interface IntakeTaskApprovalResult {
  handled: boolean;
  transition?: IntakePipelineTransition;
  createdTaskId?: string;
}

const INTAKE_TASK_TITLE_PATTERN =
  /^(Triage|Reproduce|Fix) intake report (github|sentry)#([^:]+): /;

function parseIntakeTaskReference(task: Pick<Task, 'title' | 'source_file'>): IntakeTaskReference | null {
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

function getOrCreateSectionId(db: Database.Database, sectionName: string): string {
  const existing = getSectionByName(db, sectionName);
  if (existing) {
    return existing.id;
  }

  return createSection(db, sectionName).id;
}

function createNextIntakeTask(
  db: Database.Database,
  nextPhase: Exclude<IntakeTaskPhase, 'triage'>,
  report: StoredIntakeReport,
  nextTaskTitle?: string
): string {
  const template = buildIntakeTaskTemplate(nextPhase, report);
  const sectionId = getOrCreateSectionId(db, getIntakeTaskSectionName(nextPhase));
  const nextTask = createTask(db, nextTaskTitle ?? template.title, {
    sectionId,
    sourceFile: template.sourceFile,
  });

  return nextTask.id;
}

export function handleIntakeTaskApproval(
  db: Database.Database,
  task: Pick<Task, 'id' | 'title' | 'source_file'>,
  projectPath: string
): IntakeTaskApprovalResult {
  const reference = parseIntakeTaskReference(task);
  if (!reference || reference.phase !== 'triage') {
    return { handled: false };
  }

  const report = getIntakeReport(db, reference.source, reference.externalId);
  if (!report) {
    throw new Error(`Intake pipeline task refers to missing report ${reference.source}#${reference.externalId}`);
  }

  const transition = deriveIntakePipelineTransition(parseIntakeResultFile(projectPath));
  if (transition.action === 'complete') {
    updateIntakeReportState(db, report.source, report.externalId, {
      status: transition.resolutionCode === 'fixed' ? 'resolved' : 'ignored',
      resolvedAt: new Date().toISOString(),
      linkedTaskId: task.id,
    });

    return { handled: true, transition };
  }

  const createdTaskId = createNextIntakeTask(db, transition.nextPhase, report, transition.nextTaskTitle);
  updateIntakeReportState(db, report.source, report.externalId, {
    status: 'in_progress',
    resolvedAt: null,
    linkedTaskId: createdTaskId,
  });

  return { handled: true, transition, createdTaskId };
}
