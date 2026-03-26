import type Database from 'better-sqlite3';
import { getProjectHash } from '../parallel/clone.js';
import {
  type StaleInvocationRow,
  isRunnerProcessDead,
  recoverOrphanedInvocation,
  shouldSkipInvocation,
} from './wakeup-sanitise-recovery.js';

export interface RuntimeSanitiseSummary {
  recoveredApprovals: number;
  recoveredRejects: number;
  closedStaleInvocations: number;
  releasedTaskLocks: number;
}

export interface RuntimeSanitiseOptions {
  globalDb: Database.Database;
  projectDb: Database.Database;
  projectPath: string;
  dryRun: boolean;
  staleInvocationTimeoutSec: number;
}

export async function reconcileInvocationRuntimeState(
  options: RuntimeSanitiseOptions,
): Promise<RuntimeSanitiseSummary> {
  const { globalDb, projectDb, projectPath, dryRun, staleInvocationTimeoutSec } = options;
  const summary: RuntimeSanitiseSummary = {
    recoveredApprovals: 0,
    recoveredRejects: 0,
    closedStaleInvocations: 0,
    releasedTaskLocks: 0,
  };

  const staleCutoffMs = Date.now() - staleInvocationTimeoutSec * 1000;
  const activeRunnerTaskRows = globalDb
    .prepare(
      `SELECT r.current_task_id, r.parallel_session_id
       FROM runners r
       LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE (r.project_path = ? OR ps.project_path = ?)
         AND r.status = 'running'
         AND r.heartbeat_at > datetime('now', '-5 minutes')
         AND (r.current_task_id IS NOT NULL OR r.parallel_session_id IS NOT NULL)`,
    )
    .all(projectPath, projectPath) as Array<{
      current_task_id: string | null;
      parallel_session_id: string | null;
    }>;

  const activeTaskIds = new Set(
    activeRunnerTaskRows
      .map((row) => row.current_task_id)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
  );
  const hasActiveParallelRunner = activeRunnerTaskRows.some(
    (row) => typeof row.parallel_session_id === 'string' && row.parallel_session_id.length > 0,
  );

  let hasActiveMergeLock = false;
  try {
    const projectId = getProjectHash(projectPath);
    const nowMs = Date.now();
    const mergeLockRows = globalDb
      .prepare('SELECT heartbeat_at FROM workspace_merge_locks WHERE project_id = ?')
      .all(projectId) as Array<{ heartbeat_at: string }>;
    hasActiveMergeLock = mergeLockRows.some((row) => {
      const heartbeatMs = Date.parse(row.heartbeat_at);
      return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs < 90_000;
    });
  } catch {
    hasActiveMergeLock = false;
  }

  const staleInvocations = projectDb
    .prepare(
      `SELECT i.id, i.task_id, i.role, i.started_at_ms, i.runner_id, t.status AS task_status
       FROM task_invocations i
       LEFT JOIN tasks t ON t.id = i.task_id
       WHERE i.status = 'running'
         AND i.started_at_ms IS NOT NULL
         AND i.started_at_ms <= ?
       ORDER BY i.started_at_ms ASC`,
    )
    .all(staleCutoffMs) as Array<StaleInvocationRow>;

  for (const row of staleInvocations) {
    if (shouldSkipInvocation(row, activeTaskIds, hasActiveMergeLock, hasActiveParallelRunner, globalDb)) {
      continue;
    }
    await recoverOrphanedInvocation(projectDb, projectPath, row, dryRun, summary, 'stale timeout');
  }

  const deadRunnerCutoffMs = Date.now() - 120_000;
  const recentRunningInvocations = projectDb
    .prepare(
      `SELECT i.id, i.task_id, i.role, i.started_at_ms, i.runner_id, t.status AS task_status
       FROM task_invocations i
       LEFT JOIN tasks t ON t.id = i.task_id
       WHERE i.status = 'running'
         AND i.started_at_ms IS NOT NULL
         AND i.started_at_ms > ?
         AND i.started_at_ms <= ?
       ORDER BY i.started_at_ms ASC`,
    )
    .all(staleCutoffMs, deadRunnerCutoffMs) as Array<StaleInvocationRow>;

  for (const row of recentRunningInvocations) {
    const isRebaseRole = row.role === 'rebase_coder' || row.role === 'rebase_reviewer';
    if (activeTaskIds.has(row.task_id) || (hasActiveMergeLock && !isRebaseRole)) {
      continue;
    }
    if (!isRunnerProcessDead(row.runner_id, globalDb)) {
      continue;
    }
    await recoverOrphanedInvocation(projectDb, projectPath, row, dryRun, summary, 'dead runner');
  }

  if (dryRun) {
    return summary;
  }

  const orphanedLocks = projectDb
    .prepare(
      `SELECT tl.task_id FROM task_locks tl
       WHERE NOT EXISTS (
         SELECT 1 FROM task_invocations i
         WHERE i.task_id = tl.task_id AND i.status = 'running'
       )
       AND tl.task_id NOT IN (${
         activeTaskIds.size > 0 ? [...activeTaskIds].map(() => '?').join(',') : "'__none__'"
       })`,
    )
    .all(...(activeTaskIds.size > 0 ? [...activeTaskIds] : [])) as Array<{ task_id: string }>;

  if (orphanedLocks.length === 0) {
    return summary;
  }

  const taskIds = orphanedLocks.map((row) => row.task_id);
  const placeholders = taskIds.map(() => '?').join(',');
  const released = projectDb
    .prepare(`DELETE FROM task_locks WHERE task_id IN (${placeholders})`)
    .run(...taskIds);
  summary.releasedTaskLocks += released.changes;

  return summary;
}

export function runtimeSanitiseActionCount(summary: RuntimeSanitiseSummary): number {
  return (
    summary.recoveredApprovals +
    summary.recoveredRejects +
    summary.closedStaleInvocations +
    summary.releasedTaskLocks
  );
}
