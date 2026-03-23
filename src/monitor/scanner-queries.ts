/**
 * Project-level scan queries for the monitor scanner.
 * Extracted from scanner.ts to keep file sizes under 500 lines.
 */

import Database from 'better-sqlite3';
import type { Anomaly } from './scanner.js';

// ---------------------------------------------------------------------------
// Failed / Skipped tasks
// ---------------------------------------------------------------------------

interface FailedSkippedRow {
  id: string;
  title: string;
  status: string;
}

export function scanFailedAndSkippedTasks(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const rows = projectDb
    .prepare(
      `SELECT id, title, status FROM tasks WHERE status IN ('failed', 'skipped')`
    )
    .all() as FailedSkippedRow[];

  return rows.map((row) => ({
    type: (row.status === 'failed' ? 'failed_task' : 'skipped_task') as Anomaly['type'],
    severity: 'info' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: `Task "${row.title}" is ${row.status}`,
    context: { status: row.status },
  }));
}

// ---------------------------------------------------------------------------
// High invocation tasks
// ---------------------------------------------------------------------------

interface HighInvocationRow {
  id: string;
  title: string;
  invocation_count: number;
}

export function scanHighInvocations(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
  maxInvocations: number,
  highInvocationThreshold: number,
): Anomaly[] {
  const threshold = Math.floor(maxInvocations * highInvocationThreshold);
  if (threshold <= 0) return [];

  const rows = projectDb
    .prepare(
      `SELECT t.id, t.title, COUNT(i.id) as invocation_count
       FROM tasks t
       JOIN task_invocations i ON i.task_id = t.id
       WHERE t.status NOT IN ('completed', 'skipped', 'failed', 'blocked_conflict', 'blocked_error')
       GROUP BY t.id
       HAVING invocation_count >= ?`
    )
    .all(threshold) as HighInvocationRow[];

  return rows.map((row) => ({
    type: 'high_invocations' as const,
    severity: 'warning' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: `Task "${row.title}" has ${row.invocation_count}/${maxInvocations} invocations`,
    context: {
      invocationCount: row.invocation_count,
      maxInvocations,
      threshold,
    },
  }));
}

// ---------------------------------------------------------------------------
// Repeated failures
// ---------------------------------------------------------------------------

interface RepeatedFailureRow {
  id: string;
  title: string;
  failure_count: number;
  rejection_count: number;
}

export function scanRepeatedFailures(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const rows = projectDb
    .prepare(
      `SELECT id, title, failure_count, rejection_count
       FROM tasks
       WHERE status NOT IN ('completed', 'skipped', 'failed', 'blocked_conflict', 'blocked_error')
         AND (failure_count >= 2 OR rejection_count >= 5)`
    )
    .all() as RepeatedFailureRow[];

  return rows.map((row) => ({
    type: 'repeated_failures' as const,
    severity: 'warning' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: `Task "${row.title}" has ${row.failure_count} failures, ${row.rejection_count} rejections`,
    context: {
      failureCount: row.failure_count,
      rejectionCount: row.rejection_count,
    },
  }));
}

// ---------------------------------------------------------------------------
// Blocked tasks
// ---------------------------------------------------------------------------

interface BlockedTaskRow {
  id: string;
  title: string;
  status: string;
}

export function scanBlockedTasks(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const rows = projectDb
    .prepare(
      `SELECT id, title, status FROM tasks WHERE status IN ('blocked_conflict', 'blocked_error')`
    )
    .all() as BlockedTaskRow[];

  return rows.map((row) => ({
    type: 'blocked_task' as const,
    severity: 'critical' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: row.status === 'blocked_conflict'
      ? `Task "${row.title}" blocked by merge conflict — needs reset or manual resolution`
      : `Task "${row.title}" blocked by error — needs reset`,
    context: { status: row.status },
  }));
}

// ---------------------------------------------------------------------------
// Stuck merge phase
// ---------------------------------------------------------------------------

interface StuckMergeRow {
  id: string;
  title: string;
  merge_phase: string;
  updated_at: string;
}

export function scanStuckMergePhase(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const rows = projectDb
    .prepare(
      `SELECT id, title, merge_phase, updated_at FROM tasks
       WHERE status = 'merge_pending' AND merge_phase IS NOT NULL
         AND (
           (merge_phase = 'queued' AND updated_at < datetime('now', '-15 minutes'))
           OR (merge_phase IN ('rebasing', 'rebase_review') AND updated_at < datetime('now', '-90 minutes'))
         )`
    )
    .all() as StuckMergeRow[];

  return rows.map((row) => ({
    type: 'stuck_merge_phase' as const,
    severity: 'warning' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: `Task "${row.title}" stuck in merge phase '${row.merge_phase}'`,
    context: { mergePhase: row.merge_phase, updatedAt: row.updated_at },
  }));
}

// ---------------------------------------------------------------------------
// Disputed tasks
// ---------------------------------------------------------------------------

interface DisputedTaskRow {
  id: string;
  title: string;
}

export function scanDisputedTasks(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const rows = projectDb
    .prepare(`SELECT id, title FROM tasks WHERE status = 'disputed'`)
    .all() as DisputedTaskRow[];

  return rows.map((row) => ({
    type: 'disputed_task' as const,
    severity: 'warning' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: `Task "${row.title}" is disputed — needs manual resolution`,
    context: {},
  }));
}

// ---------------------------------------------------------------------------
// Stale merge locks (global DB query)
// ---------------------------------------------------------------------------

interface StaleMergeLockRow {
  project_id: string;
  runner_id: string;
  acquired_at: number;
  heartbeat_at: number;
}

export function scanStaleMergeLocks(
  globalDb: Database.Database,
  projectPath: string,
  projectName: string,
  projectId: string,
): Anomaly[] {
  const staleCutoffMs = Date.now() - 5 * 60_000; // 5 minutes
  const row = globalDb
    .prepare(
      `SELECT project_id, runner_id, acquired_at, heartbeat_at
       FROM workspace_merge_locks
       WHERE project_id = ? AND heartbeat_at < ?`
    )
    .get(projectId, staleCutoffMs) as StaleMergeLockRow | undefined;

  if (!row) return [];

  const ageMinutes = Math.round((Date.now() - row.heartbeat_at) / 60_000);
  return [{
    type: 'stale_merge_lock' as const,
    severity: 'warning' as const,
    projectPath,
    projectName,
    details: `Merge lock held for ${ageMinutes}m without heartbeat (runner: ${row.runner_id})`,
    context: { runnerId: row.runner_id, acquiredAt: row.acquired_at, heartbeatAt: row.heartbeat_at },
  }];
}
