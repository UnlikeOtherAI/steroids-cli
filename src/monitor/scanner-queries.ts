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
