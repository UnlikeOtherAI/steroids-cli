/**
 * Merge lock management for concurrent merge workers.
 */

import type Database from 'better-sqlite3';
import { ParallelMergeError } from './merge-errors.js';

export interface MergeLockRecord {
  id: number;
  session_id: string;
  runner_id: string;
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

  const inserted = db.prepare(
    'INSERT INTO merge_locks (session_id, runner_id, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    options.sessionId,
    options.runnerId,
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
  timeoutMinutes: number
): MergeLockRecord {
  db.prepare(
    `UPDATE merge_locks
     SET heartbeat_at = ?, expires_at = ?
     WHERE session_id = ? AND runner_id = ?`
  ).run(getNowISOString(), utcExpiresAt(timeoutMinutes), sessionId, runnerId);

  const lock = getLatestMergeLock(db, sessionId);
  if (!lock) {
    throw new ParallelMergeError('Lost merge lock unexpectedly', 'MERGE_LOCK_NOT_FOUND');
  }

  return lock;
}

export function releaseMergeLock(db: Database.Database, sessionId: string, runnerId: string): void {
  db.prepare('DELETE FROM merge_locks WHERE session_id = ? AND runner_id = ?').run(sessionId, runnerId);
}
