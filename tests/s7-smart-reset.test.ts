/**
 * S7: Smart task reset routing — hasSuccessfulCoderWork and task selector integration.
 * Verifies that tasks with prior successful coder work route to review instead of
 * restarting the coder phase.
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask, hasSuccessfulCoderWork } from '../src/database/queries.js';

let taskSelector!: typeof import('../src/orchestrator/task-selector.js');

beforeEach(async () => {
  taskSelector = await import('../src/orchestrator/task-selector.js');
});

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Migration 027: task_dependencies (needed by findNextTask's dependency filtering)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, depends_on_task_id)
    )
  `);
  return db;
}

function insertCoderInvocation(db: Database.Database, taskId: string, success: boolean): void {
  db.prepare(
    `INSERT INTO task_invocations (task_id, role, provider, model, prompt, success, status, exit_code, duration_ms)
     VALUES (?, 'coder', 'test', 'test-model', 'test prompt', ?, 'completed', 0, 100)`
  ).run(taskId, success ? 1 : 0);
}

function insertReviewerInvocation(db: Database.Database, taskId: string, success: boolean): void {
  db.prepare(
    `INSERT INTO task_invocations (task_id, role, provider, model, prompt, success, status, exit_code, duration_ms)
     VALUES (?, 'reviewer', 'test', 'test-model', 'test prompt', ?, 'completed', 0, 100)`
  ).run(taskId, success ? 1 : 0);
}

describe('hasSuccessfulCoderWork', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns false for a task with no invocations', () => {
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });
    expect(hasSuccessfulCoderWork(db, task.id)).toBe(false);
  });

  it('returns false for a task with only failed coder invocations', () => {
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });
    insertCoderInvocation(db, task.id, false);
    expect(hasSuccessfulCoderWork(db, task.id)).toBe(false);
  });

  it('returns false for a task with only reviewer invocations', () => {
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });
    insertReviewerInvocation(db, task.id, true);
    expect(hasSuccessfulCoderWork(db, task.id)).toBe(false);
  });

  it('returns true for a task with a successful coder invocation', () => {
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });
    insertCoderInvocation(db, task.id, true);
    expect(hasSuccessfulCoderWork(db, task.id)).toBe(true);
  });

  it('returns true even with mixed failed and successful coder invocations', () => {
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });
    insertCoderInvocation(db, task.id, false);
    insertCoderInvocation(db, task.id, true);
    expect(hasSuccessfulCoderWork(db, task.id)).toBe(true);
  });
});

describe('S7 task selector routing', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('routes pending task with prior coder success to review', () => {
    const { selectNextTask } = taskSelector;
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });

    insertCoderInvocation(db, task.id, true);

    const selected = selectNextTask(db, section.id);
    expect(selected).not.toBeNull();
    expect(selected!.task.id).toBe(task.id);
    expect(selected!.action).toBe('review');
  });

  it('routes pending task without prior coder success to start', () => {
    const { selectNextTask } = taskSelector;
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });

    const selected = selectNextTask(db, section.id);
    expect(selected).not.toBeNull();
    expect(selected!.task.id).toBe(task.id);
    expect(selected!.action).toBe('start');
  });

  it('routes pending task with only failed coder invocations to start', () => {
    const { selectNextTask } = taskSelector;
    const section = createSection(db, 'Section A');
    const task = createTask(db, 'Task 1', { sectionId: section.id });

    insertCoderInvocation(db, task.id, false);

    const selected = selectNextTask(db, section.id);
    expect(selected).not.toBeNull();
    expect(selected!.action).toBe('start');
  });
});
