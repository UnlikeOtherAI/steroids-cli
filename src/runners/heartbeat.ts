/**
 * Heartbeat system for runner liveness detection
 */

import type Database from 'better-sqlite3';

const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds
const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface HeartbeatManager {
  start: () => void;
  stop: () => void;
  beat: () => void;
}

/**
 * Update heartbeat timestamp for a runner
 */
export function updateHeartbeat(db: Database.Database, runnerId: string): void {
  db.prepare(
    `UPDATE runners SET heartbeat_at = datetime('now') WHERE id = ?`
  ).run(runnerId);
}

/**
 * Check if a runner's heartbeat is stale
 */
export function isHeartbeatStale(
  db: Database.Database,
  runnerId: string
): boolean {
  const runner = db
    .prepare('SELECT heartbeat_at FROM runners WHERE id = ?')
    .get(runnerId) as { heartbeat_at: string } | undefined;

  if (!runner) {
    return true;
  }

  const heartbeatTime = new Date(runner.heartbeat_at).getTime();
  const now = Date.now();
  return now - heartbeatTime > STALE_TIMEOUT_MS;
}

/**
 * Find stale runners (no heartbeat for > 5 minutes)
 */
export function findStaleRunners(
  db: Database.Database
): Array<{ id: string; pid: number | null; heartbeat_at: string }> {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();

  return db
    .prepare(
      `SELECT id, pid, heartbeat_at FROM runners
       WHERE heartbeat_at < ? AND status != 'idle'`
    )
    .all(cutoff) as Array<{ id: string; pid: number | null; heartbeat_at: string }>;
}

/**
 * Create a heartbeat manager for a runner
 * Automatically updates heartbeat at regular intervals
 */
export function createHeartbeatManager(
  db: Database.Database,
  runnerId: string
): HeartbeatManager {
  let intervalId: NodeJS.Timeout | null = null;

  const beat = (): void => {
    updateHeartbeat(db, runnerId);
  };

  const start = (): void => {
    // Update immediately
    beat();

    // Then update every 30 seconds
    intervalId = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  };

  const stop = (): void => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  return { start, stop, beat };
}

/**
 * Get heartbeat interval in milliseconds
 */
export function getHeartbeatInterval(): number {
  return HEARTBEAT_INTERVAL_MS;
}

/**
 * Get stale timeout in milliseconds
 */
export function getStaleTimeout(): number {
  return STALE_TIMEOUT_MS;
}
