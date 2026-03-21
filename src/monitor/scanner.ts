/**
 * Deterministic health scanner for all registered projects.
 *
 * Produces a structured anomaly list by:
 * 1. Reusing detectStuckTasks() for runner/task health (no duplication)
 * 2. Querying failed/skipped tasks, high invocations, repeated failures
 * 3. Detecting idle projects (pending work, no active runner)
 *
 * Design constraints:
 * - FAST (< 2s across many projects): read-only DB access, no heavy imports
 * - Graceful: missing/corrupt project DBs are skipped with a warning
 */

import Database from 'better-sqlite3';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectStuckTasks,
  type StuckTaskDetectionReport,
} from '../health/stuck-task-detector.js';
import {
  openGlobalDatabase,
  type GlobalDatabaseConnection,
} from '../runners/global-db-connection.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Anomaly {
  type:
    | 'orphaned_task'
    | 'hanging_invocation'
    | 'zombie_runner'
    | 'dead_runner'
    | 'db_inconsistency'
    | 'credit_exhaustion'
    | 'failed_task'
    | 'skipped_task'
    | 'idle_project'
    | 'high_invocations'
    | 'repeated_failures';
  severity: 'info' | 'warning' | 'critical';
  projectPath: string;
  projectName: string;
  taskId?: string;
  taskTitle?: string;
  runnerId?: string;
  details: string;
  context: Record<string, unknown>;
}

export interface ScanResult {
  timestamp: number; // epoch ms
  projectCount: number;
  anomalies: Anomaly[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default invocation cap — matches config default in loader.ts */
const DEFAULT_MAX_INVOCATIONS = 150;

/** Warn when invocations reach this fraction of the cap */
const HIGH_INVOCATION_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectDbPath(projectPath: string): string {
  return join(projectPath, '.steroids', 'steroids.db');
}

function openProjectDbReadOnly(projectPath: string): Database.Database | null {
  const dbPath = projectDbPath(projectPath);
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 1000');
    return db;
  } catch {
    return null;
  }
}

function hasActiveRunner(globalDb: Database.Database, projectPath: string): boolean {
  const row = globalDb
    .prepare(
      `SELECT 1 FROM runners
       WHERE project_path = ?
         AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes')`
    )
    .get(projectPath) as { 1: number } | undefined;
  return row !== undefined;
}

function hasPendingWork(projectDb: Database.Database): boolean {
  const row = projectDb
    .prepare(
      `SELECT COUNT(*) as count FROM tasks
       WHERE status IN ('pending', 'in_progress', 'review')`
    )
    .get() as { count: number };
  return row.count > 0;
}

// ---------------------------------------------------------------------------
// Mapping stuck-task signals to Anomaly
// ---------------------------------------------------------------------------

function mapStuckReport(
  report: StuckTaskDetectionReport,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const s of report.orphanedTasks) {
    anomalies.push({
      type: 'orphaned_task',
      severity: 'critical',
      projectPath,
      projectName,
      taskId: s.taskId,
      taskTitle: s.title,
      details: `Task "${s.title}" orphaned for ${s.secondsSinceUpdate}s with no active runner`,
      context: {
        status: s.status,
        secondsSinceUpdate: s.secondsSinceUpdate,
        invocationCount: s.invocationCount,
        lastInvocationAt: s.lastInvocationAt?.toISOString() ?? null,
      },
    });
  }

  for (const s of report.hangingInvocations) {
    anomalies.push({
      type: 'hanging_invocation',
      severity: 'critical',
      projectPath,
      projectName,
      taskId: s.taskId,
      taskTitle: s.title,
      runnerId: s.runnerId,
      details: `${s.phase} hanging for ${s.secondsSinceUpdate}s on runner ${s.runnerId}`,
      context: {
        phase: s.phase,
        status: s.status,
        secondsSinceUpdate: s.secondsSinceUpdate,
        secondsSinceActivity: s.secondsSinceActivity,
        runnerPid: s.runnerPid,
      },
    });
  }

  for (const s of report.zombieRunners) {
    anomalies.push({
      type: 'zombie_runner',
      severity: 'critical',
      projectPath,
      projectName,
      runnerId: s.runnerId,
      taskId: s.currentTaskId ?? undefined,
      details: `Zombie runner ${s.runnerId} (pid ${s.pid}) — heartbeat stale ${s.secondsSinceHeartbeat}s`,
      context: {
        pid: s.pid,
        secondsSinceHeartbeat: s.secondsSinceHeartbeat,
      },
    });
  }

  for (const s of report.deadRunners) {
    anomalies.push({
      type: 'dead_runner',
      severity: 'critical',
      projectPath,
      projectName,
      runnerId: s.runnerId,
      taskId: s.currentTaskId ?? undefined,
      details: `Dead runner ${s.runnerId} (pid ${s.pid}) — process not alive`,
      context: {
        pid: s.pid,
        secondsSinceHeartbeat: s.secondsSinceHeartbeat,
      },
    });
  }

  for (const s of report.dbInconsistencies) {
    anomalies.push({
      type: 'db_inconsistency',
      severity: 'info',
      projectPath,
      projectName,
      taskId: s.taskId,
      taskTitle: s.title,
      details: `Task "${s.title}" in_progress with 0 invocations (transient or inconsistent)`,
      context: {
        secondsSinceUpdate: s.secondsSinceUpdate,
      },
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Project-level scans (task health queries)
// ---------------------------------------------------------------------------

interface FailedSkippedRow {
  id: string;
  title: string;
  status: string;
}

function scanFailedAndSkippedTasks(
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
    severity: 'warning' as const,
    projectPath,
    projectName,
    taskId: row.id,
    taskTitle: row.title,
    details: `Task "${row.title}" is ${row.status}`,
    context: { status: row.status },
  }));
}

interface HighInvocationRow {
  id: string;
  title: string;
  invocation_count: number;
}

function scanHighInvocations(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
  maxInvocations: number,
): Anomaly[] {
  const threshold = Math.floor(maxInvocations * HIGH_INVOCATION_THRESHOLD);
  if (threshold <= 0) return [];

  const rows = projectDb
    .prepare(
      `SELECT t.id, t.title, COUNT(i.id) as invocation_count
       FROM tasks t
       JOIN task_invocations i ON i.task_id = t.id
       WHERE t.status NOT IN ('completed', 'skipped', 'failed')
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

interface RepeatedFailureRow {
  id: string;
  title: string;
  failure_count: number;
  rejection_count: number;
}

function scanRepeatedFailures(
  projectDb: Database.Database,
  projectPath: string,
  projectName: string,
): Anomaly[] {
  const rows = projectDb
    .prepare(
      `SELECT id, title, failure_count, rejection_count
       FROM tasks
       WHERE status NOT IN ('completed', 'skipped', 'failed')
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
// Public API
// ---------------------------------------------------------------------------

export async function runScan(): Promise<ScanResult> {
  const timestamp = Date.now();
  const anomalies: Anomaly[] = [];

  let globalConn: GlobalDatabaseConnection | null = null;
  try {
    globalConn = openGlobalDatabase();
  } catch {
    return {
      timestamp,
      projectCount: 0,
      anomalies: [],
      summary: 'Could not open global database',
    };
  }

  const globalDb = globalConn.db;

  let projects: Array<{ path: string; name: string | null }>;
  try {
    projects = globalDb
      .prepare('SELECT path, name FROM projects WHERE enabled = 1')
      .all() as Array<{ path: string; name: string | null }>;
  } catch {
    globalConn.close();
    return {
      timestamp,
      projectCount: 0,
      anomalies: [],
      summary: 'Could not query projects table',
    };
  }

  for (const project of projects) {
    const projectPath = project.path;
    const projectName = project.name ?? basename(projectPath);

    const projectDb = openProjectDbReadOnly(projectPath);
    if (!projectDb) {
      // Missing DB — not necessarily an error (project may have been removed)
      continue;
    }

    try {
      // 1. Stuck-task detection (reuse existing logic)
      const stuckReport = detectStuckTasks({
        projectPath,
        projectDb,
        globalDb,
      });
      anomalies.push(...mapStuckReport(stuckReport, projectPath, projectName));

      // 2. Failed/skipped tasks
      anomalies.push(...scanFailedAndSkippedTasks(projectDb, projectPath, projectName));

      // 3. High invocation tasks
      anomalies.push(
        ...scanHighInvocations(projectDb, projectPath, projectName, DEFAULT_MAX_INVOCATIONS)
      );

      // 4. Repeated failures
      anomalies.push(...scanRepeatedFailures(projectDb, projectPath, projectName));

      // 5. Idle project check
      if (hasPendingWork(projectDb) && !hasActiveRunner(globalDb, projectPath)) {
        anomalies.push({
          type: 'idle_project',
          severity: 'info',
          projectPath,
          projectName,
          details: `Project "${projectName}" has pending work but no active runner`,
          context: {},
        });
      }
    } catch {
      // Gracefully skip projects with corrupt or incompatible DBs
    } finally {
      try {
        projectDb.close();
      } catch {
        // ignore close errors
      }
    }
  }

  globalConn.close();

  // Build summary
  const critical = anomalies.filter((a) => a.severity === 'critical').length;
  const warning = anomalies.filter((a) => a.severity === 'warning').length;
  const info = anomalies.filter((a) => a.severity === 'info').length;

  const parts: string[] = [];
  parts.push(`Scanned ${projects.length} project(s)`);
  if (anomalies.length === 0) {
    parts.push('no anomalies detected');
  } else {
    const counts: string[] = [];
    if (critical > 0) counts.push(`${critical} critical`);
    if (warning > 0) counts.push(`${warning} warning`);
    if (info > 0) counts.push(`${info} info`);
    parts.push(counts.join(', '));
  }

  return {
    timestamp,
    projectCount: projects.length,
    anomalies,
    summary: parts.join(' — '),
  };
}
