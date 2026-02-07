/**
 * Lock cleanup for expired locks
 * Called periodically by cron to release stale locks
 */

import type Database from 'better-sqlite3';
import {
  findExpiredTaskLocks,
  cleanupExpiredTaskLocks,
  findExpiredSectionLocks,
  cleanupExpiredSectionLocks,
  type TaskLock,
  type SectionLock,
} from './queries.js';

// ============ Types ============

export interface CleanupResult {
  success: boolean;
  taskLocks: {
    found: number;
    cleaned: number;
    locks: TaskLock[];
  };
  sectionLocks: {
    found: number;
    cleaned: number;
    locks: SectionLock[];
  };
}

export interface CleanupOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

// ============ Cleanup Functions ============

/**
 * Find all expired locks without removing them
 * Useful for reporting or dry-run mode
 */
export function findExpiredLocks(db: Database.Database): {
  taskLocks: TaskLock[];
  sectionLocks: SectionLock[];
} {
  return {
    taskLocks: findExpiredTaskLocks(db),
    sectionLocks: findExpiredSectionLocks(db),
  };
}

/**
 * Clean up expired task locks
 * Returns the number of locks cleaned
 */
export function cleanupTaskLocks(
  db: Database.Database,
  options: CleanupOptions = {}
): { found: TaskLock[]; cleaned: number } {
  const expired = findExpiredTaskLocks(db);

  if (options.dryRun || expired.length === 0) {
    return {
      found: expired,
      cleaned: 0,
    };
  }

  const cleaned = cleanupExpiredTaskLocks(db);
  return {
    found: expired,
    cleaned,
  };
}

/**
 * Clean up expired section locks
 * Returns the number of locks cleaned
 */
export function cleanupSectionLocks(
  db: Database.Database,
  options: CleanupOptions = {}
): { found: SectionLock[]; cleaned: number } {
  const expired = findExpiredSectionLocks(db);

  if (options.dryRun || expired.length === 0) {
    return {
      found: expired,
      cleaned: 0,
    };
  }

  const cleaned = cleanupExpiredSectionLocks(db);
  return {
    found: expired,
    cleaned,
  };
}

/**
 * Clean up all expired locks (both task and section)
 * Main entry point for lock cleanup
 */
export function cleanupAllExpiredLocks(
  db: Database.Database,
  options: CleanupOptions = {}
): CleanupResult {
  const taskResult = cleanupTaskLocks(db, options);
  const sectionResult = cleanupSectionLocks(db, options);

  return {
    success: true,
    taskLocks: {
      found: taskResult.found.length,
      cleaned: taskResult.cleaned,
      locks: taskResult.found,
    },
    sectionLocks: {
      found: sectionResult.found.length,
      cleaned: sectionResult.cleaned,
      locks: sectionResult.found,
    },
  };
}

// ============ Scheduled Cleanup ============

export interface CleanupScheduler {
  start: () => void;
  stop: () => void;
  runNow: () => CleanupResult;
}

// Default cleanup interval: 5 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Create a scheduled cleanup runner
 * Automatically cleans up expired locks at regular intervals
 */
export function createCleanupScheduler(
  db: Database.Database,
  intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS,
  onCleanup?: (result: CleanupResult) => void
): CleanupScheduler {
  let intervalId: NodeJS.Timeout | null = null;

  const runCleanup = (): CleanupResult => {
    const result = cleanupAllExpiredLocks(db);
    if (onCleanup) {
      onCleanup(result);
    }
    return result;
  };

  const start = (): void => {
    if (intervalId) return; // Already running

    // Run immediately
    runCleanup();

    // Schedule periodic cleanup
    intervalId = setInterval(runCleanup, intervalMs);
  };

  const stop = (): void => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  return {
    start,
    stop,
    runNow: runCleanup,
  };
}

// ============ JSON Output ============

/**
 * Format cleanup result for JSON output
 */
export function formatCleanupResultJson(result: CleanupResult): object {
  return {
    success: result.success,
    command: 'locks',
    subcommand: 'cleanup',
    data: {
      task_locks: {
        found: result.taskLocks.found,
        cleaned: result.taskLocks.cleaned,
        locks: result.taskLocks.locks.map(lock => ({
          task_id: lock.task_id,
          runner_id: lock.runner_id,
          acquired_at: lock.acquired_at,
          expires_at: lock.expires_at,
          heartbeat_at: lock.heartbeat_at,
        })),
      },
      section_locks: {
        found: result.sectionLocks.found,
        cleaned: result.sectionLocks.cleaned,
        locks: result.sectionLocks.locks.map(lock => ({
          section_id: lock.section_id,
          runner_id: lock.runner_id,
          acquired_at: lock.acquired_at,
          expires_at: lock.expires_at,
        })),
      },
    },
    error: null,
  };
}

// ============ Constants Export ============

export const CLEANUP_CONSTANTS = {
  DEFAULT_INTERVAL_MS: DEFAULT_CLEANUP_INTERVAL_MS,
} as const;
