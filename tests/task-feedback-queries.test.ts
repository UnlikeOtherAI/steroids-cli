import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask } from '../src/database/queries.js';
import {
  createTaskFeedback,
  deleteTaskFeedback,
  deleteTaskFeedbackForTask,
  getLatestTaskFeedback,
  listTaskFeedback,
} from '../src/database/feedback-queries.js';

describe('task feedback queries', () => {
  let db: Database.Database;
  let taskId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);

    const section = createSection(db, 'Feedback Tests');
    const task = createTask(db, 'Task with feedback', { sectionId: section.id });
    taskId = task.id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates and lists feedback in newest-first order', () => {
    const first = createTaskFeedback(db, taskId, 'First note', {
      source: 'ui',
      createdBy: 'alice',
    });
    const second = createTaskFeedback(db, taskId, 'Second note', {
      source: 'api',
      createdBy: 'bob',
    });

    const rows = listTaskFeedback(db, taskId);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(second.id);
    expect(rows[0].source).toBe('api');
    expect(rows[1].id).toBe(first.id);
    expect(rows[1].source).toBe('ui');
  });

  it('returns latest feedback or null when none exists', () => {
    expect(getLatestTaskFeedback(db, taskId)).toBeNull();

    const created = createTaskFeedback(db, taskId, 'Only note');
    const latest = getLatestTaskFeedback(db, taskId);

    expect(latest).not.toBeNull();
    expect(latest?.id).toBe(created.id);
    expect(latest?.feedback).toBe('Only note');
  });

  it('rejects empty feedback payloads', () => {
    expect(() => createTaskFeedback(db, taskId, '   ')).toThrow('Feedback cannot be empty');
  });

  it('deletes by feedback id and task id', () => {
    const one = createTaskFeedback(db, taskId, 'One');
    createTaskFeedback(db, taskId, 'Two');

    expect(deleteTaskFeedback(db, one.id)).toBe(true);
    expect(deleteTaskFeedback(db, one.id)).toBe(false);

    expect(deleteTaskFeedbackForTask(db, taskId)).toBe(1);
    expect(listTaskFeedback(db, taskId)).toEqual([]);
  });

  it('cascades feedback deletion when parent task is removed', () => {
    const cascadeTaskId = 'task-feedback-cascade';
    db.prepare(
      `INSERT INTO tasks (id, title, status, section_id, source_file, file_path, file_line, file_commit_sha, file_content_hash, start_commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cascadeTaskId, 'Cascade Task', 'pending', null, null, null, null, null, null, null);

    createTaskFeedback(db, cascadeTaskId, 'Task-bound note');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(cascadeTaskId);
    expect(listTaskFeedback(db, cascadeTaskId)).toEqual([]);
  });
});
