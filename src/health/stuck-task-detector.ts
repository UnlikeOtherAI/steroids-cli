/**
 * Core stuck-task detection logic (detection only, no recovery).
 *
 * This implementation intentionally uses the project's current schemas:
 * - Project DB: tasks, audit, task_invocations
 * - Global DB: runners
 *
 * The design doc (docs/stuck-task-detection.md) describes additional fields/tables
 * (incidents, invocation started/completed timestamps, last_tool_execution, etc.).
 * Those are not present in the current repo schema, so we derive signals from
 * existing timestamps (tasks.updated_at, task_invocations.created_at, runners.heartbeat_at).
 */

import type Database from 'better-sqlite3';

export type FailureMode =
  | 'orphaned_task'
  | 'hanging_invocation'
  | 'zombie_runner'
  | 'dead_runner'
  | 'db_inconsistency'
  | 'credit_exhaustion';

export interface StuckTaskDetectionConfig {
  /**
   * How long a task may remain `in_progress` without a recent invocation and without
   * an active runner assigned before being considered orphaned.
   */
  orphanedTaskTimeoutSec?: number; // default 600 (10m)

  /**
   * Maximum allowed time a task may remain `in_progress` while an active runner is
   * actively working on it (approximates "hanging coder invocation" without
   * started/completed timestamps).
   */
  maxCoderDurationSec?: number; // default 1800 (30m)

  /**
   * Maximum allowed time a task may remain `review` while an active runner is
   * actively working on it (approximates "hanging reviewer invocation").
   */
  maxReviewerDurationSec?: number; // default 900 (15m)

  /** Runner heartbeat staleness threshold. */
  runnerHeartbeatTimeoutSec?: number; // default 300 (5m)

  /**
   * How long since last task invocation to consider a task "inactive" for orphan checks.
   * This is compared against task_invocations.created_at.
   */
  invocationStalenessSec?: number; // default 600 (10m)

  /** Recent-update window used for "DB inconsistency" transient detection. */
  dbInconsistencyRecentUpdateSec?: number; // default 60 (1m)
}

export interface OrphanedTaskSignal {
  failureMode: 'orphaned_task';
  taskId: string;
  title: string;
  status: 'in_progress';
  updatedAt: Date;
  secondsSinceUpdate: number;
  invocationCount: number;
  lastInvocationAt: Date | null;
  hasActiveRunner: boolean;
}

export interface HangingTaskSignal {
  failureMode: 'hanging_invocation';
  phase: 'coder' | 'reviewer';
  taskId: string;
  title: string;
  status: 'in_progress' | 'review';
  updatedAt: Date;
  secondsSinceUpdate: number;
  runnerId: string;
  runnerPid: number | null;
  runnerHeartbeatAt: Date;
  lastActivityAt: Date | null;
  secondsSinceActivity: number | null;
}

export interface ZombieRunnerSignal {
  failureMode: 'zombie_runner';
  runnerId: string;
  pid: number | null;
  status: string;
  projectPath: string | null;
  currentTaskId: string | null;
  heartbeatAt: Date;
  secondsSinceHeartbeat: number;
}

export interface DeadRunnerSignal {
  failureMode: 'dead_runner';
  runnerId: string;
  pid: number | null;
  status: string;
  projectPath: string | null;
  currentTaskId: string | null;
  heartbeatAt: Date;
  secondsSinceHeartbeat: number;
}

export interface DbInconsistencySignal {
  failureMode: 'db_inconsistency';
  taskId: string;
  title: string;
  status: 'in_progress';
  updatedAt: Date;
  secondsSinceUpdate: number;
  invocationCount: 0;
}

export interface StuckTaskDetectionReport {
  timestamp: Date;
  orphanedTasks: OrphanedTaskSignal[];
  hangingInvocations: HangingTaskSignal[];
  zombieRunners: ZombieRunnerSignal[];
  deadRunners: DeadRunnerSignal[];
  dbInconsistencies: DbInconsistencySignal[];
}

export interface DetectStuckTasksOptions {
  /** Absolute project path as stored in global runners DB. */
  projectPath: string;
  /** Project-local database connection (tasks, task_invocations). */
  projectDb: Database.Database;
  /** Global database connection (runners). */
  globalDb: Database.Database;
  /** Optional config overrides. */
  config?: StuckTaskDetectionConfig;
  /**
   * PID liveness check override for testing.
   * If omitted, a best-effort `process.kill(pid, 0)` check is used.
   */
  isPidAlive?: (pid: number) => boolean;
  /** Override current time for deterministic tests. */
  now?: Date;
}

const DEFAULTS: Required<StuckTaskDetectionConfig> = {
  orphanedTaskTimeoutSec: 600,
  maxCoderDurationSec: 1800,
  maxReviewerDurationSec: 900,
  runnerHeartbeatTimeoutSec: 300,
  invocationStalenessSec: 600,
  dbInconsistencyRecentUpdateSec: 60,
};

function isProcessAliveBestEffort(pid: number): boolean {
  try {
    // Signal 0: existence check only.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse SQLite datetime('now') strings (YYYY-MM-DD HH:MM:SS) as UTC.
 * Node's Date parser can treat "YYYY-MM-DD HH:MM:SS" as local time depending on runtime,
 * so we normalize to ISO 8601 Zulu.
 */
export function parseSqliteDateTimeUtc(value: string): Date {
  // Already ISO? (e.g., 2026-02-10T13:45:00.000Z)
  if (value.includes('T')) return new Date(value);
  // SQLite "YYYY-MM-DD HH:MM:SS" (UTC) => "YYYY-MM-DDTHH:MM:SSZ"
  return new Date(value.replace(' ', 'T') + 'Z');
}

/**
 * Format a Date as SQLite datetime('now')-compatible UTC string: YYYY-MM-DD HH:MM:SS
 * This keeps comparisons lexicographically safe against stored SQLite timestamps.
 */
export function formatSqliteDateTimeUtc(date: Date): string {
  // Date#toISOString is always UTC; trim milliseconds and replace T with space.
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function secondsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 1000));
}

function mergeConfig(config?: StuckTaskDetectionConfig): Required<StuckTaskDetectionConfig> {
  return { ...DEFAULTS, ...(config ?? {}) };
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
    `SELECT id, status, pid, project_path, current_task_id, heartbeat_at
     FROM runners
     WHERE status = 'running'
       AND project_path = ?
       AND heartbeat_at < ?`
  ).all(projectPath, cutoff) as Array<{
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
    `SELECT id, status, pid, project_path, current_task_id, heartbeat_at
     FROM runners
     WHERE status = 'running'
       AND project_path = ?`
  ).all(projectPath) as Array<{
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
         MAX(i.created_at) as last_invocation_at
       FROM tasks t
       LEFT JOIN task_invocations i ON i.task_id = t.id AND i.role = 'coder'
       WHERE t.status = 'in_progress'
         AND t.updated_at < ?
       GROUP BY t.id
       HAVING COUNT(i.id) = 0
           OR MAX(i.created_at) < ?`
    ).all(taskCutoff, invocationCutoff) as Array<{
      id: string;
      title: string;
      status: 'in_progress';
      updated_at: string;
      invocation_count: number;
      last_invocation_at: string | null;
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
       WHERE (t.status = 'in_progress' OR t.status = 'review')
         AND i.status = 'running'
       ORDER BY i.created_at DESC`
    ).all() as Array<{
      id: string;
      title: string;
      status: 'in_progress' | 'review';
      updated_at: string;
      last_activity_at_ms: number | null;
      role: 'coder' | 'reviewer';
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
      let isStuck = false;
      if (secondsSinceActivity !== null) {
        if (secondsSinceActivity > cfg.invocationStalenessSec) {
          isStuck = true;
        }
      } else {
        const wallClockLimit = row.status === 'review' ? cfg.maxReviewerDurationSec : cfg.maxCoderDurationSec;
        if (secondsSinceUpdate > wallClockLimit) {
          isStuck = true;
        }
      }

      if (isStuck) {
        hangingInvocations.push({
          failureMode: 'hanging_invocation',
          phase: row.role as 'coder' | 'reviewer',
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

  const row = globalDb.prepare(
    `SELECT id, pid, heartbeat_at
     FROM runners
     WHERE project_path = ?
       AND current_task_id = ?
       AND status = 'running'
       AND heartbeat_at >= ?
     ORDER BY heartbeat_at DESC
     LIMIT 1`
  ).get(projectPath, taskId, cutoff) as { id: string; pid: number | null; heartbeat_at: string } | undefined;

  if (!row) return null;
  if (row.pid !== null && !isPidAlive(row.pid)) return null;
  return row;
}
