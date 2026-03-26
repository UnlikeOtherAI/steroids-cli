import { Router, Request, Response } from 'express';
import { join } from 'node:path';
import { getRegisteredProject } from '../../../dist/runners/projects.js';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';
import { hasActiveParallelSessionForProjectDb } from '../../../dist/runners/parallel-session-state.js';
import { PROJECT_RESETTABLE_STATUSES } from '../../../src/tasks/resettable-statuses.js';
import { selectLatestLiveRunningInvocation } from '../utils/task-invocation-liveness.js';
import { isValidProjectPath } from '../utils/validation.js';
import { openSqliteForRead } from '../utils/sqlite.js';

const router = Router();

type ResetReasonCounts = {
  failed: number;
  disputed: number;
  blocked_error: number;
  blocked_conflict: number;
  orphaned_in_progress: number;
};

type LastActiveTaskSummary = {
  id: string;
  title: string;
  status: string;
  role: string | null;
  last_activity_at: string;
  dependent_task_count: number;
};

type ProjectRecoverySummary = {
  can_reset_project: boolean;
  reset_reason_counts: ResetReasonCounts;
  last_active_task: LastActiveTaskSummary | null;
};

type InvocationSummaryRow = {
  invocation_id: number;
  id: string;
  task_id: string;
  title: string;
  status: string;
  role: string | null;
  activity_ms: number | null;
  runner_id: string | null;
  dependent_task_count: number;
};

type RunnerFallbackRow = {
  current_task_id: string;
  heartbeat_at: string | null;
};

type TaskFallbackRow = {
  id: string;
  title: string;
  status: string;
  dependent_task_count: number;
};

function toIsoString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value).toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withTimezone = /[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = new Date(withTimezone);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readLastActiveTask(
  projectPath: string,
  globalDb: ReturnType<typeof openGlobalDatabase>['db'],
): LastActiveTaskSummary | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  const projectDb = openSqliteForRead(dbPath, { timeoutMs: 500 });
  try {
    const runningRows = projectDb.prepare(
      `SELECT
         ti.id AS invocation_id,
         t.id,
         ti.task_id,
         t.title,
         t.status,
         ti.role,
         ti.runner_id,
         COALESCE(ti.last_activity_at_ms, ti.started_at_ms) AS activity_ms,
         (
           SELECT COUNT(*)
           FROM task_dependencies td
           WHERE td.depends_on_task_id = t.id
         ) AS dependent_task_count
       FROM task_invocations ti
       JOIN tasks t ON t.id = ti.task_id
       WHERE ti.status = 'running'
       ORDER BY COALESCE(ti.last_activity_at_ms, ti.started_at_ms) DESC, ti.id DESC`,
    ).all() as InvocationSummaryRow[];

    const runningRow = selectLatestLiveRunningInvocation(globalDb, projectPath, runningRows);
    if (runningRow) {
      return {
        id: runningRow.id,
        title: runningRow.title,
        status: runningRow.status,
        role: runningRow.role,
        last_activity_at: toIsoString(runningRow.activity_ms) ?? new Date().toISOString(),
        dependent_task_count: runningRow.dependent_task_count ?? 0,
      };
    }

    const finishedRow = projectDb.prepare(
      `SELECT
         t.id,
         t.title,
         t.status,
         ti.role,
         COALESCE(ti.last_activity_at_ms, ti.completed_at_ms, ti.started_at_ms) AS activity_ms,
         (
           SELECT COUNT(*)
           FROM task_dependencies td
           WHERE td.depends_on_task_id = t.id
         ) AS dependent_task_count
       FROM task_invocations ti
       JOIN tasks t ON t.id = ti.task_id
       ORDER BY COALESCE(ti.last_activity_at_ms, ti.completed_at_ms, ti.started_at_ms) DESC, ti.id DESC
       LIMIT 1`
    ).get() as InvocationSummaryRow | undefined;

    if (finishedRow) {
      return {
        id: finishedRow.id,
        title: finishedRow.title,
        status: finishedRow.status,
        role: finishedRow.role,
        last_activity_at: toIsoString(finishedRow.activity_ms) ?? new Date().toISOString(),
        dependent_task_count: finishedRow.dependent_task_count ?? 0,
      };
    }
  } finally {
    projectDb.close();
  }

  const runner = globalDb.prepare(
    `SELECT current_task_id, heartbeat_at
     FROM runners
     WHERE project_path = ?
       AND current_task_id IS NOT NULL
       AND heartbeat_at > datetime('now', '-5 minutes')
     ORDER BY COALESCE(heartbeat_at, started_at) DESC
     LIMIT 1`
  ).get(projectPath) as RunnerFallbackRow | undefined;

  if (!runner?.current_task_id) return null;

  const fallbackDb = openSqliteForRead(dbPath, { timeoutMs: 500 });
  try {
    const task = fallbackDb.prepare(
      `SELECT
         t.id,
         t.title,
         t.status,
         (
           SELECT COUNT(*)
           FROM task_dependencies td
           WHERE td.depends_on_task_id = t.id
         ) AS dependent_task_count
       FROM tasks t
       WHERE t.id = ?
       LIMIT 1`
    ).get(runner.current_task_id) as TaskFallbackRow | undefined;

    if (!task) return null;

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      role: null,
      last_activity_at: toIsoString(runner.heartbeat_at) ?? new Date().toISOString(),
      dependent_task_count: task.dependent_task_count ?? 0,
    };
  } finally {
    fallbackDb.close();
  }
}

function readRecoverySummary(projectPath: string): ProjectRecoverySummary {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  const projectDb = openSqliteForRead(dbPath, { timeoutMs: 500 });
  try {
    const row = projectDb.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END), 0) AS disputed,
         COALESCE(SUM(CASE WHEN status = 'blocked_error' THEN 1 ELSE 0 END), 0) AS blocked_error,
         COALESCE(SUM(CASE WHEN status = 'blocked_conflict' THEN 1 ELSE 0 END), 0) AS blocked_conflict,
         COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress
       FROM tasks`
    ).get() as {
      failed: number;
      disputed: number;
      blocked_error: number;
      blocked_conflict: number;
      in_progress: number;
    };

    const { db: globalDb, close } = openGlobalDatabase();
    try {
      const hasStandaloneRunner = globalDb.prepare(
        `SELECT 1
         FROM runners
         WHERE project_path = ?
           AND status != 'stopped'
           AND heartbeat_at > datetime('now', '-5 minutes')
           AND parallel_session_id IS NULL`
      ).get(projectPath) !== undefined;
      const hasParallelSession = hasActiveParallelSessionForProjectDb(globalDb as never, projectPath);
      const orphanedInProgress = (hasStandaloneRunner || hasParallelSession) ? 0 : (row?.in_progress ?? 0);

      const resetReasonCounts: ResetReasonCounts = {
        failed: row?.failed ?? 0,
        disputed: row?.disputed ?? 0,
        blocked_error: row?.blocked_error ?? 0,
        blocked_conflict: row?.blocked_conflict ?? 0,
        orphaned_in_progress: orphanedInProgress,
      };

      const canResetProject =
        PROJECT_RESETTABLE_STATUSES.some((status: (typeof PROJECT_RESETTABLE_STATUSES)[number]) => resetReasonCounts[status] > 0) ||
        resetReasonCounts.orphaned_in_progress > 0;

      return {
        can_reset_project: canResetProject,
        reset_reason_counts: resetReasonCounts,
        last_active_task: readLastActiveTask(projectPath, globalDb),
      };
    } finally {
      close();
    }
  } finally {
    projectDb.close();
  }
}

router.get('/projects/recovery', (req: Request, res: Response) => {
  try {
    const projectPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Path query parameter is required',
      });
      return;
    }

    if (!isValidProjectPath(projectPath)) {
      res.status(404).json({
        success: false,
        error: 'Project path is invalid or missing steroids.db',
      });
      return;
    }

    const project = getRegisteredProject(projectPath);
    if (!project) {
      res.status(404).json({
        success: false,
        error: 'Project not found in registry',
      });
      return;
    }

    res.json({
      success: true,
      recovery: readRecoverySummary(projectPath),
    });
  } catch (error) {
    console.error('Error getting project recovery summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project recovery summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
