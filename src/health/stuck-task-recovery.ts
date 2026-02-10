/**
 * Automatic recovery actions for stuck tasks.
 *
 * This builds on detectStuckTasks() and applies a conservative set of actions:
 * - orphaned_task: reset task to pending, release any task lock, increment failure_count, log incident
 * - hanging_invocation: kill runner process, remove runner row, reset task (or skip after repeated failures)
 * - zombie_runner/dead_runner: stop runner (best-effort) and reset its current_task_id (if any)
 *
 * Note: The repo intentionally approximates "invocation started/completed" using tasks.updated_at,
 * task_invocations.created_at, and runners.heartbeat_at. Recovery follows those same signals.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { SteroidsConfig } from '../config/loader.js';
import { updateTaskStatus } from '../database/queries.js';
import { forceReleaseTaskLock } from '../locking/queries.js';
import {
  detectStuckTasks,
  type StuckTaskDetectionConfig,
  type StuckTaskDetectionReport,
  type OrphanedTaskSignal,
  type HangingTaskSignal,
  type ZombieRunnerSignal,
  type DeadRunnerSignal,
} from './stuck-task-detector.js';

export interface StuckTaskRecoveryConfig extends StuckTaskDetectionConfig {
  autoRecover?: boolean; // default true
  maxRecoveryAttempts?: number; // default 3
  maxIncidentsPerHour?: number; // default 10
  killGraceMs?: number; // default 10s
}

export type RecoveryResolution = 'auto_restart' | 'skipped' | 'escalated' | 'none';

export interface RecoveryAction {
  kind: 'task' | 'runner';
  targetId: string;
  failureMode: string;
  resolution: RecoveryResolution;
  reason: string;
}

export interface RecoverStuckTasksOptions {
  projectPath: string;
  projectDb: Database.Database;
  globalDb: Database.Database;
  config?: SteroidsConfig;
  now?: Date;
  dryRun?: boolean;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, graceMs: number) => Promise<boolean>;
}

export interface RecoverStuckTasksResult {
  report: StuckTaskDetectionReport;
  actions: RecoveryAction[];
  skippedDueToSafetyLimit: boolean;
}

const DEFAULTS: Required<Pick<StuckTaskRecoveryConfig, 'autoRecover' | 'maxRecoveryAttempts' | 'maxIncidentsPerHour' | 'killGraceMs'>> = {
  autoRecover: true,
  maxRecoveryAttempts: 3,
  maxIncidentsPerHour: 10,
  killGraceMs: 10_000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAliveBestEffort(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPidBestEffort(pid: number, graceMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!isAlive(pid)) return true;
    await delay(250);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore
  }

  return !isAlive(pid);
}

function readRecoveryConfig(config?: SteroidsConfig): Required<StuckTaskRecoveryConfig> {
  const h = config?.health ?? {};
  return {
    orphanedTaskTimeoutSec: h.orphanedTaskTimeout ?? 600,
    maxCoderDurationSec: h.maxCoderDuration ?? 1800,
    maxReviewerDurationSec: h.maxReviewerDuration ?? 900,
    runnerHeartbeatTimeoutSec: h.runnerHeartbeatTimeout ?? 300,
    invocationStalenessSec: h.invocationStaleness ?? 600,
    dbInconsistencyRecentUpdateSec: 60,
    autoRecover: h.autoRecover ?? DEFAULTS.autoRecover,
    maxRecoveryAttempts: h.maxRecoveryAttempts ?? DEFAULTS.maxRecoveryAttempts,
    maxIncidentsPerHour: h.maxIncidentsPerHour ?? DEFAULTS.maxIncidentsPerHour,
    killGraceMs: DEFAULTS.killGraceMs,
  };
}

function incidentsInLastHour(projectDb: Database.Database): number {
  try {
    const row = projectDb
      .prepare(`SELECT COUNT(*) as count FROM incidents WHERE detected_at >= datetime('now', '-1 hour')`)
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function insertIncident(
  projectDb: Database.Database,
  args: {
    taskId?: string;
    runnerId?: string;
    failureMode: string;
    resolution: RecoveryResolution;
    details?: unknown;
  }
): void {
  try {
    const id = uuidv4();
    const details = args.details === undefined ? null : JSON.stringify(args.details);
    projectDb
      .prepare(
        `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)`
      )
      .run(id, args.taskId ?? null, args.runnerId ?? null, args.failureMode, args.resolution, details);
  } catch {
    // Best-effort: incidents table may not exist if migrations are disabled.
  }
}

function getFailureCount(projectDb: Database.Database, taskId: string): number {
  try {
    const row = projectDb.prepare('SELECT failure_count as c FROM tasks WHERE id = ?').get(taskId) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function bumpFailureCount(projectDb: Database.Database, taskId: string): void {
  try {
    projectDb
      .prepare(
        `UPDATE tasks
         SET failure_count = COALESCE(failure_count, 0) + 1,
             last_failure_at = datetime('now')
         WHERE id = ?`
      )
      .run(taskId);
  } catch {
    // ignore
  }
}

function deleteRunnerRow(globalDb: Database.Database, runnerId: string): void {
  try {
    globalDb.prepare('DELETE FROM runners WHERE id = ?').run(runnerId);
  } catch {
    // ignore
  }
}

function recoverOrphanedTask(
  projectDb: Database.Database,
  signal: OrphanedTaskSignal,
  cfg: Required<StuckTaskRecoveryConfig>,
  dryRun: boolean
): RecoveryAction {
  const currentFailures = getFailureCount(projectDb, signal.taskId);
  const nextFailures = currentFailures + 1;
  const shouldEscalate = nextFailures >= cfg.maxRecoveryAttempts;

  const resolution: RecoveryResolution = shouldEscalate ? 'skipped' : 'auto_restart';
  const newStatus = shouldEscalate ? 'skipped' : 'pending';

  if (!dryRun) {
    const tx = projectDb.transaction(() => {
      forceReleaseTaskLock(projectDb, signal.taskId);
      updateTaskStatus(
        projectDb,
        signal.taskId,
        newStatus,
        'system:stuck-task-recovery',
        shouldEscalate
          ? `Auto-recovery escalated after ${nextFailures} failure(s): orphaned task`
          : `Auto-recovery: orphaned task reset to pending`
      );
      bumpFailureCount(projectDb, signal.taskId);
      insertIncident(projectDb, {
        taskId: signal.taskId,
        failureMode: 'orphaned_task',
        resolution,
        details: {
          secondsSinceUpdate: signal.secondsSinceUpdate,
          invocationCount: signal.invocationCount,
          lastInvocationAt: signal.lastInvocationAt?.toISOString() ?? null,
        },
      });
    });
    tx();
  }

  return {
    kind: 'task',
    targetId: signal.taskId,
    failureMode: 'orphaned_task',
    resolution,
    reason: shouldEscalate
      ? `orphaned task escalated (failure_count ${nextFailures})`
      : `orphaned task reset to pending (failure_count ${nextFailures})`,
  };
}

async function recoverHangingInvocation(
  projectDb: Database.Database,
  globalDb: Database.Database,
  signal: HangingTaskSignal,
  cfg: Required<StuckTaskRecoveryConfig>,
  dryRun: boolean,
  killPid: (pid: number, graceMs: number) => Promise<boolean>
): Promise<RecoveryAction> {
  const currentFailures = getFailureCount(projectDb, signal.taskId);
  const nextFailures = currentFailures + 1;
  const shouldEscalate = nextFailures >= cfg.maxRecoveryAttempts;

  const resolution: RecoveryResolution = shouldEscalate ? 'skipped' : 'auto_restart';
  const newStatus = shouldEscalate ? 'skipped' : 'pending';

  if (!dryRun) {
    // Stop the runner first (best-effort), then reset the task.
    if (signal.runnerPid !== null) {
      await killPid(signal.runnerPid, cfg.killGraceMs ?? DEFAULTS.killGraceMs);
    }
    deleteRunnerRow(globalDb, signal.runnerId);

    const tx = projectDb.transaction(() => {
      forceReleaseTaskLock(projectDb, signal.taskId);
      updateTaskStatus(
        projectDb,
        signal.taskId,
        newStatus,
        'system:stuck-task-recovery',
        shouldEscalate
          ? `Auto-recovery escalated after ${nextFailures} failure(s): hanging ${signal.phase}`
          : `Auto-recovery: killed hanging ${signal.phase}, reset to pending`
      );
      bumpFailureCount(projectDb, signal.taskId);
      insertIncident(projectDb, {
        taskId: signal.taskId,
        runnerId: signal.runnerId,
        failureMode: 'hanging_invocation',
        resolution,
        details: {
          phase: signal.phase,
          secondsSinceUpdate: signal.secondsSinceUpdate,
          runnerPid: signal.runnerPid,
          runnerHeartbeatAt: signal.runnerHeartbeatAt.toISOString(),
        },
      });
    });
    tx();
  }

  return {
    kind: 'task',
    targetId: signal.taskId,
    failureMode: 'hanging_invocation',
    resolution,
    reason: shouldEscalate
      ? `hanging ${signal.phase} escalated (failure_count ${nextFailures})`
      : `killed hanging ${signal.phase}, reset to pending (failure_count ${nextFailures})`,
  };
}

async function recoverZombieOrDeadRunner(
  projectDb: Database.Database,
  globalDb: Database.Database,
  signal: ZombieRunnerSignal | DeadRunnerSignal,
  dryRun: boolean,
  killPid: (pid: number, graceMs: number) => Promise<boolean>
): Promise<RecoveryAction> {
  if (!dryRun) {
    if (signal.failureMode === 'zombie_runner' && signal.pid !== null) {
      await killPid(signal.pid, DEFAULTS.killGraceMs);
    }

    // Reset the runner's current task (if any) so the project can continue.
    if (signal.currentTaskId) {
      const taskExists = (() => {
        try {
          const row = projectDb.prepare('SELECT 1 FROM tasks WHERE id = ?').get(signal.currentTaskId) as { 1: number } | undefined;
          return row !== undefined;
        } catch {
          return false;
        }
      })();

      const tx = projectDb.transaction(() => {
        forceReleaseTaskLock(projectDb, signal.currentTaskId as string);
        if (taskExists) {
          updateTaskStatus(
            projectDb,
            signal.currentTaskId as string,
            'pending',
            'system:stuck-task-recovery',
            `Auto-recovery: ${signal.failureMode} cleared runner and reset task to pending`
          );
          bumpFailureCount(projectDb, signal.currentTaskId as string);
        }
        insertIncident(projectDb, {
          taskId: signal.currentTaskId as string,
          runnerId: signal.runnerId,
          failureMode: signal.failureMode,
          resolution: 'auto_restart',
          details: {
            runnerPid: signal.pid,
            secondsSinceHeartbeat: signal.secondsSinceHeartbeat,
            taskExists,
          },
        });
      });
      tx();
    } else {
      insertIncident(projectDb, {
        runnerId: signal.runnerId,
        failureMode: signal.failureMode,
        resolution: 'auto_restart',
        details: {
          runnerPid: signal.pid,
          secondsSinceHeartbeat: signal.secondsSinceHeartbeat,
        },
      });
    }

    deleteRunnerRow(globalDb, signal.runnerId);
  }

  return {
    kind: 'runner',
    targetId: signal.runnerId,
    failureMode: signal.failureMode,
    resolution: 'auto_restart',
    reason: `${signal.failureMode} runner removed`,
  };
}

export async function recoverStuckTasks(options: RecoverStuckTasksOptions): Promise<RecoverStuckTasksResult> {
  const cfg = readRecoveryConfig(options.config);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  const isPidAlive = options.isPidAlive ?? isPidAliveBestEffort;
  const killPid =
    options.killPid ??
    ((pid: number, graceMs: number) => killPidBestEffort(pid, graceMs, isPidAlive));

  const report = detectStuckTasks({
    projectPath: options.projectPath,
    projectDb: options.projectDb,
    globalDb: options.globalDb,
    now,
    isPidAlive,
    config: cfg,
  });

  const actions: RecoveryAction[] = [];
  const handledTaskIds = new Set<string>();

  // Safety limit: too many incidents per hour => stop auto-recovery.
  const recentIncidents = incidentsInLastHour(options.projectDb);
  if ((cfg.maxIncidentsPerHour ?? DEFAULTS.maxIncidentsPerHour) > 0 && recentIncidents >= (cfg.maxIncidentsPerHour ?? DEFAULTS.maxIncidentsPerHour)) {
    return { report, actions, skippedDueToSafetyLimit: true };
  }

  if (!cfg.autoRecover) {
    return { report, actions, skippedDueToSafetyLimit: false };
  }

  // Runner-level recovery first, to avoid repeatedly detecting "hanging" with a zombie/dead runner.
  for (const r of report.zombieRunners) {
    actions.push(await recoverZombieOrDeadRunner(options.projectDb, options.globalDb, r, dryRun, killPid));
    if (r.currentTaskId) handledTaskIds.add(r.currentTaskId);
  }
  for (const r of report.deadRunners) {
    actions.push(await recoverZombieOrDeadRunner(options.projectDb, options.globalDb, r, dryRun, killPid));
    if (r.currentTaskId) handledTaskIds.add(r.currentTaskId);
  }

  // Task-level recovery.
  for (const t of report.orphanedTasks) {
    if (handledTaskIds.has(t.taskId)) continue;
    actions.push(recoverOrphanedTask(options.projectDb, t, cfg, dryRun));
  }
  for (const h of report.hangingInvocations) {
    if (handledTaskIds.has(h.taskId)) continue;
    actions.push(await recoverHangingInvocation(options.projectDb, options.globalDb, h, cfg, dryRun, killPid));
  }

  return { report, actions, skippedDueToSafetyLimit: false };
}
