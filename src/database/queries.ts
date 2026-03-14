/**
 * Database query functions for tasks, sections, and audit
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { TokenUsage } from '../providers/interface.js';

// Task status enum matching the spec
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'disputed'
  | 'failed'
  | 'skipped'           // Fully external setup, nothing to code
  | 'partial'           // Some coding done, rest needs external setup
  | 'blocked_error'     // Blocked by repeated failures (workspace pool)
  | 'blocked_conflict'; // Blocked by merge conflicts (workspace pool)

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
  blocked_error: '[B]',    // Blocked by repeated failures
  blocked_conflict: '[C]', // Blocked by merge conflicts
};

/**
 * Terminal status sets for dependency checks — single source of truth.
 *
 * SECTION deps (coarse): blocked_error/blocked_conflict count as "met" so one
 * blocked task doesn't hold up entire downstream section chains.
 *
 * TASK deps (fine-grained): blocked statuses are NOT "met" because a direct
 * dependency on a blocked task means the dependent needs that specific output.
 */
export const SECTION_DEP_TERMINAL: readonly TaskStatus[] = ['completed', 'disputed', 'skipped', 'partial', 'blocked_error', 'blocked_conflict'];
export const TASK_DEP_TERMINAL: readonly TaskStatus[] = ['completed', 'disputed', 'skipped', 'partial'];

/** Generate SQL IN clause from a status array: ('completed', 'disputed', ...) */
const sqlIn = (statuses: readonly TaskStatus[]) => `(${statuses.map(s => `'${s}'`).join(', ')})`;

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  section_id: string | null;
  source_file: string | null;
  file_path: string | null;
  file_line: number | null;
  file_commit_sha: string | null;
  file_content_hash: string | null;
  start_commit_sha: string | null;
  rejection_count: number;
  failure_count?: number;
  last_failure_at?: string | null;
  conflict_count?: number;
  merge_failure_count?: number;
  blocked_reason?: string | null;
  reference_task_id?: string | null;
  reference_commit?: string | null;
  reference_commit_message?: string | null;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Section {
  id: string;
  name: string;
  position: number;
  priority?: number;     // 0 = highest, 100 = lowest, 50 = default (added by migration 003)
  skipped?: number;      // 0 = active, 1 = skipped (added by migration 008)
  branch?: string | null;     // target branch override (added by migration 021)
  auto_pr?: number;           // 0 = push only, 1 = create PR on completion (migration 022)
  pr_number?: number | null;  // GitHub PR number if created (added by migration 022)
  coder_provider?: string | null; // per-section coder provider override (migration 026)
  coder_model?: string | null;    // per-section coder model override (migration 026)
  pr_labels?: string | null;      // future PR label metadata (migration 026)
  pr_draft?: number;              // 0 = ready, 1 = draft PR (migration 026)
  created_at: string;
}

export interface SectionDependency {
  id: string;
  section_id: string;
  depends_on_section_id: string;
  created_at: string;
}

export interface TaskDependency {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  category: string | null;
  error_code: string | null;
  metadata: string | null;
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

export interface MustImplementGuidance {
  guidance: string;
  rejection_count_watermark: number;
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

const FEEDBACK_SECTION_NAME = 'Needs User Input';

export function getOrCreateFeedbackSection(db: Database.Database): Section {
  const existing = getSectionByName(db, FEEDBACK_SECTION_NAME);
  if (existing) return existing;

  const maxPos = db
    .prepare('SELECT MAX(position) as max FROM sections')
    .get() as { max: number | null };
  const position = (maxPos?.max ?? -1) + 1;

  const id = uuidv4();
  db.prepare(
    `INSERT INTO sections (id, name, position, priority, skipped) VALUES (?, ?, ?, ?, ?)`
  ).run(id, FEEDBACK_SECTION_NAME, position, 100, 1);

  return { id, name: FEEDBACK_SECTION_NAME, position, priority: 100, skipped: 1, created_at: new Date().toISOString() };
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
 * Returns sections that the given section depends on and still have tasks that are
 * actively blocking: pending, in_progress, review, failed, blocked_error,
 * blocked_conflict.
 *
 * Terminal states that do NOT block downstream sections:
 *   - completed: done
 *   - skipped: intentionally skipped, external setup handles the rest
 *   - partial: coded what we could, rest is external — system is done with it
 *   - blocked_error / blocked_conflict: pool infrastructure blocked the task;
 *     not recoverable by the runner, so downstream should not be permanently gated.
 *     (Human intervention is required to unblock these, but that shouldn't stop
 *     unrelated downstream sections from starting.)
 *
 * Note: 'failed' is intentionally kept as blocking. Failed tasks are retriable —
 * a human or the retry mechanism can reset them to pending. Downstream work that
 * depends on correct upstream output should wait for that retry.
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
         AND t.status NOT IN ${sqlIn(SECTION_DEP_TERMINAL)}
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
 * Set or clear the target branch for a section.
 * Pass null to clear the override (tasks use project base branch).
 *
 * Also clears pr_number when the branch changes so that auto-PR can
 * fire again against the new branch (stale PR numbers from the old
 * branch would otherwise block creation forever).
 */
export function setSectionBranch(
  db: Database.Database,
  sectionId: string,
  branch: string | null
): void {
  const result = db
    .prepare('UPDATE sections SET branch = ?, pr_number = NULL WHERE id = ?')
    .run(branch, sectionId);

  if (result.changes === 0) {
    throw new Error(`Section not found: ${sectionId}`);
  }
}

/**
 * Enable or disable auto-PR for a section.
 */
export function setSectionAutoPr(
  db: Database.Database,
  sectionId: string,
  autoPr: boolean
): void {
  const result = db
    .prepare('UPDATE sections SET auto_pr = ? WHERE id = ?')
    .run(autoPr ? 1 : 0, sectionId);

  if (result.changes === 0) {
    throw new Error(`Section not found: ${sectionId}`);
  }
}

/**
 * Record or clear the PR number for a section.
 * Pass null to reset (allows re-triggering auto-PR).
 */
export function setSectionPrNumber(
  db: Database.Database,
  sectionId: string,
  prNumber: number | null
): void {
  const result = db
    .prepare('UPDATE sections SET pr_number = ? WHERE id = ?')
    .run(prNumber, sectionId);

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

// ============ Task Dependency Operations ============

/**
 * Check if adding a task dependency would create a circular dependency.
 * Uses DFS from dependsOnTaskId through existing task_dependencies;
 * if taskId is reachable, adding the edge would form a cycle.
 */
export function wouldCreateCircularTaskDependency(
  db: Database.Database,
  taskId: string,
  dependsOnTaskId: string
): boolean {
  if (taskId === dependsOnTaskId) {
    return true;
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(currentId: string): boolean {
    if (recursionStack.has(currentId)) {
      return true;
    }
    if (visited.has(currentId)) {
      return false;
    }

    visited.add(currentId);
    recursionStack.add(currentId);

    const deps = db
      .prepare(
        `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?`
      )
      .all(currentId) as Array<{ depends_on_task_id: string }>;

    // Simulate the proposed new edge
    if (currentId === taskId) {
      deps.push({ depends_on_task_id: dependsOnTaskId });
    }

    for (const dep of deps) {
      if (hasCycle(dep.depends_on_task_id)) {
        return true;
      }
    }

    recursionStack.delete(currentId);
    return false;
  }

  return hasCycle(taskId);
}

/**
 * Add a dependency between tasks.
 * Makes taskId depend on dependsOnTaskId (taskId cannot start until
 * dependsOnTaskId reaches a terminal status).
 */
export function addTaskDependency(
  db: Database.Database,
  taskId: string,
  dependsOnTaskId: string
): TaskDependency {
  // Validate both tasks exist
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const depTask = db.prepare('SELECT id FROM tasks WHERE id = ?').get(dependsOnTaskId);
  if (!depTask) {
    throw new Error(`Task not found: ${dependsOnTaskId}`);
  }

  // Self-dependency check
  if (taskId === dependsOnTaskId) {
    throw new Error('A task cannot depend on itself');
  }

  // Circular dependency check
  if (wouldCreateCircularTaskDependency(db, taskId, dependsOnTaskId)) {
    throw new Error('Cannot add dependency: would create a circular dependency');
  }

  const id = uuidv4();

  try {
    db.prepare(
      `INSERT INTO task_dependencies (id, task_id, depends_on_task_id)
       VALUES (?, ?, ?)`
    ).run(id, taskId, dependsOnTaskId);

    return {
      id,
      task_id: taskId,
      depends_on_task_id: dependsOnTaskId,
      created_at: new Date().toISOString(),
    };
  } catch (error: any) {
    if (error.message?.includes('UNIQUE constraint')) {
      throw new Error('This dependency already exists');
    }
    if (error.message?.includes('FOREIGN KEY constraint')) {
      throw new Error('One or both task IDs are invalid');
    }
    throw error;
  }
}

/**
 * Remove a dependency between tasks.
 * Returns number of rows affected.
 */
export function removeTaskDependency(
  db: Database.Database,
  taskId: string,
  dependsOnTaskId: string
): number {
  const result = db
    .prepare(
      `DELETE FROM task_dependencies
       WHERE task_id = ? AND depends_on_task_id = ?`
    )
    .run(taskId, dependsOnTaskId);

  if (result.changes === 0) {
    throw new Error('Dependency not found');
  }

  return result.changes;
}

/**
 * Get all tasks that taskId depends on.
 */
export function getTaskDependencies(
  db: Database.Database,
  taskId: string
): Task[] {
  return db
    .prepare(
      `SELECT t.*
       FROM tasks t
       INNER JOIN task_dependencies td ON t.id = td.depends_on_task_id
       WHERE td.task_id = ?`
    )
    .all(taskId) as Task[];
}

/**
 * Get all tasks that depend on taskId.
 */
export function getTaskDependents(
  db: Database.Database,
  taskId: string
): Task[] {
  return db
    .prepare(
      `SELECT t.*
       FROM tasks t
       INNER JOIN task_dependencies td ON t.id = td.task_id
       WHERE td.depends_on_task_id = ?`
    )
    .all(taskId) as Task[];
}

/**
 * Check if all task-level dependencies for a task are met.
 *
 * Terminal statuses that count as "met": completed, disputed, skipped, partial.
 *
 * NOTE: Unlike section-level deps, blocked_error and blocked_conflict are NOT
 * considered met for task deps — a blocked upstream task should block its
 * direct dependents since the specific output is expected.
 */
export function hasTaskDependenciesMet(
  db: Database.Database,
  taskId: string
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as unmet FROM task_dependencies td
       JOIN tasks t ON td.depends_on_task_id = t.id
       WHERE td.task_id = ?
       AND t.status NOT IN ${sqlIn(TASK_DEP_TERMINAL)}`
    )
    .get(taskId) as { unmet: number };

  return row.unmet === 0;
}

// ============ Task Operations ============

export function createTask(
  db: Database.Database,
  title: string,
  options: {
    sectionId?: string;
    sourceFile?: string;
    status?: TaskStatus;
    filePath?: string;
    fileLine?: number;
    fileCommitSha?: string;
    fileContentHash?: string;
    description?: string;
  } = {}
): Task {
  const id = uuidv4();
  const status = options.status ?? 'pending';

  db.prepare(
    `INSERT INTO tasks (id, title, status, section_id, source_file, file_path, file_line, file_commit_sha, file_content_hash, start_commit_sha, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, title, status,
    options.sectionId ?? null, options.sourceFile ?? null,
    options.filePath ?? null, options.fileLine ?? null,
    options.fileCommitSha ?? null, options.fileContentHash ?? null, null,
    options.description ?? null
  );

  // Add audit entry for creation
  addAuditEntry(db, id, null, status, 'human:cli');

  return {
    id,
    title,
    status,
    section_id: options.sectionId ?? null,
    source_file: options.sourceFile ?? null,
    file_path: options.filePath ?? null,
    file_line: options.fileLine ?? null,
    file_commit_sha: options.fileCommitSha ?? null,
    file_content_hash: options.fileContentHash ?? null,
    start_commit_sha: null,
    description: options.description ?? null,
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

  // Sort by status priority (in_progress first, completed/skipped last)
  sql += ` ORDER BY
    CASE t.status
      WHEN 'in_progress' THEN 1
      WHEN 'review' THEN 2
      WHEN 'pending' THEN 3
      WHEN 'disputed' THEN 4
      WHEN 'failed' THEN 5
      WHEN 'partial' THEN 6
      WHEN 'skipped' THEN 7
      WHEN 'completed' THEN 8
      ELSE 9
    END,
    COALESCE(s.position, 999999),
    t.created_at`;

  return db.prepare(sql).all(...params) as Task[];
}

export function updateTaskStartSha(
  db: Database.Database,
  taskId: string,
  startCommitSha: string
): void {
  db.prepare('UPDATE tasks SET start_commit_sha = ?, updated_at = datetime("now") WHERE id = ?').run(startCommitSha, taskId);
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

  // Handle failure_count updates for tasks transitioning from failed status
  // Only decrement once per failure, regardless of the recovery path
  if (oldStatus === 'failed' && (newStatus === 'pending' || newStatus === 'completed')) {
    db.prepare(
      `UPDATE tasks
       SET status = ?,
           failure_count = CASE
             WHEN COALESCE(failure_count, 0) > 0 THEN failure_count - 1
             ELSE 0
           END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(newStatus, taskId);
  }
  // For other transitions from failed (disputed, skipped, etc.),
  // keep failure_count unchanged but update status
  else if (oldStatus === 'failed') {
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newStatus, taskId);
  } else {
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newStatus, taskId);
  }

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

export function resetTaskFailureCount(
  db: Database.Database,
  taskId: string,
  actor: string,
  notes?: string
): number {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const oldFailureCount = task.failure_count ?? 0;

  db.prepare(
    `UPDATE tasks
     SET failure_count = 0, last_failure_at = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);

  addAuditEntry(
    db,
    taskId,
    task.status,
    task.status,
    actor,
    notes ?? `Failure count reset from ${oldFailureCount} to 0`
  );

  return oldFailureCount;
}

export function incrementTaskFailureCount(db: Database.Database, taskId: string): number {
  db.prepare(
    `UPDATE tasks
     SET failure_count = COALESCE(failure_count, 0) + 1,
         last_failure_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);

  const row = db
    .prepare('SELECT failure_count FROM tasks WHERE id = ?')
    .get(taskId) as { failure_count: number | null } | undefined;

  return Number(row?.failure_count ?? 0);
}

export function clearTaskFailureCount(db: Database.Database, taskId: string): number {
  const oldFailureCount = db
    .prepare('SELECT failure_count FROM tasks WHERE id = ?')
    .get(taskId) as { failure_count: number | null } | undefined;

  db.prepare(
    `UPDATE tasks
     SET failure_count = 0,
         last_failure_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);

  return Number(oldFailureCount?.failure_count ?? 0);
}

/**
 * Update editable task fields (title, source, file anchor, section)
 * Only updates fields that are explicitly provided (not undefined)
 */
export interface TaskFieldUpdates {
  title?: string;
  description?: string | null;
  sourceFile?: string;
  sectionId?: string;
  filePath?: string | null;
  fileLine?: number | null;
  fileCommitSha?: string | null;
  fileContentHash?: string | null;
}

export function updateTaskFields(
  db: Database.Database,
  taskId: string,
  fields: TaskFieldUpdates,
  actor: string,
  notes?: string
): void {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.sourceFile !== undefined) { sets.push('source_file = ?'); params.push(fields.sourceFile); }
  if (fields.sectionId !== undefined) { sets.push('section_id = ?'); params.push(fields.sectionId); }
  if (fields.filePath !== undefined) { sets.push('file_path = ?'); params.push(fields.filePath); }
  if (fields.fileLine !== undefined) { sets.push('file_line = ?'); params.push(fields.fileLine); }
  if (fields.fileCommitSha !== undefined) { sets.push('file_commit_sha = ?'); params.push(fields.fileCommitSha); }
  if (fields.fileContentHash !== undefined) { sets.push('file_content_hash = ?'); params.push(fields.fileContentHash); }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  params.push(taskId);

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const changes = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  addAuditEntry(db, taskId, task.status, task.status, actor, notes ?? `Fields updated: ${changes}`);
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

export interface AuditOptions {
  notes?: string;
  commitSha?: string;
  actorType?: 'human' | 'coder' | 'reviewer' | 'orchestrator';
  model?: string;
  category?: string;
  errorCode?: string;
  metadata?: any;
}

export function addAuditEntry(
  db: Database.Database,
  taskId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  options?: AuditOptions | string,
  commitSha?: string
): void {
  let notes: string | null = null;
  let finalCommitSha: string | null = commitSha ?? null;
  let actorType: string = 'human';
  let model: string | null = null;
  let category: string | null = null;
  let errorCode: string | null = null;
  let metadataStr: string | null = null;

  if (typeof options === 'string') {
    notes = options;
  } else if (options != null) {
    notes = options.notes ?? null;
    finalCommitSha = options.commitSha ?? finalCommitSha;
    actorType = options.actorType ?? 'human';
    model = options.model ?? null;
    category = options.category ?? null;
    errorCode = options.errorCode ?? null;
    if (options.metadata) {
      metadataStr = typeof options.metadata === 'string' ? options.metadata : JSON.stringify(options.metadata);
    }
  }

  db.prepare(
    `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, model, notes, commit_sha, category, error_code, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, fromStatus, toStatus, actor, actorType, model, notes, finalCommitSha, category, errorCode, metadataStr);
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

/**
 * Get the latest commit hash associated with a submission to review.
 * This is the canonical commit reference for reviewer prompts.
 */
export function getLatestSubmissionCommitSha(
  db: Database.Database,
  taskId: string
): string | null {
  const entry = db
    .prepare(
      `SELECT commit_sha FROM audit
       WHERE task_id = ?
       AND to_status = 'review'
       AND commit_sha IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(taskId) as { commit_sha: string | null } | undefined;

  return entry?.commit_sha ?? null;
}

/**
 * Get submission commit hashes for review transitions, from newest to oldest.
 *
 * We scope history to the latest active task lifecycle (latest pending -> in_progress).
 * This prevents old pre-reset submissions from polluting cumulative reviewer diffs.
 */
export function getSubmissionCommitShas(db: Database.Database, taskId: string): string[] {
  const rows = db
    .prepare(
      `WITH latest_attempt AS (
         SELECT COALESCE(MAX(id), 0) AS boundary_id
         FROM audit
         WHERE task_id = ?
           AND from_status = 'pending'
           AND to_status = 'in_progress'
       )
       SELECT a.commit_sha
       FROM audit a
       JOIN latest_attempt la
       WHERE a.task_id = ?
         AND a.to_status = 'review'
         AND a.commit_sha IS NOT NULL
         AND a.id > la.boundary_id
       ORDER BY a.created_at DESC, a.id DESC`
    )
    .all(taskId, taskId) as Array<{ commit_sha: string | null }>;

  return rows
    .map((row) => row.commit_sha)
    .filter((sha): sha is string => Boolean(sha));
}

/**
 * Get the latest persisted MUST_IMPLEMENT guidance for a task.
 * Guidance is stored as coordinator audit notes with marker:
 * [must_implement][rc=<rejection_count>] <guidance text>
 */
export function getLatestMustImplementGuidance(
  db: Database.Database,
  taskId: string
): MustImplementGuidance | null {
  const entry = db
    .prepare(
      `SELECT notes, metadata, created_at
       FROM audit
       WHERE task_id = ?
       AND actor = 'coordinator'
       AND category = 'must_implement'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(taskId) as { notes: string | null; metadata: string | null; created_at: string } | undefined;

  if (!entry?.notes) return null;

  let rejectionCountWatermark = 0;
  if (entry.metadata) {
    try {
      const meta = JSON.parse(entry.metadata);
      if (typeof meta.rejection_count === 'number') {
        rejectionCountWatermark = meta.rejection_count;
      }
    } catch {}
  }

  const guidance = entry.notes.trim();

  if (!guidance) return null;

  return {
    guidance,
    rejection_count_watermark: Number.isFinite(rejectionCountWatermark) ? rejectionCountWatermark : 0,
    created_at: entry.created_at,
  };
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
    // Check section-level dependencies
    if (task.section_id && !hasDependenciesMet(db, task.section_id)) {
      return false;
    }
    // Check task-level dependencies
    if (!hasTaskDependenciesMet(db, task.id)) {
      return false;
    }
    return true;
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
  const followUpEligibilityFilter =
    `AND (
      t.is_follow_up = 0
      OR NOT EXISTS (
        SELECT 1 FROM tasks t2
        WHERE ((t2.section_id = t.section_id) OR (t2.section_id IS NULL AND t.section_id IS NULL))
          AND t2.status IN ('pending', 'in_progress', 'review')
          AND t2.is_follow_up = 0
      )
    )`;

  // Exclude tasks in skipped sections unless a specific section was requested
  const skipFilter = sectionId ? '' : 'AND (s.skipped IS NULL OR s.skipped = 0)';

  // Priority 1: Tasks ready for review
  const reviewTasks = db
    .prepare(
       `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'review' ${sectionFilter} ${skipFilter}
         ${followUpEligibilityFilter}
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
       WHERE t.status = 'in_progress' ${sectionFilter} ${skipFilter}
         ${followUpEligibilityFilter}
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
       WHERE t.status = 'pending' ${sectionFilter} ${skipFilter}
         ${followUpEligibilityFilter}
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

// ============ Task Invocation Logging ============

export interface TaskInvocation {
  id: number;
  task_id: string;
  role: 'coder' | 'reviewer';
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  error: string | null;
  exit_code: number;
  duration_ms: number;
  success: number;
  timed_out: number;
  rejection_number: number | null;
  session_id: string | null;
  resumed_from_session_id: string | null;
  invocation_mode: 'fresh' | 'resume';
  token_usage_json: string | null;
  created_at: string;
}

export interface CreateInvocationParams {
  taskId: string;
  role: 'coder' | 'reviewer';
  provider: string;
  model: string;
  prompt: string;
  response?: string;
  error?: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
  rejectionNumber?: number;
  sessionId?: string;
  resumedFromSessionId?: string;
  invocationMode?: 'fresh' | 'resume';
  tokenUsage?: TokenUsage;
  runnerId?: string;
}

/**
 * Log an LLM invocation for a task
 * This stores the full prompt and response for debugging
 */
export function createTaskInvocation(
  db: Database.Database,
  params: CreateInvocationParams
): number {
  const result = db.prepare(
    `INSERT INTO task_invocations (
      task_id, role, provider, model, prompt, response, error,
      exit_code, duration_ms, success, timed_out, rejection_number,
      session_id, resumed_from_session_id, invocation_mode, token_usage_json, runner_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.taskId,
    params.role,
    params.provider,
    params.model,
    params.prompt,
    params.response ?? null,
    params.error ?? null,
    params.exitCode,
    params.durationMs,
    params.success ? 1 : 0,
    params.timedOut ? 1 : 0,
    params.rejectionNumber ?? null,
    params.sessionId ?? null,
    params.resumedFromSessionId ?? null,
    params.invocationMode ?? 'fresh',
    params.tokenUsage ? JSON.stringify(params.tokenUsage) : null,
    params.runnerId ?? null
  );

  return result.lastInsertRowid as number;
}

/**
 * Get all invocations for a task session
 * Ordered by creation time (oldest first)
 */
export function getTaskInvocationsBySession(
  db: Database.Database,
  taskId: string,
  sessionId: string
): TaskInvocation[] {
  const allInvocations = db
    .prepare(
      `SELECT * FROM task_invocations
       WHERE task_id = ?
       ORDER BY created_at ASC`
    )
    .all(taskId) as TaskInvocation[];

  const linkedSessions = new Set<string>();
  linkedSessions.add(sessionId);

  let addedNew = true;
  while (addedNew) {
    addedNew = false;
    for (const inv of allInvocations) {
      if (inv.session_id && linkedSessions.has(inv.session_id)) {
        if (inv.resumed_from_session_id && !linkedSessions.has(inv.resumed_from_session_id)) {
          linkedSessions.add(inv.resumed_from_session_id);
          addedNew = true;
        }
      } else if (inv.resumed_from_session_id && linkedSessions.has(inv.resumed_from_session_id)) {
        if (inv.session_id && !linkedSessions.has(inv.session_id)) {
          linkedSessions.add(inv.session_id);
          addedNew = true;
        }
      }
    }
  }

  return allInvocations.filter(inv => 
    (inv.session_id && linkedSessions.has(inv.session_id)) ||
    (inv.resumed_from_session_id && linkedSessions.has(inv.resumed_from_session_id))
  );
}

/**
 * Get all invocations for a task
 * Ordered by creation time (oldest first)
 */
export function getTaskInvocations(
  db: Database.Database,
  taskId: string
): TaskInvocation[] {
  return db
    .prepare(
      `SELECT * FROM task_invocations
       WHERE task_id = ?
       ORDER BY created_at ASC`
    )
    .all(taskId) as TaskInvocation[];
}

/**
 * Get recent invocations for a task (limited)
 * Ordered by creation time (newest first)
 */
export function getRecentTaskInvocations(
  db: Database.Database,
  taskId: string,
  limit: number = 10
): TaskInvocation[] {
  return db
    .prepare(
      `SELECT * FROM task_invocations
       WHERE task_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(taskId, limit) as TaskInvocation[];
}

/**
 * Get the latest invocation for a specific role
 */
export function getLatestInvocation(
  db: Database.Database,
  taskId: string,
  role: 'coder' | 'reviewer'
): TaskInvocation | null {
  return db
    .prepare(
      `SELECT * FROM task_invocations
       WHERE task_id = ? AND role = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId, role) as TaskInvocation | null;
}

/**
 * Get invocation count for a task
 */
export function getInvocationCount(
  db: Database.Database,
  taskId: string
): { coder: number; reviewer: number; total: number } {
  const rows = db
    .prepare(
      `SELECT role, COUNT(*) as count
       FROM task_invocations
       WHERE task_id = ?
       GROUP BY role`
    )
    .all(taskId) as Array<{ role: string; count: number }>;

  const counts = { coder: 0, reviewer: 0, total: 0 };
  for (const row of rows) {
    if (row.role === 'coder') counts.coder = row.count;
    if (row.role === 'reviewer') counts.reviewer = row.count;
    counts.total += row.count;
  }
  return counts;
}

/**
 * Find a resumable session for a task and role
 */
export function findResumableSession(
  db: Database.Database,
  taskId: string,
  role: 'coder' | 'reviewer',
  provider: string,
  model: string,
  ttlMinutes: number = 30
): string | null {
  const row = db.prepare(
    `SELECT session_id, created_at
     FROM task_invocations
     WHERE task_id = ? AND role = ? AND provider = ? AND model = ?
       AND success = 1 AND session_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`
  ).get(taskId, role, provider, model) as { session_id: string; created_at: string } | undefined;

  if (!row) return null;

  // Check TTL
  const createdAt = new Date(row.created_at).getTime();
  const now = Date.now();
  if (now - createdAt > ttlMinutes * 60 * 1000) {
    return null;
  }

  return row.session_id;
}

/**
 * Invalidate a resumable session by clearing session_id on the invocations.
 * Called when a session resume returns empty output, indicating the session is dead.
 */
export function invalidateSession(
  db: Database.Database,
  sessionId: string
): void {
  db.prepare(
    `UPDATE task_invocations SET session_id = NULL WHERE session_id = ?`
  ).run(sessionId);
}

/**
 * Get the chain depth of a follow-up task
 */
export function getFollowUpDepth(db: Database.Database, taskId: string): number {
  let depth = 0;
  let currentId: string | null = taskId;

  while (currentId) {
    const row = db.prepare('SELECT reference_task_id, is_follow_up FROM tasks WHERE id = ?').get(currentId) as { reference_task_id: string | null, is_follow_up: number } | undefined;
    if (!row || !row.is_follow_up) break;
    currentId = row.reference_task_id;
    depth++;
    if (depth > 10) break; // Safety limit
  }

  return depth;
}

/**
 * Generate a deduplication key for a follow-up task
 */
export function generateDedupeKey(title: string, referenceTaskId: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3)
    .sort()
    .join('-');

  return `${referenceTaskId}:${normalized}`;
}

/**
 * Create a follow-up task
 */
export function createFollowUpTask(
  db: Database.Database,
  params: {
    title: string;
    description: string;
    sectionId: string | null;
    referenceTaskId: string;
    referenceCommit?: string;
    requiresPromotion: boolean;
    depth: number;
  }
): string {
  const id = uuidv4();
  const dedupeKey = generateDedupeKey(params.title, params.referenceTaskId);

  try {
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, status, section_id,
        reference_task_id, reference_commit, is_follow_up,
        requires_promotion, follow_up_depth, dedupe_key
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      id,
      params.title,
      params.description,
      params.sectionId,
      params.referenceTaskId,
      params.referenceCommit ?? null,
      params.requiresPromotion ? 1 : 0,
      params.depth,
      dedupeKey
    );

    addAuditEntry(db, id, null, 'pending', 'system:reviewer', {
      notes: `Follow-up task created from ${params.referenceTaskId}${params.requiresPromotion ? ' (requires promotion)' : ''}`,
      actorType: 'orchestrator'
    });

    return id;
  } catch (error: any) {
    if (error.message?.includes('UNIQUE constraint')) {
      // Find existing task
      const existing = db.prepare('SELECT id FROM tasks WHERE dedupe_key = ?').get(dedupeKey) as { id: string };
      return existing.id;
    }
    throw error;
  }
}

/**
 * Promote a deferred follow-up task to active status
 */
export function promoteTask(db: Database.Database, taskId: string, actor: string): void {
  db.prepare(
    "UPDATE tasks SET requires_promotion = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(taskId);

  addAuditEntry(db, taskId, 'pending', 'pending', actor, 'Task promoted (auto-implementation enabled)');
}

// ============ Credit Exhaustion Incidents ============

export interface CreditExhaustionDetails {
  provider: string;
  model: string;
  role: 'orchestrator' | 'coder' | 'reviewer';
  message: string;
}

export type CreditIncidentResolution = 'config_changed' | 'dismissed' | 'manual' | 'retry';

export interface CreditIncident {
  id: string;
  provider: string;
  model: string;
  role: string;
  created_at: string;
}

/**
 * Record a credit_exhaustion incident, with deduplication.
 * If an unresolved incident already exists for the same runner+role+provider+model,
 * returns the existing incident ID instead of inserting a duplicate.
 */
export function recordCreditIncident(
  db: Database.Database,
  details: CreditExhaustionDetails,
  runnerId?: string,
  taskId?: string
): string {
  const detailsJson = JSON.stringify(details);

  // Deduplication: check for existing unresolved incident with same runner+role+provider+model
  const existing = db.prepare(
    `SELECT id FROM incidents
     WHERE failure_mode = 'credit_exhaustion'
       AND resolved_at IS NULL
       AND runner_id IS ?
       AND json_extract(details, '$.role') = ?
       AND json_extract(details, '$.provider') = ?
       AND json_extract(details, '$.model') = ?
     LIMIT 1`
  ).get(runnerId ?? null, details.role, details.provider, details.model) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = uuidv4();
  db.prepare(
    `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, details)
     VALUES (?, ?, ?, 'credit_exhaustion', datetime('now'), ?)`
  ).run(id, taskId ?? null, runnerId ?? null, detailsJson);
  return id;
}

/** Base SELECT for credit incident queries. */
const CREDIT_INCIDENT_SELECT = `SELECT id,
  json_extract(details, '$.provider') as provider,
  json_extract(details, '$.model') as model,
  json_extract(details, '$.role') as role,
  created_at
FROM incidents
WHERE failure_mode = 'credit_exhaustion' AND resolved_at IS NULL`;

/**
 * Query unresolved credit_exhaustion incidents.
 * Optionally filter by project path (requires globalDb with runners table).
 */
export function getActiveCreditIncidents(
  db: Database.Database,
  projectPath?: string,
  globalDb?: Database.Database
): CreditIncident[] {
  if (!projectPath || !globalDb) {
    return db.prepare(`${CREDIT_INCIDENT_SELECT} ORDER BY created_at DESC`).all() as CreditIncident[];
  }

  const runnerIds = globalDb.prepare(
    `SELECT id FROM runners WHERE project_path = ?`
  ).all(projectPath) as Array<{ id: string }>;
  if (runnerIds.length === 0) return [];

  const placeholders = runnerIds.map(() => '?').join(',');
  return db.prepare(
    `${CREDIT_INCIDENT_SELECT} AND runner_id IN (${placeholders}) ORDER BY created_at DESC`
  ).all(...runnerIds.map(r => r.id)) as CreditIncident[];
}

/**
 * Resolve a credit_exhaustion incident.
 */
export function resolveCreditIncident(
  db: Database.Database,
  incidentId: string,
  resolution: CreditIncidentResolution
): void {
  db.prepare(
    `UPDATE incidents SET resolved_at = datetime('now'), resolution = ? WHERE id = ?`
  ).run(resolution, incidentId);
}

// ============ Workspace Pool Task Operations ============

/**
 * Increment the conflict_count for a task and return the new value.
 */
export function incrementTaskConflictCount(db: Database.Database, taskId: string): number {
  db.prepare(
    `UPDATE tasks
     SET conflict_count = COALESCE(conflict_count, 0) + 1,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);

  const row = db
    .prepare('SELECT conflict_count FROM tasks WHERE id = ?')
    .get(taskId) as { conflict_count: number | null } | undefined;

  return Number(row?.conflict_count ?? 0);
}

export function incrementMergeFailureCount(db: Database.Database, taskId: string): number {
  db.prepare(
    `UPDATE tasks
     SET merge_failure_count = COALESCE(merge_failure_count, 0) + 1,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);

  const row = db
    .prepare('SELECT merge_failure_count FROM tasks WHERE id = ?')
    .get(taskId) as { merge_failure_count: number | null } | undefined;

  return Number(row?.merge_failure_count ?? 0);
}

export function clearMergeFailureCount(db: Database.Database, taskId: string): void {
  db.prepare(
    `UPDATE tasks
     SET merge_failure_count = 0,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);
}

/**
 * Mark a task as blocked with a reason.
 */
export function setTaskBlocked(
  db: Database.Database,
  taskId: string,
  status: 'blocked_error' | 'blocked_conflict',
  reason: string,
  actor: string = 'orchestrator'
): void {
  const task = getTask(db, taskId);
  if (!task) return;

  db.prepare(
    `UPDATE tasks
     SET status = ?, blocked_reason = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(status, reason, taskId);

  addAuditEntry(db, taskId, task.status, status, actor, reason);
}

/**
 * Return a task to pending status, clearing blocked state.
 */
export function returnTaskToPending(
  db: Database.Database,
  taskId: string,
  actor: string = 'orchestrator',
  notes?: string
): void {
  const task = getTask(db, taskId);
  if (!task) return;

  db.prepare(
    `UPDATE tasks
     SET status = 'pending', blocked_reason = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);

  addAuditEntry(db, taskId, task.status, 'pending', actor, notes ?? 'Returned to pending for retry');
}
