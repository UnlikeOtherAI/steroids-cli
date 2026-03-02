/**
 * Database query functions for task-level human feedback.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface TaskFeedback {
  id: string;
  task_id: string;
  feedback: string;
  source: string;
  created_by: string | null;
  created_at: string;
}

export interface CreateTaskFeedbackOptions {
  source?: string;
  createdBy?: string | null;
}

export function createTaskFeedback(
  db: Database.Database,
  taskId: string,
  feedback: string,
  options: CreateTaskFeedbackOptions = {}
): TaskFeedback {
  const normalizedFeedback = feedback.trim();
  if (!normalizedFeedback) {
    throw new Error('Feedback cannot be empty');
  }

  const id = uuidv4();
  const source = (options.source ?? 'user').trim() || 'user';
  const createdBy = options.createdBy ?? null;

  db.prepare(
    `INSERT INTO task_feedback (id, task_id, feedback, source, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, taskId, normalizedFeedback, source, createdBy);

  const row = db
    .prepare('SELECT * FROM task_feedback WHERE id = ?')
    .get(id) as TaskFeedback | undefined;

  if (!row) {
    throw new Error(`Failed to create task feedback for task ${taskId}`);
  }

  return row;
}

export function listTaskFeedback(db: Database.Database, taskId: string): TaskFeedback[] {
  return db
    .prepare(
      `SELECT * FROM task_feedback
       WHERE task_id = ?
       ORDER BY created_at DESC, rowid DESC`
    )
    .all(taskId) as TaskFeedback[];
}

export function getLatestTaskFeedback(db: Database.Database, taskId: string): TaskFeedback | null {
  const row = db
    .prepare(
      `SELECT * FROM task_feedback
       WHERE task_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(taskId) as TaskFeedback | undefined;

  return row ?? null;
}

export function deleteTaskFeedback(db: Database.Database, feedbackId: string): boolean {
  const result = db
    .prepare('DELETE FROM task_feedback WHERE id = ?')
    .run(feedbackId);
  return result.changes > 0;
}

export function deleteTaskFeedbackForTask(db: Database.Database, taskId: string): number {
  const result = db
    .prepare('DELETE FROM task_feedback WHERE task_id = ?')
    .run(taskId);
  return result.changes;
}
