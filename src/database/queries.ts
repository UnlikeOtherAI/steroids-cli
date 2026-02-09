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
  | 'failed'
  | 'skipped'   // Fully external setup, nothing to code
  | 'partial';  // Some coding done, rest needs external setup

// Status markers for display
export const STATUS_MARKERS: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[-]',
  review: '[o]',
  completed: '[x]',
  disputed: '[!]',
  failed: '[F]',
  skipped: '[S]',   // Fully skipped - external setup required
  partial: '[s]',   // Partial - coded what we could, rest is external
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
  priority?: number;  // 0 = highest, 100 = lowest, 50 = default (added by migration 003)
  skipped?: number;  // 0 = active, 1 = skipped (added by migration 003)
  created_at: string;
}

export interface SectionDependency {
  id: string;
  section_id: string;
  depends_on_section_id: string;
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
  if (!section && id.length >= 4) {
    const matches = db
      .prepare('SELECT * FROM sections WHERE id LIKE ?')
      .all(`${id}%`) as Section[];

    if (matches.length === 1) {
      section = matches[0];
    } else if (matches.length > 1) {
      // Ambiguous prefix - throw error with suggestions
      const matchingIds = matches.map(s => `${s.id.substring(0, 8)} (${s.name})`).join(', ');
      throw new Error(
        `Ambiguous section prefix "${id}". Matches: ${matchingIds}. ` +
        `Please provide a longer prefix or use the full section name.`
      );
    }
    // If 0 matches, section remains null and will be handled by caller
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

/**
 * Get dependencies for a section that have incomplete tasks
 * Returns sections that the given section depends on and have any non-completed tasks
 * (pending, in_progress, review, disputed, failed, skipped, partial)
 */
export function getPendingDependencies(
  db: Database.Database,
  sectionId: string
): Section[] {
  return db
    .prepare(
      `SELECT DISTINCT s.*
       FROM sections s
       INNER JOIN section_dependencies sd ON s.id = sd.depends_on_section_id
       WHERE sd.section_id = ?
       AND EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.section_id = s.id
         AND t.status != 'completed'
       )
       ORDER BY s.position ASC`
    )
    .all(sectionId) as Section[];
}

/**
 * Check if all dependencies for a section are met
 * Dependencies are considered met when all tasks in dependent sections are completed
 */
export function hasDependenciesMet(
  db: Database.Database,
  sectionId: string
): boolean {
  const pendingDeps = getPendingDependencies(db, sectionId);
  return pendingDeps.length === 0;
}

/**
 * Set the priority of a section
 * Priority range: 0 (highest) to 100 (lowest), default is 50
 */
export function setSectionPriority(
  db: Database.Database,
  sectionId: string,
  priority: number
): void {
  if (priority < 0 || priority > 100) {
    throw new Error('Priority must be between 0 and 100');
  }

  const result = db
    .prepare('UPDATE sections SET priority = ? WHERE id = ?')
    .run(priority, sectionId);

  if (result.changes === 0) {
    throw new Error(`Section not found: ${sectionId}`);
  }
}

/**
 * Check if adding a dependency would create a circular dependency
 * Returns true if circular dependency would be created
 */
export function wouldCreateCircularDependency(
  db: Database.Database,
  sectionId: string,
  dependsOnSectionId: string
): boolean {
  // Self-dependency is always circular
  if (sectionId === dependsOnSectionId) {
    return true;
  }

  // Build dependency graph
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(currentId: string): boolean {
    if (recursionStack.has(currentId)) {
      return true; // Found a cycle
    }
    if (visited.has(currentId)) {
      return false; // Already checked this path
    }

    visited.add(currentId);
    recursionStack.add(currentId);

    // Get all sections that currentId depends on
    const deps = db
      .prepare(
        `SELECT depends_on_section_id FROM section_dependencies WHERE section_id = ?`
      )
      .all(currentId) as Array<{ depends_on_section_id: string }>;

    // Add the proposed new dependency for simulation
    if (currentId === sectionId) {
      deps.push({ depends_on_section_id: dependsOnSectionId });
    }

    for (const dep of deps) {
      if (hasCycle(dep.depends_on_section_id)) {
        return true;
      }
    }

    recursionStack.delete(currentId);
    return false;
  }

  return hasCycle(sectionId);
}

/**
 * Add a dependency between sections
 * Makes sectionId depend on dependsOnSectionId
 */
export function addSectionDependency(
  db: Database.Database,
  sectionId: string,
  dependsOnSectionId: string
): SectionDependency {
  // Check for circular dependencies
  if (wouldCreateCircularDependency(db, sectionId, dependsOnSectionId)) {
    throw new Error('Cannot add dependency: would create a circular dependency');
  }

  const id = uuidv4();

  try {
    db.prepare(
      `INSERT INTO section_dependencies (id, section_id, depends_on_section_id)
       VALUES (?, ?, ?)`
    ).run(id, sectionId, dependsOnSectionId);

    return {
      id,
      section_id: sectionId,
      depends_on_section_id: dependsOnSectionId,
      created_at: new Date().toISOString(),
    };
  } catch (error: any) {
    if (error.message?.includes('UNIQUE constraint')) {
      throw new Error('This dependency already exists');
    }
    if (error.message?.includes('FOREIGN KEY constraint')) {
      throw new Error('One or both section IDs are invalid');
    }
    throw error;
  }
}

/**
 * Remove a dependency between sections
 */
export function removeSectionDependency(
  db: Database.Database,
  sectionId: string,
  dependsOnSectionId: string
): void {
  const result = db
    .prepare(
      `DELETE FROM section_dependencies
       WHERE section_id = ? AND depends_on_section_id = ?`
    )
    .run(sectionId, dependsOnSectionId);

  if (result.changes === 0) {
    throw new Error('Dependency not found');
  }
}

/**
 * Get all dependencies for a section
 */
export function getSectionDependencies(
  db: Database.Database,
  sectionId: string
): Section[] {
  return db
    .prepare(
      `SELECT s.*
       FROM sections s
       INNER JOIN section_dependencies sd ON s.id = sd.depends_on_section_id
       WHERE sd.section_id = ?
       ORDER BY s.position ASC`
    )
    .all(sectionId) as Section[];
}

/**
 * Get all sections that depend on a given section
 */
export function getSectionDependents(
  db: Database.Database,
  sectionId: string
): Section[] {
  return db
    .prepare(
      `SELECT s.*
       FROM sections s
       INNER JOIN section_dependencies sd ON s.id = sd.section_id
       WHERE sd.depends_on_section_id = ?
       ORDER BY s.position ASC`
    )
    .all(sectionId) as Section[];
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

/**
 * Reset rejection count to 0 (keeps audit history)
 * Use when manually restarting a task after spec changes
 */
export function resetRejectionCount(
  db: Database.Database,
  taskId: string,
  actor: string,
  notes?: string
): number {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const oldCount = task.rejection_count;

  db.prepare(
    `UPDATE tasks SET rejection_count = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(taskId);

  // Record in audit trail
  addAuditEntry(
    db,
    taskId,
    task.status,
    task.status,
    actor,
    notes ?? `Rejection count reset from ${oldCount} to 0`
  );

  return oldCount;
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

/**
 * Helper to filter out tasks from sections with unmet dependencies
 */
function filterTasksWithMetDependencies(
  db: Database.Database,
  tasks: Task[]
): Task[] {
  return tasks.filter(task => {
    if (!task.section_id) {
      // Tasks without a section are always allowed
      return true;
    }
    // Check if section has all dependencies met
    return hasDependenciesMet(db, task.section_id);
  });
}

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
  const reviewTasks = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'review' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at`
    )
    .all(...sectionParams) as Task[];

  const filteredReviewTasks = filterTasksWithMetDependencies(db, reviewTasks);
  if (filteredReviewTasks.length > 0) {
    return { task: filteredReviewTasks[0], action: 'review' };
  }

  // Priority 2: Tasks in progress
  const inProgressTasks = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'in_progress' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at`
    )
    .all(...sectionParams) as Task[];

  const filteredInProgressTasks = filterTasksWithMetDependencies(db, inProgressTasks);
  if (filteredInProgressTasks.length > 0) {
    return { task: filteredInProgressTasks[0], action: 'resume' };
  }

  // Priority 3: Pending tasks
  const pendingTasks = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'pending' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at`
    )
    .all(...sectionParams) as Task[];

  const filteredPendingTasks = filterTasksWithMetDependencies(db, pendingTasks);
  if (filteredPendingTasks.length > 0) {
    return { task: filteredPendingTasks[0], action: 'start' };
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
