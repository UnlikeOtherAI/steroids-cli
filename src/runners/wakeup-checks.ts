/**
 * Project state checks for wakeup
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openGlobalDatabase } from './global-db.js';
import { openDatabase } from '../database/connection.js';
import { selectNextTask } from '../orchestrator/task-selector.js';

/**
 * Check if a project has pending work
 */
export async function projectHasPendingWork(projectPath: string): Promise<boolean> {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    // Mirror orchestrator selection logic so wakeup only starts runners
    // when there is actually an eligible task to execute.
    // Use strict 500ms timeout for O(N) querying
    const { db, close } = openDatabase(projectPath, { timeoutMs: 500 });
    try {
      return selectNextTask(db) !== null;
    } finally {
      close();
    }
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
    // Session is considered active only when it still has non-terminal workstream
    // state or an actively heartbeating runner bound to it.
    const sessionRow = db
      .prepare(
        `SELECT 1
         FROM parallel_sessions ps
         WHERE ps.project_path = ?
           AND ps.status NOT IN ('completed', 'failed', 'aborted')
           AND (
             EXISTS (
               SELECT 1
               FROM workstreams ws
               WHERE ws.session_id = ps.id
                 AND ws.status NOT IN ('completed', 'failed', 'aborted')
             )
             OR EXISTS (
               SELECT 1
               FROM runners r
               WHERE r.parallel_session_id = ps.id
                 AND r.status != 'stopped'
                 AND r.heartbeat_at > datetime('now', '-5 minutes')
             )
           )
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
