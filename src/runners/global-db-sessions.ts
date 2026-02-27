/**
 * Parallel session and workstream management
 */

import { withGlobalDatabase } from './global-db-connection';
import { openDatabase } from '../database/connection.js';

export type ParallelSessionStatus =
  | 'running'
  | 'merging'
  | 'cleanup_pending'
  | 'cleanup_draining'
  | 'blocked_conflict'
  | 'blocked_recovery'
  | 'blocked_validation'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface ParallelSessionRunner {
  id: string;
  pid: number | null;
}

export function updateParallelSessionStatus(
  sessionId: string,
  status: ParallelSessionStatus,
  markCompletedAt = false
): void {
  const terminalStatuses: ParallelSessionStatus[] = ['completed', 'failed', 'aborted'];

  withGlobalDatabase((db) => {
    db.prepare(
      `UPDATE parallel_sessions
       SET status = ?,
           completed_at = CASE
             WHEN ? = 1 THEN datetime('now')
             ELSE completed_at
           END
       WHERE id = ?`
    ).run(status, markCompletedAt ? 1 : 0, sessionId);

    // When transitioning to a terminal status, kill associated runner processes
    // so they don't become ghost runners that block new session creation.
    // Skip the calling process's own PID to avoid self-kill (the last-to-finish
    // runner calls this during auto-merge).
    if (terminalStatuses.includes(status)) {
      const selfPid = process.pid;
      const runners = db
        .prepare(
          `SELECT id, pid, current_task_id, project_path FROM runners
           WHERE parallel_session_id = ?
             AND status != 'stopped'`
        )
        .all(sessionId) as Array<{
          id: string;
          pid: number | null;
          current_task_id: string | null;
          project_path: string | null;
        }>;

      for (const runner of runners) {
        // Clean up in-flight task state before killing the runner.
        // Reset task to pending so the section is unblocked immediately.
        // Lock is left to expire naturally to prevent double-execution.
        if (runner.current_task_id && runner.project_path && runner.pid !== selfPid) {
          try {
            const { db: projectDb, close: closeProjectDb } = openDatabase(runner.project_path);
            try {
              const nowMs = Date.now();
              projectDb.prepare(
                `UPDATE task_invocations
                 SET status = 'failed', success = 0, timed_out = 0,
                     exit_code = 1, completed_at_ms = ?, duration_ms = ?,
                     error = COALESCE(error, 'Runner terminated by parallel session failure.')
                 WHERE task_id = ? AND status = 'running'`
              ).run(nowMs, 0, runner.current_task_id);
              projectDb.prepare(
                `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
                 WHERE id = ? AND status = 'in_progress'`
              ).run(runner.current_task_id);
            } finally {
              closeProjectDb();
            }
          } catch { /* don't let project DB errors block the kill */ }
        }

        if (runner.pid && runner.pid !== selfPid) {
          try { process.kill(runner.pid, 'SIGTERM'); } catch { /* already dead */ }
        }
        db.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
      }
    }
  });
}

export function revokeWorkstreamLeasesForSession(sessionId: string): number {
  return withGlobalDatabase((db) => {
    const result = db.prepare(
      `UPDATE workstreams
       SET runner_id = NULL,
           lease_expires_at = datetime('now')
       WHERE session_id = ?`
    ).run(sessionId);
    return result.changes;
  });
}

export function listParallelSessionRunners(sessionId: string): ParallelSessionRunner[] {
  return withGlobalDatabase((db) => {
    return db
      .prepare('SELECT id, pid FROM runners WHERE parallel_session_id = ?')
      .all(sessionId) as ParallelSessionRunner[];
  });
}

export function removeParallelSessionRunner(runnerId: string): void {
  withGlobalDatabase((db) => {
    db.prepare('DELETE FROM runners WHERE id = ?').run(runnerId);
  });
}

export interface PriorWorkstreamSeed {
  clone_path: string;
  branch_name: string;
}

/**
 * Find the most recent completed (non-running) workstream for any of the given
 * section IDs within the same project, from a different session than the caller's.
 * Used to seed new workspace clones with prior work when a parallel session ended
 * without merging.
 */
export function findPriorWorkstreamForSections(
  db: import('better-sqlite3').Database,
  projectRepoId: string,
  currentSessionId: string,
  sectionIds: string[]
): PriorWorkstreamSeed | null {
  if (sectionIds.length === 0) return null;

  const placeholders = sectionIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT w.clone_path, w.branch_name
       FROM workstreams w
       JOIN parallel_sessions ps ON ps.id = w.session_id
       WHERE ps.project_repo_id = ?
         AND w.session_id != ?
         AND w.status != 'running'
         AND w.clone_path IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM json_each(w.section_ids)
           WHERE json_each.value IN (${placeholders})
         )
       ORDER BY w.created_at DESC
       LIMIT 1`
    )
    .get(projectRepoId, currentSessionId, ...sectionIds) as PriorWorkstreamSeed | undefined;

  return row ?? null;
}
