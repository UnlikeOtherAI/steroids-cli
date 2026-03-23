/**
 * Types, config, and utility functions for stuck-task detection.
 * Extracted from stuck-task-detector.ts to stay under the 500-line limit.
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
  status: 'in_progress' | 'review';
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

export const DEFAULTS: Required<StuckTaskDetectionConfig> = {
  orphanedTaskTimeoutSec: 600,
  maxCoderDurationSec: 1800,
  maxReviewerDurationSec: 900,
  runnerHeartbeatTimeoutSec: 300,
  invocationStalenessSec: 600,
  dbInconsistencyRecentUpdateSec: 60,
};

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

export function secondsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 1000));
}

export function mergeConfig(config?: StuckTaskDetectionConfig): Required<StuckTaskDetectionConfig> {
  return { ...DEFAULTS, ...(config ?? {}) };
}
