/**
 * Core stuck-task detection logic (detection only, no recovery).
 *
 * Types, config defaults, and datetime utilities live in stuck-task-detector-types.ts.
 */

import type Database from 'better-sqlite3';
import {
  type StuckTaskDetectionConfig,
  type OrphanedTaskSignal,
  type HangingTaskSignal,
  type ZombieRunnerSignal,
  type DeadRunnerSignal,
  type DbInconsistencySignal,
  type StuckTaskDetectionReport,
  type DetectStuckTasksOptions,
  DEFAULTS,
  parseSqliteDateTimeUtc,
  formatSqliteDateTimeUtc,
  secondsBetween,
  mergeConfig,
} from './stuck-task-detector-types.js';

// Re-export all public types and utilities so existing importers don't break.
export type {
  FailureMode,
  StuckTaskDetectionConfig,
  OrphanedTaskSignal,
  HangingTaskSignal,
  ZombieRunnerSignal,
  DeadRunnerSignal,
  DbInconsistencySignal,
  StuckTaskDetectionReport,
  DetectStuckTasksOptions,
} from './stuck-task-detector-types.js';
export { parseSqliteDateTimeUtc, formatSqliteDateTimeUtc } from './stuck-task-detector-types.js';

function isProcessAliveBestEffort(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function detectStuckTasks(options: DetectStuckTasksOptions): StuckTaskDetectionReport {
  const now = options.now ?? new Date();
  const cfg = mergeConfig(options.config);
  const isPidAlive = options.isPidAlive ?? isProcessAliveBestEffort;

  const zombieRunners = detectZombieRunnersInternal(options.globalDb, options.projectPath, cfg, now, isPidAlive);
  const deadRunners = detectDeadRunnersInternal(options.globalDb, options.projectPath, cfg, now, isPidAlive);
  const { orphanedTasks, hangingInvocations, dbInconsistencies } = detectTaskSignalsInternal(
    options.projectDb,
    options.globalDb,
    options.projectPath,
    cfg,
    now,
    isPidAlive
  );

  return {
    timestamp: now,
    orphanedTasks,
    hangingInvocations,
    zombieRunners,
    deadRunners,
    dbInconsistencies,
  };
}

function detectZombieRunnersInternal(
  globalDb: Database.Database,
  projectPath: string,
  cfg: Required<StuckTaskDetectionConfig>,
  now: Date,
  isPidAlive: (pid: number) => boolean
): ZombieRunnerSignal[] {
  const cutoff = formatSqliteDateTimeUtc(new Date(now.getTime() - cfg.runnerHeartbeatTimeoutSec * 1000));
  const rows = globalDb.prepare(
    `SELECT r.id, r.status, r.pid, r.project_path, r.current_task_id, r.heartbeat_at
     FROM runners r
     LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
     WHERE r.status = 'running'
       AND (r.project_path = ? OR ps.project_path = ?)
       AND r.heartbeat_at < ?`
  ).all(projectPath, projectPath, cutoff) as Array<{
    id: string;
    status: string;
    pid: number | null;
    project_path: string | null;
    current_task_id: string | null;
    heartbeat_at: string;
  }>;

  const result: ZombieRunnerSignal[] = [];
  for (const row of rows) {
    if (row.pid !== null && isPidAlive(row.pid)) {
      const hb = parseSqliteDateTimeUtc(row.heartbeat_at);
      result.push({
        failureMode: 'zombie_runner',
        runnerId: row.id,
        pid: row.pid,
        status: row.status,
        projectPath: row.project_path,
        currentTaskId: row.current_task_id,
        heartbeatAt: hb,
        secondsSinceHeartbeat: secondsBetween(now, hb),
      });
    }
  }
  return result;
}

function detectDeadRunnersInternal(
  globalDb: Database.Database,
  projectPath: string,
  cfg: Required<StuckTaskDetectionConfig>,
  now: Date,
  isPidAlive: (pid: number) => boolean
): DeadRunnerSignal[] {
  const rows = globalDb.prepare(
    `SELECT r.id, r.status, r.pid, r.project_path, r.current_task_id, r.heartbeat_at
     FROM runners r
     LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
     WHERE r.status = 'running'
       AND (r.project_path = ? OR ps.project_path = ?)`
  ).all(projectPath, projectPath) as Array<{
    id: string;
    status: string;
    pid: number | null;
    project_path: string | null;
    current_task_id: string | null;
    heartbeat_at: string;
  }>;

  const result: DeadRunnerSignal[] = [];
  for (const row of rows) {
    const alive = row.pid !== null && isPidAlive(row.pid);
    if (!alive) {
      const hb = parseSqliteDateTimeUtc(row.heartbeat_at);
      result.push({
        failureMode: 'dead_runner',
        runnerId: row.id,
        pid: row.pid,
        status: row.status,
        projectPath: row.project_path,
        currentTaskId: row.current_task_id,
        heartbeatAt: hb,
        secondsSinceHeartbeat: secondsBetween(now, hb),
      });
    }
  }
  return result;
}

function detectTaskSignalsInternal(
  projectDb: Database.Database,
  globalDb: Database.Database,
  projectPath: string,
  cfg: Required<StuckTaskDetectionConfig>,
  now: Date,
  isPidAlive: (pid: number) => boolean
): {
  orphanedTasks: OrphanedTaskSignal[];
  hangingInvocations: HangingTaskSignal[];
  dbInconsistencies: DbInconsistencySignal[];
} {
  const orphanedTasks: OrphanedTaskSignal[] = [];
  const hangingInvocations: HangingTaskSignal[] = [];
  const dbInconsistencies: DbInconsistencySignal[] = [];

  // DB inconsistency (transient): in_progress, no invocations, very recently updated.
  {
    const cutoff = formatSqliteDateTimeUtc(new Date(now.getTime() - cfg.dbInconsistencyRecentUpdateSec * 1000));
    const rows = projectDb.prepare(
      `SELECT t.id, t.title, t.status, t.updated_at
       FROM tasks t
       LEFT JOIN task_invocations i ON i.task_id = t.id AND i.role = 'coder'
       WHERE t.status = 'in_progress'
       GROUP BY t.id
       HAVING COUNT(i.id) = 0
          AND t.updated_at >= ?`
    ).all(cutoff) as Array<{ id: string; title: string; status: 'in_progress'; updated_at: string }>;

    for (const row of rows) {
      const updatedAt = parseSqliteDateTimeUtc(row.updated_at);
      dbInconsistencies.push({
        failureMode: 'db_inconsistency',
        taskId: row.id,
        title: row.title,
        status: 'in_progress',
        updatedAt,
        secondsSinceUpdate: secondsBetween(now, updatedAt),
        invocationCount: 0,
      });
    }
  }

  // Orphaned tasks: in_progress, stale updated_at, and no recent invocations, and no active runner assigned.
  {
    const taskCutoff = formatSqliteDateTimeUtc(new Date(now.getTime() - cfg.orphanedTaskTimeoutSec * 1000));
    const invocationCutoff = formatSqliteDateTimeUtc(new Date(now.getTime() - cfg.invocationStalenessSec * 1000));

    const rows = projectDb.prepare(
      `SELECT
         t.id,
         t.title,
         t.status,
         t.updated_at,
         COUNT(i.id) as invocation_count,
         MAX(i.created_at) as last_invocation_at,
         COALESCE(SUM(CASE WHEN i.status = 'running' THEN 1 ELSE 0 END), 0) as running_invocation_count
       FROM tasks t
       LEFT JOIN task_invocations i ON i.task_id = t.id AND (
         (t.status = 'in_progress' AND i.role = 'coder')
         OR (t.status = 'merge_pending' AND i.role IN ('merge', 'rebase_coder', 'rebase_reviewer'))
       )
       WHERE t.status IN ('in_progress', 'merge_pending')
         AND t.updated_at < ?
       GROUP BY t.id
       HAVING (
         (COUNT(i.id) = 0 OR MAX(i.created_at) < ?)
         AND running_invocation_count = 0
       )`
    ).all(taskCutoff, invocationCutoff) as Array<{
      id: string;
      title: string;
      status: 'in_progress' | 'merge_pending';
      updated_at: string;
      invocation_count: number;
      last_invocation_at: string | null;
      running_invocation_count: number;
    }>;

    for (const row of rows) {
      const updatedAt = parseSqliteDateTimeUtc(row.updated_at);
      const lastInvocationAt = row.last_invocation_at ? parseSqliteDateTimeUtc(row.last_invocation_at) : null;
      const activeRunner = getActiveRunnerForTask(globalDb, projectPath, row.id, cfg, now, isPidAlive);

      if (!activeRunner) {
        orphanedTasks.push({
          failureMode: 'orphaned_task',
          taskId: row.id,
          title: row.title,
          status: 'in_progress',
          updatedAt,
          secondsSinceUpdate: secondsBetween(now, updatedAt),
          invocationCount: row.invocation_count,
          lastInvocationAt,
          hasActiveRunner: false,
        });
      }
    }
  }

  // Hanging invocations: in_progress/review for too long with an active runner currently executing the task.
  // Approximates "invocation started but not completed" using activity heartbeats.
  {
    const rows = projectDb.prepare(
      `SELECT t.id, t.title, t.status, t.updated_at, i.last_activity_at_ms, i.role
       FROM tasks t
       JOIN task_invocations i ON i.task_id = t.id
       WHERE t.status IN ('in_progress', 'review', 'merge_pending')
         AND i.status = 'running'
         AND (
           i.started_at_ms IS NULL
           OR i.started_at_ms >= CAST(STRFTIME('%s', t.updated_at) AS INTEGER) * 1000
         )
       ORDER BY i.created_at DESC`
    ).all() as Array<{
      id: string;
      title: string;
      status: 'in_progress' | 'review' | 'merge_pending';
      updated_at: string;
      last_activity_at_ms: number | null;
      role: 'coder' | 'reviewer' | 'merge' | 'rebase_coder' | 'rebase_reviewer';
    }>;

    for (const row of rows) {
      const activeRunner = getActiveRunnerForTask(globalDb, projectPath, row.id, cfg, now, isPidAlive);
      if (!activeRunner) continue;

      const updatedAt = parseSqliteDateTimeUtc(row.updated_at);
      const lastActivityAt = row.last_activity_at_ms ? new Date(row.last_activity_at_ms) : null;
      const hbAt = parseSqliteDateTimeUtc(activeRunner.heartbeat_at);

      const secondsSinceUpdate = secondsBetween(now, updatedAt);
      const secondsSinceActivity = lastActivityAt ? secondsBetween(now, lastActivityAt) : null;

      // RULE: If we have activity heartbeats, use silence threshold (invocationStalenessSec).
      // If we DON'T have activity yet, use the wall-clock phase limit.
      // Phase-aware thresholds for merge_pending: queued ~5 min, rebasing ~30 min.
      let isStuck = false;
      if (secondsSinceActivity !== null) {
        if (secondsSinceActivity > cfg.invocationStalenessSec) {
          isStuck = true;
        }
      } else {
        let wallClockLimit: number;
        if (row.status === 'merge_pending' && row.role === 'merge') {
          wallClockLimit = 300; // 5 min for queued merge operations
        } else if (row.status === 'merge_pending') {
          wallClockLimit = cfg.maxCoderDurationSec; // rebase uses standard LLM timeout
        } else if (row.status === 'review') {
          wallClockLimit = cfg.maxReviewerDurationSec;
        } else {
          wallClockLimit = cfg.maxCoderDurationSec;
        }
        if (secondsSinceUpdate > wallClockLimit) {
          isStuck = true;
        }
      }

      if (isStuck) {
        hangingInvocations.push({
          failureMode: 'hanging_invocation',
          phase: row.role as 'coder' | 'reviewer' | 'merge' | 'rebase_coder' | 'rebase_reviewer',
          taskId: row.id,
          title: row.title,
          status: row.status,
          updatedAt,
          secondsSinceUpdate,
          runnerId: activeRunner.id,
          runnerPid: activeRunner.pid,
          runnerHeartbeatAt: hbAt,
          lastActivityAt,
          secondsSinceActivity,
        });
      }
    }
  }

  // Dead-owner invocations: running invocations whose runner has been unregistered
  // or whose process is dead. This closes the detection gap where a task with a running
  // invocation from a deleted runner falls through both the orphaned detector (has running
  // invocation count > 0) and the hanging detector (no active runner to find).
  {
    const emittedTaskIds = new Set([
      ...orphanedTasks.map((s) => s.taskId),
      ...hangingInvocations.map((s) => s.taskId),
    ]);

    const rows = projectDb
      .prepare(
        `SELECT i.id, i.task_id, i.runner_id, t.title, t.status, t.updated_at
         FROM task_invocations i
         JOIN tasks t ON t.id = i.task_id
         WHERE i.status = 'running'
           AND i.runner_id IS NOT NULL
           AND t.status IN ('in_progress', 'review', 'merge_pending')`
      )
      .all() as Array<{
      id: number;
      task_id: string;
      runner_id: string;
      title: string;
      status: 'in_progress' | 'review' | 'merge_pending';
      updated_at: string;
    }>;

    for (const row of rows) {
      if (emittedTaskIds.has(row.task_id)) continue;

      // Check if runner is alive via global DB
      const runnerRow = globalDb
        .prepare('SELECT pid FROM runners WHERE id = ?')
        .get(row.runner_id) as { pid: number | null } | undefined;

      let isOwnerDead = false;
      if (!runnerRow) {
        // Runner row missing = runner has been unregistered (dead).
        // Race safety: session teardown marks invocations as 'failed' BEFORE
        // deleting the runner row, so WHERE i.status = 'running' naturally
        // excludes tasks mid-graceful-teardown.
        isOwnerDead = true;
      } else if (runnerRow.pid !== null && !isPidAlive(runnerRow.pid)) {
        // Runner row exists but process is dead
        isOwnerDead = true;
      }

      if (isOwnerDead) {
        const updatedAt = parseSqliteDateTimeUtc(row.updated_at);
        emittedTaskIds.add(row.task_id);
        orphanedTasks.push({
          failureMode: 'orphaned_task',
          taskId: row.task_id,
          title: row.title,
          status: row.status,
          updatedAt,
          secondsSinceUpdate: secondsBetween(now, updatedAt),
          invocationCount: 0,
          lastInvocationAt: null,
          hasActiveRunner: false,
        });
      }
    }
  }

  return { orphanedTasks, hangingInvocations, dbInconsistencies };
}

function getActiveRunnerForTask(
  globalDb: Database.Database,
  projectPath: string,
  taskId: string,
  cfg: Required<StuckTaskDetectionConfig>,
  now: Date,
  isPidAlive: (pid: number) => boolean
): { id: string; pid: number | null; heartbeat_at: string } | null {
  const cutoff = formatSqliteDateTimeUtc(new Date(now.getTime() - cfg.runnerHeartbeatTimeoutSec * 1000));

  // Check direct runners and parallel session runners (workspace-prefixed paths)
  const row = globalDb.prepare(
    `SELECT r.id, r.pid, r.heartbeat_at
     FROM runners r
     LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
     WHERE (r.project_path = ? OR ps.project_path = ?)
       AND r.current_task_id = ?
       AND r.status = 'running'
       AND r.heartbeat_at >= ?
     ORDER BY r.heartbeat_at DESC
     LIMIT 1`
  ).get(projectPath, projectPath, taskId, cutoff) as { id: string; pid: number | null; heartbeat_at: string } | undefined;

  if (!row) return null;
  if (row.pid !== null && !isPidAlive(row.pid)) return null;
  return row;
}
