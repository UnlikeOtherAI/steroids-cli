/**
 * Merge lock management for concurrent merge workers.
 */

import type Database from 'better-sqlite3';
import { ParallelMergeError } from './merge-errors.js';

export interface MergeLockRecord {
  id: number;
  session_id: string;
  runner_id: string;
  lock_epoch: number;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface MergeLockOptions {
  sessionId: string;
  runnerId: string;
  timeoutMinutes: number;
}

function getNowISOString(): string {
  return new Date().toISOString();
}

function utcExpiresAt(timeoutMinutes: number): string {
  return new Date(Date.now() + timeoutMinutes * 60_000).toISOString();
}

export function isLockExpired(lock: MergeLockRecord): boolean {
  return new Date(lock.expires_at).getTime() < Date.now();
}

function getNextLockEpoch(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(lock_epoch), 0) AS max_epoch FROM merge_locks WHERE session_id = ?')
    .get(sessionId) as { max_epoch: number | null } | undefined;

  return (row?.max_epoch ?? 0) + 1;
}

export function getLatestMergeLock(db: Database.Database, sessionId: string): MergeLockRecord | null {
  return db
    .prepare(
      `SELECT * FROM merge_locks
       WHERE session_id = ?
       ORDER BY acquired_at DESC
       LIMIT 1`
    )
    .get(sessionId) as MergeLockRecord | null;
}

export function acquireMergeLock(
  db: Database.Database,
  options: MergeLockOptions
): { acquired: boolean; lock?: MergeLockRecord } {
  const lock = getLatestMergeLock(db, options.sessionId);

  if (lock && !isLockExpired(lock)) {
    if (lock.runner_id === options.runnerId) {
      const refreshed = refreshMergeLock(db, lock.session_id, options.runnerId, options.timeoutMinutes);
      return { acquired: true, lock: refreshed };
    }

    return { acquired: false, lock };
  }

  db.prepare('DELETE FROM merge_locks WHERE session_id = ?').run(options.sessionId);
  const lockEpoch = getNextLockEpoch(db, options.sessionId);

  const inserted = db.prepare(
    'INSERT INTO merge_locks (session_id, runner_id, lock_epoch, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    options.sessionId,
    options.runnerId,
    lockEpoch,
    getNowISOString(),
    utcExpiresAt(options.timeoutMinutes),
    getNowISOString()
  );

  if (inserted.changes !== 1) {
    return { acquired: false };
  }

  return { acquired: true, lock: getLatestMergeLock(db, options.sessionId) ?? undefined };
}

export function refreshMergeLock(
  db: Database.Database,
  sessionId: string,
  runnerId: string,
  timeoutMinutes: number,
  lockEpoch: number
): MergeLockRecord {
  const result = db.prepare(
    `UPDATE merge_locks
     SET heartbeat_at = ?, expires_at = ?
     WHERE session_id = ? AND runner_id = ? AND lock_epoch = ?`
  ).run(getNowISOString(), utcExpiresAt(timeoutMinutes), sessionId, runnerId, lockEpoch);

  if (result.changes !== 1) {
    throw new ParallelMergeError('Lost merge lock fence while refreshing heartbeat', 'MERGE_LOCK_FENCE_LOST');
  }

  const lock = getLatestMergeLock(db, sessionId);
  if (!lock) {
    throw new ParallelMergeError('Lost merge lock unexpectedly', 'MERGE_LOCK_NOT_FOUND');
  }

  if (lock.lock_epoch !== lockEpoch || lock.runner_id !== runnerId) {
    throw new ParallelMergeError('Merge lock epoch mismatch detected', 'MERGE_LOCK_EPOCH_MISMATCH');
  }

  return lock;
}

export function assertMergeLockEpoch(
  db: Database.Database,
  sessionId: string,
  runnerId: string,
  lockEpoch: number
): void {
  const row = db
    .prepare(
      `SELECT session_id, runner_id, lock_epoch, expires_at
       FROM merge_locks
       WHERE session_id = ? AND runner_id = ? AND lock_epoch = ?
       LIMIT 1`
    )
    .get(sessionId, runnerId, lockEpoch) as
    | { session_id: string; runner_id: string; lock_epoch: number; expires_at: string }
    | undefined;

  if (!row) {
    throw new ParallelMergeError('Merge lock fence no longer owned by current runner', 'MERGE_LOCK_FENCE_LOST');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new ParallelMergeError('Merge lock expired', 'MERGE_LOCK_EXPIRED');
  }
}

export function releaseMergeLock(db: Database.Database, sessionId: string, runnerId: string, lockEpoch: number): void {
  db
    .prepare('DELETE FROM merge_locks WHERE session_id = ? AND runner_id = ? AND lock_epoch = ?')
    .run(sessionId, runnerId, lockEpoch);
}
