/**
 * Database queries for task and section lock management
 * All lock operations are atomic using SQLite transactions
 */

import type Database from 'better-sqlite3';

// ============ Types ============

export interface TaskLock {
  task_id: string;
  runner_id: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface SectionLock {
  section_id: string;
  runner_id: string;
  acquired_at: string;
  expires_at: string;
}

export interface LockInfo {
  isLocked: boolean;
  lock: TaskLock | null;
  isExpired: boolean;
  isOwnedByUs: boolean;
}

// ============ Task Lock Queries ============

/**
 * Get task lock by task ID
 */
export function getTaskLock(
  db: Database.Database,
  taskId: string
): TaskLock | null {
  return db
    .prepare('SELECT * FROM task_locks WHERE task_id = ?')
    .get(taskId) as TaskLock | null;
}

/**
 * Check if a task lock is expired
 */
export function isTaskLockExpired(lock: TaskLock): boolean {
  const expiresAt = new Date(lock.expires_at).getTime();
  return Date.now() > expiresAt;
}

/**
 * Get task lock info with ownership and expiry status
 */
export function getTaskLockInfo(
  db: Database.Database,
  taskId: string,
  runnerId: string
): LockInfo {
  const lock = getTaskLock(db, taskId);

  if (!lock) {
    return {
      isLocked: false,
      lock: null,
      isExpired: false,
      isOwnedByUs: false,
    };
  }

  const isExpired = isTaskLockExpired(lock);
  const isOwnedByUs = lock.runner_id === runnerId;

  return {
    isLocked: !isExpired,
    lock,
    isExpired,
    isOwnedByUs,
  };
}

/**
 * Try to insert a new task lock (atomic)
 * Returns true if lock was acquired, false if already exists
 */
export function tryInsertTaskLock(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  timeoutMinutes: number
): boolean {
  const expiresAt = new Date(
    Date.now() + timeoutMinutes * 60 * 1000
  ).toISOString();

  try {
    db.prepare(
      `INSERT INTO task_locks (task_id, runner_id, expires_at)
       VALUES (?, ?, ?)`
    ).run(taskId, runnerId, expiresAt);
    return true;
  } catch (err) {
    // IntegrityError means lock already exists
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      return false;
    }
    throw err;
  }
}

/**
 * Claim an expired lock atomically
 * Only succeeds if the lock is actually expired at execution time
 */
export function claimExpiredTaskLock(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  timeoutMinutes: number
): boolean {
  const expiresAt = new Date(
    Date.now() + timeoutMinutes * 60 * 1000
  ).toISOString();

  const result = db.prepare(
    `UPDATE task_locks
     SET runner_id = ?,
         acquired_at = datetime('now'),
         expires_at = ?,
         heartbeat_at = datetime('now')
     WHERE task_id = ?
       AND expires_at < datetime('now')`
  ).run(runnerId, expiresAt, taskId);

  return result.changes > 0;
}

/**
 * Release a task lock (only if owned by the specified runner)
 * Returns true if lock was released, false if not owned
 */
export function releaseTaskLock(
  db: Database.Database,
  taskId: string,
  runnerId: string
): boolean {
  const result = db.prepare(
    `DELETE FROM task_locks
     WHERE task_id = ?
       AND runner_id = ?`
  ).run(taskId, runnerId);

  return result.changes > 0;
}

/**
 * Force release a task lock (admin operation)
 * Returns true if lock was released
 */
export function forceReleaseTaskLock(
  db: Database.Database,
  taskId: string
): boolean {
  const result = db.prepare(
    `DELETE FROM task_locks WHERE task_id = ?`
  ).run(taskId);

  return result.changes > 0;
}

/**
 * Update heartbeat for a task lock
 * Returns true if heartbeat was updated, false if lock not found or not owned
 */
export function updateTaskLockHeartbeat(
  db: Database.Database,
  taskId: string,
  runnerId: string
): boolean {
  const result = db.prepare(
    `UPDATE task_locks
     SET heartbeat_at = datetime('now')
     WHERE task_id = ?
       AND runner_id = ?`
  ).run(taskId, runnerId);

  return result.changes > 0;
}

/**
 * Extend a task lock's expiry time
 * Returns true if extended, false if lock not found or not owned
 */
export function extendTaskLock(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  additionalMinutes: number
): boolean {
  const newExpiresAt = new Date(
    Date.now() + additionalMinutes * 60 * 1000
  ).toISOString();

  const result = db.prepare(
    `UPDATE task_locks
     SET expires_at = ?,
         heartbeat_at = datetime('now')
     WHERE task_id = ?
       AND runner_id = ?`
  ).run(newExpiresAt, taskId, runnerId);

  return result.changes > 0;
}

/**
 * List all task locks
 */
export function listTaskLocks(db: Database.Database): TaskLock[] {
  return db
    .prepare('SELECT * FROM task_locks ORDER BY acquired_at DESC')
    .all() as TaskLock[];
}

/**
 * Find all expired task locks
 */
export function findExpiredTaskLocks(db: Database.Database): TaskLock[] {
  return db
    .prepare(
      `SELECT * FROM task_locks
       WHERE expires_at < datetime('now')
       ORDER BY expires_at ASC`
    )
    .all() as TaskLock[];
}

/**
 * Delete all expired task locks
 * Returns the number of locks deleted
 */
export function cleanupExpiredTaskLocks(db: Database.Database): number {
  const result = db.prepare(
    `DELETE FROM task_locks WHERE expires_at < datetime('now')`
  ).run();

  return result.changes;
}

// ============ Section Lock Queries ============

/**
 * Get section lock by section ID
 */
export function getSectionLock(
  db: Database.Database,
  sectionId: string
): SectionLock | null {
  return db
    .prepare('SELECT * FROM section_locks WHERE section_id = ?')
    .get(sectionId) as SectionLock | null;
}

/**
 * Check if a section lock is expired
 */
export function isSectionLockExpired(lock: SectionLock): boolean {
  const expiresAt = new Date(lock.expires_at).getTime();
  return Date.now() > expiresAt;
}

/**
 * Try to insert a new section lock (atomic)
 */
export function tryInsertSectionLock(
  db: Database.Database,
  sectionId: string,
  runnerId: string,
  timeoutMinutes: number
): boolean {
  const expiresAt = new Date(
    Date.now() + timeoutMinutes * 60 * 1000
  ).toISOString();

  try {
    db.prepare(
      `INSERT INTO section_locks (section_id, runner_id, expires_at)
       VALUES (?, ?, ?)`
    ).run(sectionId, runnerId, expiresAt);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      return false;
    }
    throw err;
  }
}

/**
 * Claim an expired section lock atomically
 */
export function claimExpiredSectionLock(
  db: Database.Database,
  sectionId: string,
  runnerId: string,
  timeoutMinutes: number
): boolean {
  const expiresAt = new Date(
    Date.now() + timeoutMinutes * 60 * 1000
  ).toISOString();

  const result = db.prepare(
    `UPDATE section_locks
     SET runner_id = ?,
         acquired_at = datetime('now'),
         expires_at = ?
     WHERE section_id = ?
       AND expires_at < datetime('now')`
  ).run(runnerId, expiresAt, sectionId);

  return result.changes > 0;
}

/**
 * Release a section lock
 */
export function releaseSectionLock(
  db: Database.Database,
  sectionId: string,
  runnerId: string
): boolean {
  const result = db.prepare(
    `DELETE FROM section_locks
     WHERE section_id = ?
       AND runner_id = ?`
  ).run(sectionId, runnerId);

  return result.changes > 0;
}

/**
 * Force release a section lock
 */
export function forceReleaseSectionLock(
  db: Database.Database,
  sectionId: string
): boolean {
  const result = db.prepare(
    `DELETE FROM section_locks WHERE section_id = ?`
  ).run(sectionId);

  return result.changes > 0;
}

/**
 * List all section locks
 */
export function listSectionLocks(db: Database.Database): SectionLock[] {
  return db
    .prepare('SELECT * FROM section_locks ORDER BY acquired_at DESC')
    .all() as SectionLock[];
}

/**
 * Find all expired section locks
 */
export function findExpiredSectionLocks(db: Database.Database): SectionLock[] {
  return db
    .prepare(
      `SELECT * FROM section_locks
       WHERE expires_at < datetime('now')
       ORDER BY expires_at ASC`
    )
    .all() as SectionLock[];
}

/**
 * Delete all expired section locks
 */
export function cleanupExpiredSectionLocks(db: Database.Database): number {
  const result = db.prepare(
    `DELETE FROM section_locks WHERE expires_at < datetime('now')`
  ).run();

  return result.changes;
}
