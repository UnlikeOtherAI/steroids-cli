/**
 * Project state checks for wakeup
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openGlobalDatabase } from './global-db.js';

/**
 * Check if a project has pending work
 */
export async function projectHasPendingWork(projectPath: string): Promise<boolean> {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    // Use dynamic import for ESM compatibility
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status IN ('pending', 'in_progress', 'review')`
      )
      .get() as { count: number };

    db.close();
    return result.count > 0;
  } catch {
    return false;
  }
}

/**
 * Check if there's an active runner for a specific project
 * Exported for use in daemon startup checks
 */
export function hasActiveRunnerForProject(projectPath: string): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM runners
         WHERE project_path = ?
         AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes')
         AND parallel_session_id IS NULL`
      )
      .get(projectPath) as { 1: number } | undefined;

    return row !== undefined;
  } finally {
    close();
  }
}

export function hasActiveParallelSessionForProject(projectPath: string): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    // Primary check: session record in non-terminal state.
    const sessionRow = db
      .prepare(
        `SELECT 1 FROM parallel_sessions
         WHERE project_path = ?
           AND status NOT IN ('completed', 'failed', 'aborted')
         LIMIT 1`
      )
      .get(projectPath) as { 1: number } | undefined;

    if (sessionRow !== undefined) return true;

    // Belt-and-suspenders: if any runner for this project has an active
    // parallel_session_id and a fresh heartbeat, treat it as active even if the
    // session record somehow ended up in a terminal state. This prevents wakeup
    // from spawning a new parallel session while workstream runners are still live.
    const runnerRow = db
      .prepare(
        `SELECT 1 FROM runners r
         JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
         WHERE ps.project_path = ?
           AND r.status != 'stopped'
           AND r.heartbeat_at > datetime('now', '-5 minutes')
         LIMIT 1`
      )
      .get(projectPath) as { 1: number } | undefined;

    return runnerRow !== undefined;
  } finally {
    close();
  }
}
