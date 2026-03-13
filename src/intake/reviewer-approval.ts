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
import { parseIntakeTaskReference } from './task-reference.js';

export interface IntakeTaskApprovalResult {
  handled: boolean;
  transition?: IntakePipelineTransition;
  createdTaskId?: string;
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
