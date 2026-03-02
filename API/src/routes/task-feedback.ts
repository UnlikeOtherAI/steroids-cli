/**
 * Task feedback API routes
 * CRUD endpoints for human feedback attached to a task
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteForRead } from '../utils/sqlite.js';

const router = Router();

interface TaskFeedbackRow {
  id: string;
  task_id: string;
  feedback: string;
  source: string;
  created_by: string | null;
  created_at: string;
}

function openProjectDatabaseForRead(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return null;
  }

  try {
    return openSqliteForRead(dbPath);
  } catch {
    return null;
  }
}

function openProjectDatabaseForWrite(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return null;
  }

  try {
    return new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  } catch {
    return null;
  }
}

function ensureTaskExists(db: Database.Database, taskId: string): boolean {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as { id: string } | undefined;
  return Boolean(task);
}

// GET /api/tasks/:taskId/feedback?project=<path>
router.get('/tasks/:taskId/feedback', (req: Request, res: Response) => {
  const { taskId } = req.params;
  const projectPath = req.query.project as string | undefined;

  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required query parameter: project',
    });
    return;
  }

  const db = openProjectDatabaseForRead(projectPath);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found',
      project: projectPath,
    });
    return;
  }

  try {
    if (!ensureTaskExists(db, taskId)) {
      res.status(404).json({
        success: false,
        error: 'Task not found',
        task_id: taskId,
      });
      return;
    }

    const feedback = db
      .prepare(
        `SELECT id, task_id, feedback, source, created_by, created_at
         FROM task_feedback
         WHERE task_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(taskId) as TaskFeedbackRow[];

    res.json({
      success: true,
      task_id: taskId,
      feedback,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list task feedback (is the database migrated?)',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

// POST /api/tasks/:taskId/feedback
// Body: { project: string, feedback: string, source?: string, createdBy?: string | null }
router.post('/tasks/:taskId/feedback', (req: Request, res: Response) => {
  const { taskId } = req.params;
  const { project, feedback, source, createdBy } = req.body as {
    project?: string;
    feedback?: string;
    source?: string;
    createdBy?: string | null;
  };

  if (!project) {
    res.status(400).json({
      success: false,
      error: 'Missing required body parameter: project',
    });
    return;
  }

  if (typeof feedback !== 'string' || !feedback.trim()) {
    res.status(400).json({
      success: false,
      error: 'feedback must be a non-empty string',
    });
    return;
  }

  const db = openProjectDatabaseForWrite(project);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found',
      project,
    });
    return;
  }

  try {
    if (!ensureTaskExists(db, taskId)) {
      res.status(404).json({
        success: false,
        error: 'Task not found',
        task_id: taskId,
      });
      return;
    }

    const id = randomUUID();
    const normalizedFeedback = feedback.trim();
    const normalizedSource = typeof source === 'string' && source.trim() ? source.trim() : 'user';
    const normalizedCreatedBy = createdBy === undefined ? null : createdBy;

    db.prepare(
      `INSERT INTO task_feedback (id, task_id, feedback, source, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, taskId, normalizedFeedback, normalizedSource, normalizedCreatedBy);

    const created = db
      .prepare('SELECT id, task_id, feedback, source, created_by, created_at FROM task_feedback WHERE id = ?')
      .get(id) as TaskFeedbackRow | undefined;

    if (!created) {
      res.status(500).json({
        success: false,
        error: 'Feedback was created but could not be loaded',
      });
      return;
    }

    res.status(201).json({
      success: true,
      task_id: taskId,
      feedback: created,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to create task feedback (is the database migrated?)',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

// DELETE /api/tasks/:taskId/feedback/:feedbackId?project=<path>
router.delete('/tasks/:taskId/feedback/:feedbackId', (req: Request, res: Response) => {
  const { taskId, feedbackId } = req.params;
  const projectPath = (req.query.project as string | undefined) ?? (req.body?.project as string | undefined);

  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required project parameter',
    });
    return;
  }

  const db = openProjectDatabaseForWrite(projectPath);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found',
      project: projectPath,
    });
    return;
  }

  try {
    if (!ensureTaskExists(db, taskId)) {
      res.status(404).json({
        success: false,
        error: 'Task not found',
        task_id: taskId,
      });
      return;
    }

    const result = db
      .prepare('DELETE FROM task_feedback WHERE id = ? AND task_id = ?')
      .run(feedbackId, taskId);

    if (result.changes === 0) {
      res.status(404).json({
        success: false,
        error: 'Feedback not found',
        feedback_id: feedbackId,
      });
      return;
    }

    res.json({
      success: true,
      task_id: taskId,
      feedback_id: feedbackId,
      deleted: true,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete task feedback (is the database migrated?)',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

export default router;
