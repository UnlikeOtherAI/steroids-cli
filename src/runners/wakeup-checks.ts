import { withDatabase } from '../database/connection.js';
import { withGlobalDatabase } from './global-db.js';
/**
 * Project state checks for wakeup
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openGlobalDatabase } from './global-db.js';
import { openDatabase } from '../database/connection.js';
import { selectNextTask } from '../orchestrator/task-selector.js';
import { closeStaleParallelSessions, hasActiveParallelSessionForProjectDb } from './parallel-session-state.js';

/**
 * Check if a project has pending work
 */
export async function projectHasPendingWork(projectPath: string): Promise<boolean> {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    return withDatabase(projectPath, (db: any) => {
      // First try actionable task selection.
      if (selectNextTask(db) !== null) {
        return true;
      }

      // Align wakeup behavior with "outstanding work" shown in the admin UI.
      // If there are pending/in_progress/review tasks but selection is blocked
      // (for example transient lock/dependency timing), still consider it work.
      const row = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM tasks
           WHERE status IN ('pending', 'in_progress', 'review')`
        )
        .get() as { count: number };

      return row.count > 0;
    }, { timeoutMs: 1000 });
  } catch (error) {
    // Treat timeouts or locked DBs as no pending work for this cycle
    return false;
  }
}

/**
 * Check if there's an active runner for a specific project
 * Exported for use in daemon startup checks
 */
export function hasActiveRunnerForProject(projectPath: string): boolean {
  return withGlobalDatabase((db: any) => {
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
  });
}

export function hasActiveParallelSessionForProject(projectPath: string): boolean {
  return withGlobalDatabase((db: any) => {
    closeStaleParallelSessions(db, { projectPath });
    return hasActiveParallelSessionForProjectDb(db, projectPath);
  });
}
