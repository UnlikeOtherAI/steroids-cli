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
  commit_sha: string | null;
  created_at: string;
}

export interface RejectionEntry {
  rejection_number: number;
  commit_sha: string | null;
  notes: string | null;
  actor: string;
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

export function getSection(
  db: Database.Database,
  id: string
): Section | null {
  // Try exact match first
  let section = db
    .prepare('SELECT * FROM sections WHERE id = ?')
    .get(id) as Section | null;

  // If not found, try prefix match (for short IDs)
  if (!section && id.length >= 6) {
    section = db
      .prepare('SELECT * FROM sections WHERE id LIKE ?')
      .get(`${id}%`) as Section | null;
  }

  return section;
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
  // Try exact match first
  let task = db
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(id) as Task | null;

  // If not found, try prefix match (for short IDs)
  if (!task && id.length >= 6) {
    task = db
      .prepare('SELECT * FROM tasks WHERE id LIKE ?')
      .get(`${id}%`) as Task | null;
  }

  return task;
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
  notes?: string,
  commitSha?: string
): void {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const oldStatus = task.status;

  db.prepare(
    `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newStatus, taskId);

  addAuditEntry(db, taskId, oldStatus, newStatus, actor, notes, commitSha);
}

export function approveTask(
  db: Database.Database,
  taskId: string,
  model: string,
  notes?: string,
  commitSha?: string
): void {
  updateTaskStatus(db, taskId, 'completed', `model:${model}`, notes, commitSha);
}

export function rejectTask(
  db: Database.Database,
  taskId: string,
  model: string,
  notes?: string,
  commitSha?: string
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
      `Exceeded 15 rejections. Last note: ${notes ?? 'none'}`,
      commitSha
    );

    // Create system dispute
    createSystemDisputeForRejection(db, taskId, 'Exceeded 15 rejections');

    return { status: 'failed', rejectionCount: newRejectionCount };
  }

  // Normal rejection - back to in_progress
  db.prepare(
    `UPDATE tasks SET status = 'in_progress', rejection_count = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(newRejectionCount, taskId);

  addAuditEntry(db, taskId, task.status, 'in_progress', `model:${model}`, notes, commitSha);

  return { status: 'retry', rejectionCount: newRejectionCount };
}

// ============ Audit Operations ============

export function addAuditEntry(
  db: Database.Database,
  taskId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  notes?: string,
  commitSha?: string
): void {
  db.prepare(
    `INSERT INTO audit (task_id, from_status, to_status, actor, notes, commit_sha)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, fromStatus, toStatus, actor, notes ?? null, commitSha ?? null);
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

/**
 * Get rejection history for a task
 * Returns entries where a review was rejected (review -> in_progress)
 * Includes commit hash for easy reference
 */
export function getTaskRejections(
  db: Database.Database,
  taskId: string
): RejectionEntry[] {
  const rejections = db
    .prepare(
      `SELECT notes, commit_sha, actor, created_at
       FROM audit
       WHERE task_id = ?
       AND from_status = 'review'
       AND to_status = 'in_progress'
       ORDER BY created_at ASC`
    )
    .all(taskId) as Array<{ notes: string | null; commit_sha: string | null; actor: string; created_at: string }>;

  return rejections.map((r, index) => ({
    rejection_number: index + 1,
    commit_sha: r.commit_sha,
    notes: r.notes,
    actor: r.actor,
    created_at: r.created_at,
  }));
}

/**
 * Get the latest submission notes (when coder submitted for review)
 * This captures any notes the coder included with --notes flag
 */
export function getLatestSubmissionNotes(
  db: Database.Database,
  taskId: string
): string | null {
  const entry = db
    .prepare(
      `SELECT notes FROM audit
       WHERE task_id = ?
       AND to_status = 'review'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId) as { notes: string | null } | undefined;

  return entry?.notes ?? null;
}

// ============ Dispute Operations ============

// NOTE: Full dispute operations are in src/disputes/
// This is a minimal helper for backward compatibility with rejectTask
export function createSystemDisputeForRejection(
  db: Database.Database,
  taskId: string,
  reason: string
): string {
  const id = uuidv4();

  db.prepare(
    `INSERT INTO disputes (id, task_id, type, reason, created_by, coder_position)
     VALUES (?, ?, 'system', ?, 'system', ?)`
  ).run(id, taskId, reason, 'Task exceeded maximum rejection count and requires human intervention.');

  return id;
}

// ============ Task Selection (for orchestrator) ============

export function findNextTask(
  db: Database.Database,
  sectionId?: string
): {
  task: Task | null;
  action: 'review' | 'resume' | 'start' | 'idle';
} {
  // Build WHERE clause for section filtering
  const sectionFilter = sectionId ? 'AND t.section_id = ?' : '';
  const sectionParams = sectionId ? [sectionId] : [];

  // Priority 1: Tasks ready for review
  const reviewTask = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'review' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at
       LIMIT 1`
    )
    .get(...sectionParams) as Task | undefined;

  if (reviewTask) {
    return { task: reviewTask, action: 'review' };
  }

  // Priority 2: Tasks in progress
  const inProgressTask = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'in_progress' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at
       LIMIT 1`
    )
    .get(...sectionParams) as Task | undefined;

  if (inProgressTask) {
    return { task: inProgressTask, action: 'resume' };
  }

  // Priority 3: Pending tasks
  const pendingTask = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'pending' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at
       LIMIT 1`
    )
    .get(...sectionParams) as Task | undefined;

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

/**
 * Get task counts by status for project stats
 * Used by runner heartbeat to update global database
 */
export function getTaskCountsByStatus(db: Database.Database): {
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
} {
  const rows = db
    .prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status')
    .all() as Array<{ status: string; count: number }>;

  const counts = {
    pending: 0,
    in_progress: 0,
    review: 0,
    completed: 0,
  };

  for (const row of rows) {
    if (row.status === 'pending') {
      counts.pending = row.count;
    } else if (row.status === 'in_progress') {
      counts.in_progress = row.count;
    } else if (row.status === 'review') {
      counts.review = row.count;
    } else if (row.status === 'completed') {
      counts.completed = row.count;
    }
  }

  return counts;
}
