import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import {
  addAuditEntry,
  getSection,
  getTask,
  listSections,
  listTasks,
  type Task,
  updateTaskStatus,
} from '../database/queries.js';
import { checkSectionCompletionAndPR } from '../git/section-pr.js';
import {
  triggerProjectCompleted,
  triggerSectionCompleted,
  triggerTaskCompleted,
} from '../hooks/integration.js';
import {
  buildIntakeApprovalReplayInput,
  handleIntakeTaskApproval,
} from '../intake/reviewer-approval.js';
import { parseIntakeTaskReference } from '../intake/task-reference.js';
import {
  createEmptyApprovalEffectsReplayInput,
  parseApprovalEffectsReplayInput,
  type ApprovalEffectsReplayInput,
} from './approval-effects-replay.js';
import { getSectionCompletionState } from './section-completion.js';

interface AutomatedApprovalTask extends Pick<Task, 'id' | 'title' | 'source_file' | 'section_id'> {}

export interface AutomatedApprovalEffectOptions {
  config: SteroidsConfig;
  projectPath: string;
  intakeProjectPath?: string;
  hooksEnabled?: boolean;
  verbose?: boolean;
}

type ApprovalEffectStep =
  | 'task_completed_hook'
  | 'intake'
  | 'section_completed_hook'
  | 'section_completion'
  | 'project_completion';

const CATEGORY_APPROVAL_EFFECTS_PENDING = 'approval_effects_pending';
const CATEGORY_APPROVAL_EFFECTS_APPLIED = 'approval_effects_applied';
const CATEGORY_APPROVAL_EFFECT_STEP_APPLIED = 'approval_effect_step_applied';
const CATEGORY_APPROVAL_EFFECTS_MIGRATION_ANOMALY = 'approval_effects_migration_anomaly';

function hasAuditCategory(
  db: Database.Database,
  taskId: string,
  category: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1
       FROM audit
       WHERE task_id = ?
         AND category = ?
       LIMIT 1`
    )
    .get(taskId, category) as { 1: number } | undefined;

  return Boolean(row);
}

function getAppliedEffectSteps(
  db: Database.Database,
  taskId: string,
): Set<ApprovalEffectStep> {
  const rows = db
    .prepare(
      `SELECT metadata
       FROM audit
       WHERE task_id = ?
         AND category = ?
       ORDER BY id ASC`
    )
    .all(taskId, CATEGORY_APPROVAL_EFFECT_STEP_APPLIED) as Array<{ metadata: string | null }>;

  const steps = new Set<ApprovalEffectStep>();
  for (const row of rows) {
    if (!row.metadata) {
      continue;
    }

    try {
      const parsed = JSON.parse(row.metadata) as { step?: ApprovalEffectStep };
      if (parsed.step) {
        steps.add(parsed.step);
      }
    } catch {
      // Ignore corrupt historical metadata and keep replay deterministic.
    }
  }

  return steps;
}

function markEffectStepApplied(
  db: Database.Database,
  taskId: string,
  actor: string,
  step: ApprovalEffectStep,
): void {
  addAuditEntry(db, taskId, 'completed', 'completed', actor, {
    actorType: 'orchestrator',
    category: CATEGORY_APPROVAL_EFFECT_STEP_APPLIED,
    notes: `[approval_effects] Applied step: ${step}`,
    metadata: { step },
  });
}

function loadReplayInputFromCategory(
  db: Database.Database,
  taskId: string,
  category: string,
): ApprovalEffectsReplayInput | null {
  const row = db
    .prepare(
      `SELECT metadata
       FROM audit
       WHERE task_id = ?
         AND category = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(taskId, category) as { metadata: string | null } | undefined;

  if (!row?.metadata) {
    return null;
  }

  try {
    return parseApprovalEffectsReplayInput(JSON.parse(row.metadata));
  } catch (error) {
    throw new Error(
      `Invalid approval effects replay metadata for task ${taskId} (${category}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function loadReplayInputFromMergePending(
  db: Database.Database,
  taskId: string,
): ApprovalEffectsReplayInput | null {
  const row = db
    .prepare(
      `SELECT metadata
       FROM audit
       WHERE task_id = ?
         AND to_status = 'merge_pending'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
    )
    .get(taskId) as { metadata: string | null } | undefined;

  if (!row?.metadata) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.metadata) as { approval_effects_replay?: unknown };
    if (!parsed.approval_effects_replay) {
      return null;
    }

    return parseApprovalEffectsReplayInput(parsed.approval_effects_replay);
  } catch (error) {
    throw new Error(
      `Invalid merge_pending approval replay metadata for task ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function allProjectTasksCompleted(db: Database.Database): boolean {
  const allTasks = listTasks(db, { status: 'all' });
  return allTasks.length > 0 && allTasks.every((task) => task.status === 'completed');
}

async function maybeTriggerSectionCompletion(
  db: Database.Database,
  task: AutomatedApprovalTask,
  options: AutomatedApprovalEffectOptions,
  actor: string,
  appliedSteps: Set<ApprovalEffectStep>,
): Promise<void> {
  if (appliedSteps.has('section_completion') || !task.section_id) {
    return;
  }

  const section = getSection(db, task.section_id);
  if (!section) {
    markEffectStepApplied(db, task.id, actor, 'section_completion');
    return;
  }

  const sectionTasks = listTasks(db, { sectionId: task.section_id });
  const state = getSectionCompletionState(sectionTasks);

  if (state.done && !appliedSteps.has('section_completed_hook')) {
    if (options.hooksEnabled !== false) {
      await triggerSectionCompleted(
        {
          id: section.id,
          name: section.name,
          taskCount: sectionTasks.length,
        },
        sectionTasks.map((entry) => ({ id: entry.id, title: entry.title })),
        { verbose: options.verbose, projectPath: options.projectPath },
      );
    }
    markEffectStepApplied(db, task.id, actor, 'section_completed_hook');
  }

  await checkSectionCompletionAndPR(db, options.projectPath, task.section_id, options.config);
  markEffectStepApplied(db, task.id, actor, 'section_completion');
}

async function maybeTriggerProjectCompletion(
  db: Database.Database,
  taskId: string,
  options: AutomatedApprovalEffectOptions,
  actor: string,
  appliedSteps: Set<ApprovalEffectStep>,
): Promise<void> {
  if (appliedSteps.has('project_completion')) {
    return;
  }

  if (allProjectTasksCompleted(db) && options.hooksEnabled !== false) {
    const allTasks = listTasks(db, { status: 'all' });
    const sections = listSections(db);
    const files = Array.from(
      new Set(allTasks.map((task) => task.source_file).filter(Boolean)),
    ) as string[];

    await triggerProjectCompleted(
      {
        totalTasks: allTasks.length,
        files,
        sectionCount: sections.length,
      },
      { verbose: options.verbose, projectPath: options.projectPath },
    );
  }

  markEffectStepApplied(db, taskId, actor, 'project_completion');
}

function noteMigrationAnomaly(
  db: Database.Database,
  taskId: string,
  actor: string,
  reason: string,
): void {
  const existing = db
    .prepare(
      `SELECT 1
       FROM audit
       WHERE task_id = ?
         AND category = ?
         AND notes = ?
       LIMIT 1`
    )
    .get(taskId, CATEGORY_APPROVAL_EFFECTS_MIGRATION_ANOMALY, reason) as { 1: number } | undefined;

  if (existing) {
    return;
  }

  addAuditEntry(db, taskId, 'completed', 'completed', actor, {
    actorType: 'orchestrator',
    category: CATEGORY_APPROVAL_EFFECTS_MIGRATION_ANOMALY,
    notes: reason,
  });
}

export function buildApprovalEffectsReplayInput(
  task: AutomatedApprovalTask,
  projectPath: string
): ApprovalEffectsReplayInput {
  const intakeReplay = buildIntakeApprovalReplayInput(task, projectPath);
  return intakeReplay
    ? { version: 1, intake: intakeReplay }
    : createEmptyApprovalEffectsReplayInput();
}

export function markApprovalEffectsPending(
  db: Database.Database,
  taskId: string,
  actor: string,
  replayInput: ApprovalEffectsReplayInput,
): void {
  addAuditEntry(db, taskId, 'completed', 'completed', actor, {
    actorType: 'orchestrator',
    category: CATEGORY_APPROVAL_EFFECTS_PENDING,
    notes: '[approval_effects] Pending replay',
    metadata: replayInput,
  });
}

export async function runPendingApprovalEffects(
  db: Database.Database,
  task: AutomatedApprovalTask,
  options: AutomatedApprovalEffectOptions,
  replayInput: ApprovalEffectsReplayInput,
  actor = 'orchestrator',
): Promise<void> {
  const appliedSteps = getAppliedEffectSteps(db, task.id);
  const fullTask = getTask(db, task.id);
  if (!fullTask) {
    throw new Error(`Task not found while applying approval effects: ${task.id}`);
  }

  if (!appliedSteps.has('task_completed_hook')) {
    if (options.hooksEnabled !== false) {
      await triggerTaskCompleted(fullTask, {
        verbose: options.verbose,
        projectPath: options.projectPath,
      });
    }
    markEffectStepApplied(db, task.id, actor, 'task_completed_hook');
  }

  if (replayInput.intake && !appliedSteps.has('intake')) {
    handleIntakeTaskApproval(db, task, replayInput.intake);
    markEffectStepApplied(db, task.id, actor, 'intake');
  } else if (!replayInput.intake && parseIntakeTaskReference(task)) {
    noteMigrationAnomaly(
      db,
      task.id,
      actor,
      '[approval_effects] Intake replay input missing; intake follow-up was not replayed automatically.',
    );
  }

  await maybeTriggerSectionCompletion(db, task, options, actor, appliedSteps);
  await maybeTriggerProjectCompletion(db, task.id, options, actor, appliedSteps);

  if (!hasAuditCategory(db, task.id, CATEGORY_APPROVAL_EFFECTS_APPLIED)) {
    addAuditEntry(db, task.id, 'completed', 'completed', actor, {
      actorType: 'orchestrator',
      category: CATEGORY_APPROVAL_EFFECTS_APPLIED,
      notes: '[approval_effects] Replay applied',
    });
  }
}

export async function completeTaskWithApprovalEffects(
  db: Database.Database,
  task: AutomatedApprovalTask,
  options: AutomatedApprovalEffectOptions & {
    actor: string;
    notes: string;
    commitSha?: string;
    replayInput?: ApprovalEffectsReplayInput;
  },
): Promise<void> {
  const currentTask = getTask(db, task.id);
  if (!currentTask) {
    throw new Error(`Task not found: ${task.id}`);
  }

  const replayInput =
    options.replayInput ??
    buildApprovalEffectsReplayInput(task, options.intakeProjectPath ?? options.projectPath);

  db.transaction(() => {
    if (currentTask.status !== 'completed') {
      updateTaskStatus(db, task.id, 'completed', options.actor, options.notes, options.commitSha);
    }

    if (!loadReplayInputFromCategory(db, task.id, CATEGORY_APPROVAL_EFFECTS_PENDING)) {
      markApprovalEffectsPending(db, task.id, options.actor, replayInput);
    }
  })();

  await runPendingApprovalEffects(db, task, options, replayInput, options.actor);
}

export async function reconcilePendingApprovalEffects(
  db: Database.Database,
  options: AutomatedApprovalEffectOptions,
): Promise<number> {
  const pendingTasks = db
    .prepare(
      `WITH latest_pending AS (
         SELECT task_id, MAX(id) AS pending_id
         FROM audit
         WHERE category = ?
         GROUP BY task_id
       ),
       latest_applied AS (
         SELECT task_id, MAX(id) AS applied_id
         FROM audit
         WHERE category = ?
         GROUP BY task_id
       )
       SELECT t.id, t.title, t.source_file, t.section_id
       FROM tasks t
       JOIN latest_pending lp ON lp.task_id = t.id
       LEFT JOIN latest_applied la ON la.task_id = t.id
       WHERE t.status = 'completed'
         AND (la.applied_id IS NULL OR la.applied_id < lp.pending_id)`
    )
    .all(
      CATEGORY_APPROVAL_EFFECTS_PENDING,
      CATEGORY_APPROVAL_EFFECTS_APPLIED,
    ) as AutomatedApprovalTask[];

  let replayed = 0;
  for (const task of pendingTasks) {
    const replayInput = loadReplayInputFromCategory(
      db,
      task.id,
      CATEGORY_APPROVAL_EFFECTS_PENDING,
    );
    if (!replayInput) {
      continue;
    }

    await runPendingApprovalEffects(db, task, options, replayInput);
    replayed += 1;
  }

  const legacyCandidates = db
    .prepare(
      `SELECT t.id, t.title, t.source_file, t.section_id
       FROM tasks t
       WHERE t.status = 'completed'
         AND EXISTS (
           SELECT 1
           FROM audit a
           WHERE a.task_id = t.id
             AND a.to_status = 'completed'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM audit a
           WHERE a.task_id = t.id
             AND a.category IN (?, ?, ?)
         )
       ORDER BY t.updated_at DESC
       LIMIT 100`
    )
    .all(
      CATEGORY_APPROVAL_EFFECTS_PENDING,
      CATEGORY_APPROVAL_EFFECTS_APPLIED,
      CATEGORY_APPROVAL_EFFECTS_MIGRATION_ANOMALY,
    ) as AutomatedApprovalTask[];

  for (const task of legacyCandidates) {
    if (parseIntakeTaskReference(task)) {
      noteMigrationAnomaly(
        db,
        task.id,
        'orchestrator',
        '[approval_effects] Legacy completed intake task is missing immutable replay input; intake follow-up requires manual verification.',
      );
      continue;
    }

    const replayInput = createEmptyApprovalEffectsReplayInput();
    markApprovalEffectsPending(db, task.id, 'orchestrator', replayInput);
    await runPendingApprovalEffects(db, task, options, replayInput);
    replayed += 1;
  }

  return replayed;
}

export function loadQueuedApprovalEffectsReplayInput(
  db: Database.Database,
  taskId: string,
): ApprovalEffectsReplayInput | null {
  return loadReplayInputFromMergePending(db, taskId);
}
