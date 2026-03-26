import Database from 'better-sqlite3';
import {
  type MockGitState,
  type ScenarioDefinition,
  SCENARIO_ORDER,
  SCENARIOS,
} from './scenarios.js';

export const HARNESS_SOURCE_FILE = 'docs/done/2026-03-26-integration-test-harness.md';

type HarnessQueries = Pick<
  typeof import('../../src/database/queries.js'),
  'createSection' | 'addSectionDependency' | 'createTask' | 'addTaskDependency'
>;

type InvocationKind =
  | 'coder'
  | 'coderOrchestrator'
  | 'reviewer'
  | 'reviewerOrchestrator'
  | 'reviewers'
  | 'multiReviewerOrchestrator'
  | 'coordinator';

interface InvocationCounterState {
  coder: number;
  coderOrchestrator: number;
  reviewer: number;
  reviewerOrchestrator: number;
  reviewers: number;
  multiReviewerOrchestrator: number;
  coordinator: number;
}

export interface CoordinatorCallRecord {
  taskId: string;
  scenarioId: string;
  rejectionCount: number;
  decision?: string;
  guidance?: string;
  threw?: boolean;
}

export interface IntegrationHarnessState {
  db: Database.Database;
  scenarios: Map<string, ScenarioDefinition>;
  taskScenarioMap: Map<string, string>;
  scenarioTaskMap: Map<string, string>;
  gitStateByTask: Map<string, MockGitState>;
  creditResults: Map<string, unknown>;
  counters: Map<string, InvocationCounterState>;
  coderGuidanceByTask: Map<string, string[]>;
  coordinatorCalls: CoordinatorCallRecord[];
  activeTaskId: string | null;
  lastAuditId: number;
  auditTick: number;
}

function zeroCounters(): InvocationCounterState {
  return {
    coder: 0,
    coderOrchestrator: 0,
    reviewer: 0,
    reviewerOrchestrator: 0,
    reviewers: 0,
    multiReviewerOrchestrator: 0,
    coordinator: 0,
  };
}

function formatSqliteTimestamp(offsetSeconds: number): string {
  return new Date(Date.parse('2026-01-01T00:00:00Z') + offsetSeconds * 1_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

function makeSha(index: number): string {
  return index.toString(16).padStart(40, '0').slice(-40);
}

function makeGitState(taskIndex: number, scenarioId: string, scenario: ScenarioDefinition): MockGitState {
  const sha = makeSha(taskIndex + 1);
  return {
    currentSha: sha,
    recentCommits:
      scenario.git?.recentCommits ??
      [{ sha, message: `feat: ${scenarioId}` }],
    changedFiles:
      scenario.git?.changedFiles ??
      [`src/${scenarioId}.ts`],
    diffSummary:
      scenario.git?.diffSummary ??
      `M src/${scenarioId}.ts`,
    modifiedFiles:
      scenario.git?.modifiedFiles ??
      [`src/${scenarioId}.ts`],
    diffStats:
      scenario.git?.diffStats ??
      { additions: 12, deletions: 2 },
    isReachable:
      scenario.git?.isReachable ??
      true,
    hasUncommitted:
      scenario.git?.hasUncommitted ??
      false,
  };
}

function resequenceSeedRows(db: Database.Database): { lastAuditId: number; auditTick: number } {
  const taskRows = db.prepare('SELECT id FROM tasks ORDER BY rowid ASC').all() as Array<{ id: string }>;
  let tick = 0;

  for (const row of taskRows) {
    const timestamp = formatSqliteTimestamp(tick);
    db.prepare(
      `UPDATE tasks
       SET created_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(timestamp, timestamp, row.id);
    tick += 1;
  }

  const auditRows = db.prepare('SELECT id FROM audit ORDER BY id ASC').all() as Array<{ id: number }>;
  for (const row of auditRows) {
    db.prepare('UPDATE audit SET created_at = ? WHERE id = ?').run(formatSqliteTimestamp(tick), row.id);
    tick += 1;
  }

  const lastAuditId = auditRows.length > 0 ? auditRows[auditRows.length - 1].id : 0;
  return { lastAuditId, auditTick: tick };
}

export function restampNewAuditEntries(state: IntegrationHarnessState): void {
  const rows = state.db
    .prepare('SELECT id FROM audit WHERE id > ? ORDER BY id ASC')
    .all(state.lastAuditId) as Array<{ id: number }>;

  for (const row of rows) {
    state.db
      .prepare('UPDATE audit SET created_at = ? WHERE id = ?')
      .run(formatSqliteTimestamp(state.auditTick), row.id);
    state.auditTick += 1;
    state.lastAuditId = row.id;
  }
}

function ensureTaskColumn(db: Database.Database, columnName: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE tasks ADD COLUMN ${columnName} ${definition}`);
}

export function createHarnessState(schemaSql: string, queries: HarnessQueries): IntegrationHarnessState {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, depends_on_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
  `);
  ensureTaskColumn(db, 'merge_phase', 'TEXT');
  ensureTaskColumn(db, 'approved_sha', 'TEXT');
  ensureTaskColumn(db, 'rebase_attempts', 'INTEGER DEFAULT 0');

  const state: IntegrationHarnessState = {
    db,
    scenarios: new Map(SCENARIO_ORDER.map((scenarioId) => [scenarioId, SCENARIOS[scenarioId]])),
    taskScenarioMap: new Map(),
    scenarioTaskMap: new Map(),
    gitStateByTask: new Map(),
    creditResults: new Map(),
    counters: new Map(),
    coderGuidanceByTask: new Map(),
    coordinatorCalls: [],
    activeTaskId: null,
    lastAuditId: 0,
    auditTick: 0,
  };

  const coreSection = queries.createSection(db, 'Core', 1);
  const depGateSection = queries.createSection(db, 'Dependency Gate', 4);
  const depGatedSection = queries.createSection(db, 'Dependency Gated', 5);
  const taskDepsSection = queries.createSection(db, 'Task Dependencies', 6);
  queries.addSectionDependency(db, depGatedSection.id, depGateSection.id);

  SCENARIO_ORDER.forEach((scenarioId, index) => {
    const scenario = SCENARIOS[scenarioId];
    const sectionId =
      scenario.section === 'dep-gate'
        ? depGateSection.id
        : scenario.section === 'dep-gated'
          ? depGatedSection.id
          : scenario.section === 'task-deps'
            ? taskDepsSection.id
            : coreSection.id;

    const task = queries.createTask(db, `[${scenarioId}] integration task #${index + 1}`, {
      sectionId,
      sourceFile: HARNESS_SOURCE_FILE,
    });

    state.taskScenarioMap.set(task.id, scenarioId);
    state.scenarioTaskMap.set(scenarioId, task.id);
    state.gitStateByTask.set(task.id, makeGitState(index, scenarioId, scenario));
  });

  const depTaskGatedId = state.scenarioTaskMap.get('dep-task-gated');
  const depTaskGateId = state.scenarioTaskMap.get('dep-task-gate');
  if (!depTaskGatedId || !depTaskGateId) {
    throw new Error('Dependency scenarios were not seeded correctly.');
  }
  queries.addTaskDependency(db, depTaskGatedId, depTaskGateId);

  const seedState = resequenceSeedRows(db);
  state.lastAuditId = seedState.lastAuditId;
  state.auditTick = seedState.auditTick;

  return state;
}

export function getScenarioByTask(state: IntegrationHarnessState, taskId: string): ScenarioDefinition {
  const scenarioId = state.taskScenarioMap.get(taskId);
  if (!scenarioId) {
    throw new Error(`No scenario registered for task ${taskId}`);
  }

  const scenario = state.scenarios.get(scenarioId);
  if (!scenario) {
    throw new Error(`No scenario definition found for ${scenarioId}`);
  }

  return scenario;
}

export function getScenarioIdByTask(state: IntegrationHarnessState, taskId: string): string {
  const scenarioId = state.taskScenarioMap.get(taskId);
  if (!scenarioId) {
    throw new Error(`No scenario registered for task ${taskId}`);
  }
  return scenarioId;
}

export function getTaskIdForScenario(state: IntegrationHarnessState, scenarioId: string): string {
  const taskId = state.scenarioTaskMap.get(scenarioId);
  if (!taskId) {
    throw new Error(`No task found for scenario ${scenarioId}`);
  }
  return taskId;
}

export function getGitStateForTask(state: IntegrationHarnessState, taskId: string): MockGitState {
  const gitState = state.gitStateByTask.get(taskId);
  if (!gitState) {
    throw new Error(`No git state registered for task ${taskId}`);
  }
  return gitState;
}

export function getActiveGitState(state: IntegrationHarnessState): MockGitState {
  if (!state.activeTaskId) {
    throw new Error('No active task is set for git-state lookup.');
  }
  return getGitStateForTask(state, state.activeTaskId);
}

export function consumeScenarioValue<T>(
  state: IntegrationHarnessState,
  taskId: string,
  kind: InvocationKind,
  values: T[] | undefined,
  fallback: T,
): T {
  const counters = state.counters.get(taskId) ?? zeroCounters();
  const index = counters[kind];

  if (!values || values.length === 0) {
    counters[kind] += 1;
    state.counters.set(taskId, counters);
    return fallback;
  }

  if (index >= values.length) {
    const scenarioId = state.taskScenarioMap.get(taskId) ?? 'unknown-scenario';
    throw new Error(
      `Scenario ${scenarioId} exhausted ${kind} script at call ${index + 1}; defined ${values.length} step(s).`,
    );
  }

  counters[kind] += 1;
  state.counters.set(taskId, counters);
  return values[index];
}

export function closeHarnessState(state: IntegrationHarnessState): void {
  state.db.close();
}
