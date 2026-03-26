import type Database from 'better-sqlite3';
import type { Task } from '../database/queries.js';
import {
  createSection,
  createTask,
  getTask,
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
import type { IntakeApprovalReplayInput } from '../orchestrator/approval-effects-replay.js';

export interface IntakeTaskApprovalResult {
  handled: boolean;
  transition?: IntakePipelineTransition;
  createdTaskId?: string;
}

type IntakeApprovalTask = Pick<Task, 'id' | 'title' | 'source_file'>;

function getOrCreateSectionId(db: Database.Database, sectionName: string): string {
  const existing = getSectionByName(db, sectionName);
  if (existing) {
    return existing.id;
  }

  return createSection(db, sectionName).id;
}

function parseRetryAttemptFromTitle(title: string): number {
  const match = title.match(/\(retry (\d+)\)$/);
  if (!match) {
    return 1;
  }

  const retryAttempt = Number.parseInt(match[1], 10);
  return Number.isInteger(retryAttempt) && retryAttempt >= 2 ? retryAttempt : 1;
}

function createNextIntakeTask(
  db: Database.Database,
  nextPhase: Exclude<IntakeTaskPhase, 'triage'>,
  report: StoredIntakeReport,
  options: {
    currentTaskTitle?: string;
    nextTaskTitle?: string;
    retry?: boolean;
  } = {}
): string {
  const retryAttempt = options.retry
    ? parseRetryAttemptFromTitle(options.currentTaskTitle ?? '') + 1
    : undefined;
  const template = buildIntakeTaskTemplate(nextPhase, report, { retryAttempt });
  const sectionId = getOrCreateSectionId(db, getIntakeTaskSectionName(nextPhase));
  const nextTask = createTask(db, options.nextTaskTitle ?? template.title, {
    sectionId,
    sourceFile: template.sourceFile,
  });

  return nextTask.id;
}

function findExistingNextTaskId(
  db: Database.Database,
  nextTaskTitle: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id
       FROM tasks
       WHERE title = ?
         AND source_file = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(nextTaskTitle, DEFAULT_INTAKE_PIPELINE_SOURCE_FILE) as { id: string } | undefined;

  return row?.id ?? null;
}

function resolveLinkedNextTaskId(
  db: Database.Database,
  linkedTaskId: string | null,
  nextPhase: Exclude<IntakeTaskPhase, 'triage'>,
  nextTaskTitle: string,
  source: string,
  externalId: string,
): string | null {
  if (!linkedTaskId) {
    return null;
  }

  const linkedTask = getTask(db, linkedTaskId);
  if (!linkedTask) {
    return null;
  }

  const reference = parseIntakeTaskReference(linkedTask);
  if (
    linkedTask.title === nextTaskTitle &&
    reference?.phase === nextPhase &&
    reference.source === source &&
    reference.externalId === externalId
  ) {
    return linkedTaskId;
  }

  return null;
}

function resolveReplayInput(
  task: IntakeApprovalTask,
  source: string | IntakeApprovalReplayInput,
): IntakeApprovalReplayInput | null {
  if (typeof source !== 'string') {
    return source;
  }

  return buildIntakeApprovalReplayInput(task, source);
}

export function buildIntakeApprovalReplayInput(
  task: IntakeApprovalTask,
  projectPath: string
): IntakeApprovalReplayInput | null {
  const reference = parseIntakeTaskReference(task);
  if (!reference || reference.phase === 'fix') {
    return null;
  }

  const result = parseIntakeResultFile(projectPath);
  if (result.phase !== reference.phase) {
    throw new Error(
      `Intake result phase "${result.phase}" does not match approved task phase "${reference.phase}" for ${reference.source}#${reference.externalId}`
    );
  }

  return {
    kind: 'intake',
    source: reference.source,
    externalId: reference.externalId,
    phase: reference.phase,
    currentTaskTitle: task.title,
    transition: deriveIntakePipelineTransition(result),
  };
}

export function handleIntakeTaskApproval(
  db: Database.Database,
  task: IntakeApprovalTask,
  projectPathOrReplayInput: string | IntakeApprovalReplayInput
): IntakeTaskApprovalResult {
  const replayInput = resolveReplayInput(task, projectPathOrReplayInput);
  if (!replayInput) {
    return { handled: false };
  }

  const report = getIntakeReport(db, replayInput.source, replayInput.externalId);
  if (!report) {
    throw new Error(`Intake pipeline task refers to missing report ${replayInput.source}#${replayInput.externalId}`);
  }

  if (replayInput.transition.action === 'complete') {
    const targetStatus = replayInput.transition.resolutionCode === 'fixed' ? 'resolved' : 'ignored';
    if (report.status === targetStatus) {
      return { handled: true, transition: replayInput.transition };
    }

    updateIntakeReportState(db, report.source, report.externalId, {
      status: targetStatus,
      resolvedAt: new Date().toISOString(),
      linkedTaskId: task.id,
    });

    return { handled: true, transition: replayInput.transition };
  }

  const nextTaskTitle =
    replayInput.transition.nextTaskTitle ??
    buildIntakeTaskTemplate(replayInput.transition.nextPhase, report, {
      retryAttempt:
        replayInput.transition.action === 'retry'
          ? parseRetryAttemptFromTitle(replayInput.currentTaskTitle) + 1
          : undefined,
    }).title;
  const existingNextTaskId =
    (report.linkedTaskId && report.linkedTaskId !== task.id
      ? resolveLinkedNextTaskId(
          db,
          report.linkedTaskId,
          replayInput.transition.nextPhase,
          nextTaskTitle,
          replayInput.source,
          replayInput.externalId,
        )
      : null) ??
    findExistingNextTaskId(db, nextTaskTitle);

  if (existingNextTaskId) {
    updateIntakeReportState(db, report.source, report.externalId, {
      status: 'in_progress',
      resolvedAt: null,
      linkedTaskId: existingNextTaskId,
    });

    return {
      handled: true,
      transition: replayInput.transition,
      createdTaskId: existingNextTaskId,
    };
  }

  const createdTaskId = createNextIntakeTask(db, replayInput.transition.nextPhase, report, {
    currentTaskTitle: replayInput.currentTaskTitle,
    nextTaskTitle: replayInput.transition.nextTaskTitle,
    retry: replayInput.transition.action === 'retry',
  });
  updateIntakeReportState(db, report.source, report.externalId, {
    status: 'in_progress',
    resolvedAt: null,
    linkedTaskId: createdTaskId,
  });

  return { handled: true, transition: replayInput.transition, createdTaskId };
}
