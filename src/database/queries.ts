/**
 * Database query functions for tasks, sections, and audit
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// Task status enum matching the spec
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'disputed'
  | 'failed';

// Status markers for display
export const STATUS_MARKERS: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[-]',
  review: '[o]',
  completed: '[x]',
  disputed: '[!]',
  failed: '[F]',
};

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  section_id: string | null;
  source_file: string | null;
  rejection_count: number;
  created_at: string;
  updated_at: string;
}

export interface Section {
  id: string;
  name: string;
  position: number;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  notes: string | null;
  created_at: string;
}

// ============ Section Operations ============

export function createSection(
  db: Database.Database,
  name: string,
  position?: number
): Section {
  const id = uuidv4();

  // Get max position if not specified
  if (position === undefined) {
    const maxPos = db
      .prepare('SELECT MAX(position) as max FROM sections')
      .get() as { max: number | null };
    position = (maxPos?.max ?? -1) + 1;
  }

  db.prepare(
    `INSERT INTO sections (id, name, position) VALUES (?, ?, ?)`
  ).run(id, name, position);

  return {
    id,
    name,
    position,
    created_at: new Date().toISOString(),
  };
}

export function listSections(db: Database.Database): Section[] {
  return db
    .prepare('SELECT * FROM sections ORDER BY position ASC')
    .all() as Section[];
}

export function getSectionByName(
  db: Database.Database,
  name: string
): Section | null {
  return db
    .prepare('SELECT * FROM sections WHERE name = ?')
    .get(name) as Section | null;
}

export function getSectionTaskCount(
  db: Database.Database,
  sectionId: string
): number {
  const result = db
    .prepare('SELECT COUNT(*) as count FROM tasks WHERE section_id = ?')
    .get(sectionId) as { count: number };
  return result.count;
}

// ============ Task Operations ============

export function createTask(
  db: Database.Database,
  title: string,
  options: {
    sectionId?: string;
    sourceFile?: string;
    status?: TaskStatus;
  } = {}
): Task {
  const id = uuidv4();
  const status = options.status ?? 'pending';

  db.prepare(
    `INSERT INTO tasks (id, title, status, section_id, source_file)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, title, status, options.sectionId ?? null, options.sourceFile ?? null);

  // Add audit entry for creation
  addAuditEntry(db, id, null, status, 'human:cli');

  return {
    id,
    title,
    status,
    section_id: options.sectionId ?? null,
    source_file: options.sourceFile ?? null,
    rejection_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function getTask(db: Database.Database, id: string): Task | null {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
}

export function getTaskByTitle(
  db: Database.Database,
  title: string
): Task | null {
  // Exact match first
  let task = db
    .prepare('SELECT * FROM tasks WHERE title = ?')
    .get(title) as Task | null;

  if (!task) {
    // Partial match
    task = db
      .prepare('SELECT * FROM tasks WHERE title LIKE ?')
      .get(`%${title}%`) as Task | null;
  }

  return task;
}

export function listTasks(
  db: Database.Database,
  options: {
    status?: TaskStatus | 'all';
    sectionId?: string;
    search?: string;
  } = {}
): Task[] {
  let sql = `
    SELECT t.* FROM tasks t
    LEFT JOIN sections s ON t.section_id = s.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (options.status && options.status !== 'all') {
    sql += ' AND t.status = ?';
    params.push(options.status);
  }

  if (options.sectionId) {
    sql += ' AND t.section_id = ?';
    params.push(options.sectionId);
  }

  if (options.search) {
    sql += ' AND t.title LIKE ?';
    params.push(`%${options.search}%`);
  }

  sql += ' ORDER BY COALESCE(s.position, 999999), t.created_at';

  return db.prepare(sql).all(...params) as Task[];
}

export function updateTaskStatus(
  db: Database.Database,
  taskId: string,
  newStatus: TaskStatus,
  actor: string,
  notes?: string
): void {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const oldStatus = task.status;

  db.prepare(
    `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newStatus, taskId);

  addAuditEntry(db, taskId, oldStatus, newStatus, actor, notes);
}

export function approveTask(
  db: Database.Database,
  taskId: string,
  model: string,
  notes?: string
): void {
  updateTaskStatus(db, taskId, 'completed', `model:${model}`, notes);
}

export function rejectTask(
  db: Database.Database,
  taskId: string,
  model: string,
  notes?: string
): { status: 'retry' | 'failed'; rejectionCount: number } {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const newRejectionCount = task.rejection_count + 1;

  if (newRejectionCount >= 15) {
    // Task failed - exceeded max rejections
    db.prepare(
      `UPDATE tasks SET status = 'failed', rejection_count = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(newRejectionCount, taskId);

    addAuditEntry(
      db,
      taskId,
      task.status,
      'failed',
      `model:${model}`,
      `Exceeded 15 rejections. Last note: ${notes ?? 'none'}`
    );

    // Create system dispute
    createDispute(db, taskId, 'system', 'Exceeded 15 rejections', 'system');

    return { status: 'failed', rejectionCount: newRejectionCount };
  }

  // Normal rejection - back to in_progress
  db.prepare(
    `UPDATE tasks SET status = 'in_progress', rejection_count = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(newRejectionCount, taskId);

  addAuditEntry(db, taskId, task.status, 'in_progress', `model:${model}`, notes);

  return { status: 'retry', rejectionCount: newRejectionCount };
}

// ============ Audit Operations ============

export function addAuditEntry(
  db: Database.Database,
  taskId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  notes?: string
): void {
  db.prepare(
    `INSERT INTO audit (task_id, from_status, to_status, actor, notes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(taskId, fromStatus, toStatus, actor, notes ?? null);
}

export function getTaskAudit(
  db: Database.Database,
  taskId: string
): AuditEntry[] {
  return db
    .prepare(
      'SELECT * FROM audit WHERE task_id = ? ORDER BY created_at ASC'
    )
    .all(taskId) as AuditEntry[];
}

// ============ Dispute Operations ============

export function createDispute(
  db: Database.Database,
  taskId: string,
  type: string,
  reason: string,
  createdBy: string
): string {
  const id = uuidv4();

  db.prepare(
    `INSERT INTO disputes (id, task_id, type, reason, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, taskId, type, reason, createdBy);

  // Update task status to disputed if not a system dispute
  if (type !== 'system') {
    const task = getTask(db, taskId);
    if (task) {
      updateTaskStatus(db, taskId, 'disputed', createdBy, reason);
    }
  }

  return id;
}

// ============ Task Selection (for orchestrator) ============

export function findNextTask(db: Database.Database): {
  task: Task | null;
  action: 'review' | 'resume' | 'start' | 'idle';
} {
  // Priority 1: Tasks ready for review
  const reviewTask = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'review'
       ORDER BY COALESCE(s.position, 999999), t.created_at
       LIMIT 1`
    )
    .get() as Task | undefined;

  if (reviewTask) {
    return { task: reviewTask, action: 'review' };
  }

  // Priority 2: Tasks in progress
  const inProgressTask = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'in_progress'
       ORDER BY COALESCE(s.position, 999999), t.created_at
       LIMIT 1`
    )
    .get() as Task | undefined;

  if (inProgressTask) {
    return { task: inProgressTask, action: 'resume' };
  }

  // Priority 3: Pending tasks
  const pendingTask = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'pending'
       ORDER BY COALESCE(s.position, 999999), t.created_at
       LIMIT 1`
    )
    .get() as Task | undefined;

  if (pendingTask) {
    return { task: pendingTask, action: 'start' };
  }

  return { task: null, action: 'idle' };
}

/**
 * Get the last rejection notes for a task
 */
export function getLastRejectionNotes(
  db: Database.Database,
  taskId: string
): string | null {
  const entry = db
    .prepare(
      `SELECT notes FROM audit
       WHERE task_id = ? AND to_status = 'in_progress' AND notes IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(taskId) as { notes: string } | undefined;

  return entry?.notes ?? null;
}
