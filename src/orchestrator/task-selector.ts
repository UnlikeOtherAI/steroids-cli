/**
 * Task selection algorithm with locking integration
 * Following ORCHESTRATOR.md specification
 */

import type Database from 'better-sqlite3';
import { findNextTask, getTask, updateTaskStatus, getLastRejectionNotes } from '../database/queries.js';
import type { Task } from '../database/queries.js';
import {
  acquireTaskLock,
  releaseTaskLock,
  isTaskLocked,
  createHeartbeatLoop,
  type LockAcquisitionResult,
  type LockReleaseResult,
  type HeartbeatHandle,
} from '../locking/task-lock.js';
import {
  acquireSectionLock,
  releaseSectionLock,
  isSectionLocked,
} from '../locking/section-lock.js';
import { listTaskLocks } from '../locking/queries.js';

export interface SelectedTask {
  task: Task;
  action: 'review' | 'resume' | 'start';
  rejectionNotes?: string;
}

export interface SelectedTaskWithLock extends SelectedTask {
  lockResult: LockAcquisitionResult;
  heartbeat?: HeartbeatHandle;
}

export interface TaskSelectionOptions {
  runnerId: string;
  timeoutMinutes?: number;
  noWait?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  sectionId?: string;  // NEW: Focus on this section only
}

/**
 * Select the next task to work on
 *
 * Priority order:
 * 1. Tasks in 'review' status (complete review loop first)
 * 2. Tasks in 'in_progress' status (resume incomplete work)
 * 3. Tasks in 'pending' status (start new work)
 *
 * Within each priority, tasks are ordered by:
 * - Section position (lower first)
 * - Creation time (older first)
 */
export function selectNextTask(
  db: Database.Database,
  sectionId?: string
): SelectedTask | null {
  const result = findNextTask(db, sectionId);

  if (!result.task || result.action === 'idle') {
    return null;
  }

  const selectedTask: SelectedTask = {
    task: result.task,
    action: result.action as 'review' | 'resume' | 'start',
  };

  // If resuming after rejection, get the last rejection notes
  if (result.action === 'resume' && result.task.rejection_count > 0) {
    selectedTask.rejectionNotes = getLastRejectionNotes(db, result.task.id) ?? undefined;
  }

  return selectedTask;
}

/**
 * Mark a task as in_progress when starting
 */
export function markTaskInProgress(db: Database.Database, taskId: string): void {
  const task = getTask(db, taskId);
  if (!task) return;

  if (task.status === 'pending') {
    updateTaskStatus(db, taskId, 'in_progress', 'orchestrator');
  }
}

/**
 * Check if all tasks are completed
 */
export function areAllTasksComplete(db: Database.Database, sectionId?: string): boolean {
  const result = findNextTask(db, sectionId);
  return result.action === 'idle';
}

/**
 * Count tasks by status
 */
export function getTaskCounts(
  db: Database.Database,
  sectionId?: string
): {
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
  disputed: number;
  failed: number;
  total: number;
} {
  const counts = {
    pending: 0,
    in_progress: 0,
    review: 0,
    completed: 0,
    disputed: 0,
    failed: 0,
    total: 0,
  };

  let query = 'SELECT status, COUNT(*) as count FROM tasks';
  const params: string[] = [];

  if (sectionId) {
    query += ' WHERE section_id = ?';
    params.push(sectionId);
  }

  query += ' GROUP BY status';

  const rows = db.prepare(query).all(...params) as { status: string; count: number }[];

  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
    counts.total += row.count;
  }

  return counts;
}

// ============ Locking Integration ============

const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000; // 5 seconds

/**
 * Select the next task and acquire a lock on it
 * Skips tasks that are already locked by other runners
 */
export function selectNextTaskWithLock(
  db: Database.Database,
  options: TaskSelectionOptions
): SelectedTaskWithLock | null {
  const {
    runnerId,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  } = options;

  // Get all currently locked task IDs
  const lockedTaskIds = new Set(listTaskLocks(db).map(lock => lock.task_id));

  // Find next available task that is not locked
  const candidates = findNextTaskSkippingLocked(db, lockedTaskIds, runnerId, options.sectionId);

  if (!candidates) {
    return null;
  }

  // Try to acquire lock
  const lockResult = acquireTaskLock(db, candidates.task.id, runnerId, timeoutMinutes);

  if (!lockResult.acquired) {
    // Lock acquisition failed (race condition)
    // Try again with updated lock list
    return selectNextTaskWithLock(db, options);
  }

  // Create heartbeat loop for the lock
  const heartbeat = createHeartbeatLoop(db, candidates.task.id, runnerId);

  return {
    task: candidates.task,
    action: candidates.action,
    rejectionNotes: candidates.rejectionNotes,
    lockResult,
    heartbeat,
  };
}

/**
 * Find next task, skipping locked ones
 */
function findNextTaskSkippingLocked(
  db: Database.Database,
  lockedTaskIds: Set<string>,
  runnerId: string,
  sectionId?: string
): SelectedTask | null {
  // Build WHERE clause for section filtering
  const sectionFilter = sectionId ? 'AND t.section_id = ?' : '';
  const sectionParams = sectionId ? [sectionId] : [];

  // Priority 1: Tasks in 'review' status
  const reviewTasks = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'review' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at`
    )
    .all(...sectionParams) as Task[];

  for (const task of reviewTasks) {
    if (!lockedTaskIds.has(task.id) || isLockedByUs(db, task.id, runnerId)) {
      return { task, action: 'review' };
    }
  }

  // Priority 2: Tasks in 'in_progress' status
  const inProgressTasks = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN sections s ON t.section_id = s.id
       WHERE t.status = 'in_progress' ${sectionFilter}
       ORDER BY COALESCE(s.position, 999999), t.created_at`
    )
    .all(...sectionParams) as Task[];

  for (const task of inProgressTasks) {
    if (!lockedTaskIds.has(task.id) || isLockedByUs(db, task.id, runnerId)) {
      const rejectionNotes = task.rejection_count > 0
        ? getLastRejectionNotes(db, task.id) ?? undefined
        : undefined;
      return { task, action: 'resume', rejectionNotes };
    }
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

  for (const task of pendingTasks) {
    if (!lockedTaskIds.has(task.id) || isLockedByUs(db, task.id, runnerId)) {
      return { task, action: 'start' };
    }
  }

  return null;
}

/**
 * Check if a task is locked by the current runner
 */
function isLockedByUs(db: Database.Database, taskId: string, runnerId: string): boolean {
  const locks = listTaskLocks(db);
  const lock = locks.find(l => l.task_id === taskId);
  return lock?.runner_id === runnerId;
}

/**
 * Select next task with wait behavior
 * Waits for a locked task if no unlocked tasks are available
 */
export async function selectNextTaskWithWait(
  db: Database.Database,
  options: TaskSelectionOptions
): Promise<SelectedTaskWithLock | null> {
  const {
    noWait = false,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  // First try without waiting
  const result = selectNextTaskWithLock(db, options);
  if (result) {
    return result;
  }

  // Check if there are any tasks at all
  const counts = getTaskCounts(db);
  if (counts.pending === 0 && counts.in_progress === 0 && counts.review === 0) {
    return null; // All tasks completed
  }

  // If noWait, return null immediately
  if (noWait) {
    return null;
  }

  // Wait for a task to become available
  const startTime = Date.now();

  while (Date.now() - startTime < waitTimeoutMs) {
    await sleep(pollIntervalMs);

    const nextResult = selectNextTaskWithLock(db, options);
    if (nextResult) {
      return nextResult;
    }

    // Check if all remaining tasks are locked
    const currentCounts = getTaskCounts(db);
    if (currentCounts.pending === 0 &&
        currentCounts.in_progress === 0 &&
        currentCounts.review === 0) {
      return null; // All tasks completed while waiting
    }
  }

  // Timeout reached
  return null;
}

/**
 * Release task lock after completion
 */
export function releaseTaskLockAfterCompletion(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  heartbeat?: HeartbeatHandle
): LockReleaseResult {
  // Stop heartbeat if running
  if (heartbeat) {
    heartbeat.stop();
  }

  return releaseTaskLock(db, taskId, runnerId);
}

/**
 * Mark task in progress and acquire lock
 */
export function startTaskWithLock(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  timeoutMinutes: number = DEFAULT_TIMEOUT_MINUTES
): { success: boolean; heartbeat?: HeartbeatHandle; error?: string } {
  const task = getTask(db, taskId);
  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  // Try to acquire lock
  const lockResult = acquireTaskLock(db, taskId, runnerId, timeoutMinutes);
  if (!lockResult.acquired) {
    return {
      success: false,
      error: lockResult.error?.message ?? 'Failed to acquire lock',
    };
  }

  // Mark as in progress if pending
  if (task.status === 'pending') {
    updateTaskStatus(db, taskId, 'in_progress', 'orchestrator');
  }

  // Start heartbeat
  const heartbeat = createHeartbeatLoop(db, taskId, runnerId);
  heartbeat.start();

  return { success: true, heartbeat };
}

/**
 * Complete task and release lock
 */
export function completeTaskWithLock(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  newStatus: 'review' | 'completed',
  heartbeat?: HeartbeatHandle
): { success: boolean; error?: string } {
  const task = getTask(db, taskId);
  if (!task) {
    if (heartbeat) heartbeat.stop();
    return { success: false, error: 'Task not found' };
  }

  // Update status
  updateTaskStatus(db, taskId, newStatus, 'orchestrator');

  // Release lock
  const releaseResult = releaseTaskLockAfterCompletion(db, taskId, runnerId, heartbeat);

  if (!releaseResult.released && releaseResult.error?.code !== 'LOCK_NOT_FOUND') {
    return {
      success: false,
      error: releaseResult.error?.message ?? 'Failed to release lock',
    };
  }

  return { success: true };
}

// ============ Helpers ============

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ Re-exports for convenience ============

export {
  isTaskLocked,
  isSectionLocked,
  acquireSectionLock,
  releaseSectionLock,
};
