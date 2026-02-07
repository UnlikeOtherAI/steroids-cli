/**
 * Section locking for parallel work prevention
 * Prevents multiple runners from working on tasks in the same section
 */

import type Database from 'better-sqlite3';
import {
  getSectionLock,
  isSectionLockExpired,
  tryInsertSectionLock,
  claimExpiredSectionLock,
  releaseSectionLock as releaseSectionLockQuery,
  forceReleaseSectionLock,
  type SectionLock,
} from './queries.js';

// Default section lock timeout in minutes
const DEFAULT_SECTION_TIMEOUT_MINUTES = 120;

// ============ Types ============

export interface SectionLockAcquisitionResult {
  acquired: boolean;
  lock?: SectionLock;
  reason?: 'already_owned' | 'acquired_new' | 'claimed_expired';
  error?: SectionLockError;
}

export interface SectionLockError {
  code: 'SECTION_LOCKED' | 'LOCK_NOT_FOUND' | 'PERMISSION_DENIED';
  message: string;
  details?: {
    sectionId: string;
    runnerId?: string;
    expiresAt?: string;
  };
}

export interface SectionLockReleaseResult {
  released: boolean;
  error?: SectionLockError;
}

export interface SectionLockManager {
  acquire: () => SectionLockAcquisitionResult;
  release: () => SectionLockReleaseResult;
  isHeld: () => boolean;
}

// ============ Lock Acquisition ============

/**
 * Acquire a section lock with atomic operations
 *
 * Flow:
 * 1. Try INSERT (fails if lock exists)
 * 2. If exists, check if we own it
 * 3. If owned by another, check if expired
 * 4. If expired, claim atomically
 * 5. If not expired, return failure
 */
export function acquireSectionLock(
  db: Database.Database,
  sectionId: string,
  runnerId: string,
  timeoutMinutes: number = DEFAULT_SECTION_TIMEOUT_MINUTES
): SectionLockAcquisitionResult {
  // Step 1: Try to insert new lock
  if (tryInsertSectionLock(db, sectionId, runnerId, timeoutMinutes)) {
    const lock = getSectionLock(db, sectionId);
    return {
      acquired: true,
      lock: lock ?? undefined,
      reason: 'acquired_new',
    };
  }

  // Step 2: Lock exists, get current state
  const existingLock = getSectionLock(db, sectionId);
  if (!existingLock) {
    // Race condition: lock was deleted between insert attempt and now
    if (tryInsertSectionLock(db, sectionId, runnerId, timeoutMinutes)) {
      const lock = getSectionLock(db, sectionId);
      return {
        acquired: true,
        lock: lock ?? undefined,
        reason: 'acquired_new',
      };
    }
    const currentLock = getSectionLock(db, sectionId);
    return createLockedError(sectionId, currentLock);
  }

  // Step 3: Check if we already own the lock
  if (existingLock.runner_id === runnerId) {
    return {
      acquired: true,
      lock: existingLock,
      reason: 'already_owned',
    };
  }

  // Step 4: Check if lock is expired
  if (isSectionLockExpired(existingLock)) {
    if (claimExpiredSectionLock(db, sectionId, runnerId, timeoutMinutes)) {
      const lock = getSectionLock(db, sectionId);
      return {
        acquired: true,
        lock: lock ?? undefined,
        reason: 'claimed_expired',
      };
    }
    // Another runner claimed it first
    const currentLock = getSectionLock(db, sectionId);
    return createLockedError(sectionId, currentLock);
  }

  // Step 5: Lock is held by another runner and not expired
  return createLockedError(sectionId, existingLock);
}

/**
 * Create a SECTION_LOCKED error response
 */
function createLockedError(
  sectionId: string,
  lock: SectionLock | null
): SectionLockAcquisitionResult {
  return {
    acquired: false,
    error: {
      code: 'SECTION_LOCKED',
      message: 'Section is locked by another runner',
      details: {
        sectionId,
        runnerId: lock?.runner_id,
        expiresAt: lock?.expires_at,
      },
    },
  };
}

// ============ Lock Release ============

/**
 * Release a section lock (only by owner)
 */
export function releaseSectionLock(
  db: Database.Database,
  sectionId: string,
  runnerId: string
): SectionLockReleaseResult {
  const existingLock = getSectionLock(db, sectionId);

  if (!existingLock) {
    return {
      released: false,
      error: {
        code: 'LOCK_NOT_FOUND',
        message: 'Lock does not exist',
        details: { sectionId },
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
          sectionId,
          runnerId: existingLock.runner_id,
          expiresAt: existingLock.expires_at,
        },
      },
    };
  }

  releaseSectionLockQuery(db, sectionId, runnerId);
  return { released: true };
}

/**
 * Force release a section lock (admin operation)
 */
export function forceRelease(
  db: Database.Database,
  sectionId: string
): SectionLockReleaseResult {
  const existed = forceReleaseSectionLock(db, sectionId);

  if (!existed) {
    return {
      released: false,
      error: {
        code: 'LOCK_NOT_FOUND',
        message: 'Lock does not exist',
        details: { sectionId },
      },
    };
  }

  return { released: true };
}

// ============ Lock Manager ============

/**
 * Create a section lock manager for a specific section
 */
export function createSectionLockManager(
  db: Database.Database,
  sectionId: string,
  runnerId: string,
  timeoutMinutes: number = DEFAULT_SECTION_TIMEOUT_MINUTES
): SectionLockManager {
  return {
    acquire: () => acquireSectionLock(db, sectionId, runnerId, timeoutMinutes),
    release: () => releaseSectionLock(db, sectionId, runnerId),
    isHeld: () => {
      const lock = getSectionLock(db, sectionId);
      return lock !== null && lock.runner_id === runnerId && !isSectionLockExpired(lock);
    },
  };
}

// ============ Lock Status Check ============

/**
 * Check if a section is locked
 */
export function isSectionLocked(
  db: Database.Database,
  sectionId: string
): boolean {
  const lock = getSectionLock(db, sectionId);
  if (!lock) return false;
  return !isSectionLockExpired(lock);
}

/**
 * Check if a section is locked by a specific runner
 */
export function isSectionLockedBy(
  db: Database.Database,
  sectionId: string,
  runnerId: string
): boolean {
  const lock = getSectionLock(db, sectionId);
  if (!lock) return false;
  return lock.runner_id === runnerId && !isSectionLockExpired(lock);
}

/**
 * Get time until section lock expires (in milliseconds)
 */
export function getTimeUntilExpiry(
  db: Database.Database,
  sectionId: string
): number | null {
  const lock = getSectionLock(db, sectionId);
  if (!lock) return null;

  const expiresAt = new Date(lock.expires_at).getTime();
  const remaining = expiresAt - Date.now();
  return Math.max(0, remaining);
}

// ============ Helper Functions ============

/**
 * Check if any tasks in the section are in progress by another runner
 * This can be used before acquiring a section lock
 */
export function getSectionLockHolder(
  db: Database.Database,
  sectionId: string
): SectionLock | null {
  const lock = getSectionLock(db, sectionId);
  if (!lock || isSectionLockExpired(lock)) {
    return null;
  }
  return lock;
}

// ============ Constants Export ============

export const SECTION_LOCK_CONSTANTS = {
  DEFAULT_TIMEOUT_MINUTES: DEFAULT_SECTION_TIMEOUT_MINUTES,
} as const;
