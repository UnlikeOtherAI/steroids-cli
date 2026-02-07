/**
 * Task selection algorithm
 * Following ORCHESTRATOR.md specification
 */

import type Database from 'better-sqlite3';
import { findNextTask, getTask, updateTaskStatus, getLastRejectionNotes } from '../database/queries.js';
import type { Task } from '../database/queries.js';

export interface SelectedTask {
  task: Task;
  action: 'review' | 'resume' | 'start';
  rejectionNotes?: string;
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
export function selectNextTask(db: Database.Database): SelectedTask | null {
  const result = findNextTask(db);

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
export function areAllTasksComplete(db: Database.Database): boolean {
  const result = findNextTask(db);
  return result.action === 'idle';
}

/**
 * Count tasks by status
 */
export function getTaskCounts(db: Database.Database): {
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

  const rows = db
    .prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status')
    .all() as { status: string; count: number }[];

  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
    counts.total += row.count;
  }

  return counts;
}
