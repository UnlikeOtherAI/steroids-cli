/**
 * Parallel session and workstream management
 */

import { withGlobalDatabase } from './global-db-connection';

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
          `SELECT id, pid FROM runners
           WHERE parallel_session_id = ?
             AND status != 'stopped'`
        )
        .all(sessionId) as Array<{ id: string; pid: number | null }>;

      for (const runner of runners) {
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
