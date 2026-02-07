/**
 * Task locking with atomic operations
 * Prevents multiple runners from working on the same task
 */

import type Database from 'better-sqlite3';
import {
  getTaskLock,
  isTaskLockExpired,
  tryInsertTaskLock,
  claimExpiredTaskLock,
  releaseTaskLock as releaseTaskLockQuery,
  forceReleaseTaskLock,
  updateTaskLockHeartbeat,
  extendTaskLock,
  type TaskLock,
} from './queries.js';

// Default lock timeout in minutes
const DEFAULT_LOCK_TIMEOUT_MINUTES = 60;
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds

// ============ Types ============

export interface LockAcquisitionResult {
  acquired: boolean;
  lock?: TaskLock;
  reason?: 'already_owned' | 'acquired_new' | 'claimed_expired';
  error?: LockError;
}

export interface LockError {
  code: 'TASK_LOCKED' | 'LOCK_NOT_FOUND' | 'PERMISSION_DENIED';
  message: string;
  details?: {
    taskId: string;
    runnerId?: string;
    expiresAt?: string;
  };
}

export interface LockReleaseResult {
  released: boolean;
  error?: LockError;
}

export interface TaskLockManager {
  acquire: () => LockAcquisitionResult;
  release: () => LockReleaseResult;
  heartbeat: () => boolean;
  extend: (additionalMinutes?: number) => boolean;
  isHeld: () => boolean;
}

// ============ Lock Acquisition ============

/**
 * Acquire a task lock with atomic operations
 *
 * Flow:
 * 1. Try INSERT (fails if lock exists)
 * 2. If exists, check if we own it
 * 3. If owned by another, check if expired
 * 4. If expired, claim atomically
 * 5. If not expired, return failure
 */
export function acquireTaskLock(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  timeoutMinutes: number = DEFAULT_LOCK_TIMEOUT_MINUTES
): LockAcquisitionResult {
  // Step 1: Try to insert new lock
  if (tryInsertTaskLock(db, taskId, runnerId, timeoutMinutes)) {
    const lock = getTaskLock(db, taskId);
    return {
      acquired: true,
      lock: lock ?? undefined,
      reason: 'acquired_new',
    };
  }

  // Step 2: Lock exists, get current state
  const existingLock = getTaskLock(db, taskId);
  if (!existingLock) {
    // Race condition: lock was deleted between insert attempt and now
    // Try to acquire again
    if (tryInsertTaskLock(db, taskId, runnerId, timeoutMinutes)) {
      const lock = getTaskLock(db, taskId);
      return {
        acquired: true,
        lock: lock ?? undefined,
        reason: 'acquired_new',
      };
    }
    // Still failed, get the current lock
    const currentLock = getTaskLock(db, taskId);
    return createLockedError(taskId, currentLock);
  }

  // Step 3: Check if we already own the lock
  if (existingLock.runner_id === runnerId) {
    // Refresh the lock expiry
    extendTaskLock(db, taskId, runnerId, timeoutMinutes);
    const updatedLock = getTaskLock(db, taskId);
    return {
      acquired: true,
      lock: updatedLock ?? undefined,
      reason: 'already_owned',
    };
  }

  // Step 4: Check if lock is expired
  if (isTaskLockExpired(existingLock)) {
    // Try to claim the expired lock atomically
    if (claimExpiredTaskLock(db, taskId, runnerId, timeoutMinutes)) {
      const lock = getTaskLock(db, taskId);
      return {
        acquired: true,
        lock: lock ?? undefined,
        reason: 'claimed_expired',
      };
    }
    // Another runner claimed it first
    const currentLock = getTaskLock(db, taskId);
    return createLockedError(taskId, currentLock);
  }

  // Step 5: Lock is held by another runner and not expired
  return createLockedError(taskId, existingLock);
}

/**
 * Create a TASK_LOCKED error response
 */
function createLockedError(
  taskId: string,
  lock: TaskLock | null
): LockAcquisitionResult {
  return {
    acquired: false,
    error: {
      code: 'TASK_LOCKED',
      message: 'Task is locked by another runner',
      details: {
        taskId,
        runnerId: lock?.runner_id,
        expiresAt: lock?.expires_at,
      },
    },
  };
}

// ============ Lock Release ============

/**
 * Release a task lock (only by owner)
 */
export function releaseTaskLock(
  db: Database.Database,
  taskId: string,
  runnerId: string
): LockReleaseResult {
  const existingLock = getTaskLock(db, taskId);

  if (!existingLock) {
    return {
      released: false,
      error: {
        code: 'LOCK_NOT_FOUND',
        message: 'Lock does not exist',
        details: { taskId },
      },
    };
  }

  if (existingLock.runner_id !== runnerId) {
    return {
      released: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Cannot release lock owned by another runner',
        details: {
          taskId,
          runnerId: existingLock.runner_id,
          expiresAt: existingLock.expires_at,
        },
      },
    };
  }

  releaseTaskLockQuery(db, taskId, runnerId);
  return { released: true };
}

/**
 * Force release a task lock (admin operation, ignores owner)
 */
export function forceRelease(
  db: Database.Database,
  taskId: string
): LockReleaseResult {
  const existed = forceReleaseTaskLock(db, taskId);

  if (!existed) {
    return {
      released: false,
      error: {
        code: 'LOCK_NOT_FOUND',
        message: 'Lock does not exist',
        details: { taskId },
      },
    };
  }

  return { released: true };
}

// ============ Lock Heartbeat ============

/**
 * Update heartbeat for a task lock
 * Should be called periodically while holding the lock
 */
export function heartbeat(
  db: Database.Database,
  taskId: string,
  runnerId: string
): boolean {
  return updateTaskLockHeartbeat(db, taskId, runnerId);
}

/**
 * Extend a task lock's expiry time
 */
export function extend(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  additionalMinutes: number = DEFAULT_LOCK_TIMEOUT_MINUTES
): boolean {
  return extendTaskLock(db, taskId, runnerId, additionalMinutes);
}

// ============ Lock Manager ============

/**
 * Create a task lock manager for a specific task
 * Provides a convenient interface for managing a single lock
 */
export function createTaskLockManager(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  timeoutMinutes: number = DEFAULT_LOCK_TIMEOUT_MINUTES
): TaskLockManager {
  return {
    acquire: () => acquireTaskLock(db, taskId, runnerId, timeoutMinutes),
    release: () => releaseTaskLock(db, taskId, runnerId),
    heartbeat: () => updateTaskLockHeartbeat(db, taskId, runnerId),
    extend: (additionalMinutes = timeoutMinutes) =>
      extendTaskLock(db, taskId, runnerId, additionalMinutes),
    isHeld: () => {
      const lock = getTaskLock(db, taskId);
      return lock !== null && lock.runner_id === runnerId && !isTaskLockExpired(lock);
    },
  };
}

// ============ Heartbeat Manager ============

export interface HeartbeatHandle {
  start: () => void;
  stop: () => void;
}

/**
 * Create an automatic heartbeat manager that updates
 * the lock heartbeat at regular intervals
 */
export function createHeartbeatLoop(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS
): HeartbeatHandle {
  let intervalId: NodeJS.Timeout | null = null;

  const beat = (): void => {
    updateTaskLockHeartbeat(db, taskId, runnerId);
  };

  const start = (): void => {
    if (intervalId) return; // Already running
    beat(); // Immediate first beat
    intervalId = setInterval(beat, intervalMs);
  };

  const stop = (): void => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  return { start, stop };
}

// ============ Lock Status Check ============

/**
 * Check if a task is locked
 */
export function isTaskLocked(
  db: Database.Database,
  taskId: string
): boolean {
  const lock = getTaskLock(db, taskId);
  if (!lock) return false;
  return !isTaskLockExpired(lock);
}

/**
 * Check if a task is locked by a specific runner
 */
export function isTaskLockedBy(
  db: Database.Database,
  taskId: string,
  runnerId: string
): boolean {
  const lock = getTaskLock(db, taskId);
  if (!lock) return false;
  return lock.runner_id === runnerId && !isTaskLockExpired(lock);
}

/**
 * Get time until lock expires (in milliseconds)
 * Returns null if not locked, 0 if already expired
 */
export function getTimeUntilExpiry(
  db: Database.Database,
  taskId: string
): number | null {
  const lock = getTaskLock(db, taskId);
  if (!lock) return null;

  const expiresAt = new Date(lock.expires_at).getTime();
  const remaining = expiresAt - Date.now();
  return Math.max(0, remaining);
}

// ============ Constants Export ============

export const LOCK_CONSTANTS = {
  DEFAULT_TIMEOUT_MINUTES: DEFAULT_LOCK_TIMEOUT_MINUTES,
  HEARTBEAT_INTERVAL_MS,
} as const;
