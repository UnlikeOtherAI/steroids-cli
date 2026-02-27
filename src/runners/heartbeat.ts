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
  // Use SQLite's datetime comparison to avoid JavaScript/SQLite format issues
  const result = db
    .prepare(
      `SELECT 1 FROM runners
       WHERE id = ? AND heartbeat_at >= datetime('now', '-5 minutes')`
    )
    .get(runnerId) as { 1: number } | undefined;

  // If no row returned, either runner doesn't exist or heartbeat is stale
  return result === undefined;
}

/**
 * Find stale runners (no heartbeat for > 5 minutes)
 */
export function findStaleRunners(
  db: Database.Database
): Array<{ id: string; pid: number | null; heartbeat_at: string; current_task_id: string | null; project_path: string | null; parallel_session_id: string | null }> {
  // Use SQLite's datetime function to avoid timestamp format mismatches.
  // JOIN with parallel_sessions to resolve the canonical project_path for
  // parallel workstream runners, whose r.project_path is a clone workspace
  // path that may not contain a steroids DB. COALESCE falls back to
  // r.project_path for standalone runners (parallel_session_id IS NULL).
  return db
    .prepare(
      `SELECT r.id, r.pid, r.heartbeat_at, r.current_task_id,
              COALESCE(ps.project_path, r.project_path) AS project_path,
              r.parallel_session_id
       FROM runners r
       LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE r.heartbeat_at < datetime('now', '-5 minutes') AND r.status != 'idle'`
    )
    .all() as Array<{ id: string; pid: number | null; heartbeat_at: string; current_task_id: string | null; project_path: string | null; parallel_session_id: string | null }>;
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
