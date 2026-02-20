import { openGlobalDatabase } from '../runners/global-db.js';
import { ParallelMergeError } from './merge-errors.js';

export const MAX_CONFLICT_ATTEMPTS = 5;
const MAX_CONFLICT_BACKOFF_MINUTES = 30;

export function recordConflictAttempt(
  sessionId: string,
  workstreamId: string
): { attempts: number; blocked: boolean; backoffMinutes: number | null } {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT conflict_attempts
         FROM workstreams
         WHERE session_id = ?
           AND id = ?
         LIMIT 1`
      )
      .get(sessionId, workstreamId) as { conflict_attempts: number } | undefined;

    if (!row) {
      throw new ParallelMergeError(
        'Parallel workstream row not found while recording conflict attempt',
        'LEASE_ROW_MISSING'
      );
    }

    const attempts = (row.conflict_attempts ?? 0) + 1;
    if (attempts >= MAX_CONFLICT_ATTEMPTS) {
      db.prepare(
        `UPDATE workstreams
         SET conflict_attempts = ?,
             status = 'failed',
             next_retry_at = NULL,
             last_reconcile_action = 'blocked_conflict',
             last_reconciled_at = datetime('now')
         WHERE session_id = ?
           AND id = ?`
      ).run(attempts, sessionId, workstreamId);

      db.prepare(
        `UPDATE parallel_sessions
         SET status = 'blocked_conflict',
             completed_at = NULL
         WHERE id = ?`
      ).run(sessionId);

      return { attempts, blocked: true, backoffMinutes: null };
    }

    const backoffMinutes = Math.min(2 ** Math.max(0, attempts - 1), MAX_CONFLICT_BACKOFF_MINUTES);
    db.prepare(
      `UPDATE workstreams
       SET conflict_attempts = ?,
           next_retry_at = datetime('now', ?),
           last_reconcile_action = 'conflict_retry',
           last_reconciled_at = datetime('now')
       WHERE session_id = ?
         AND id = ?`
    ).run(attempts, `+${backoffMinutes} minutes`, sessionId, workstreamId);

    return { attempts, blocked: false, backoffMinutes };
  } finally {
    close();
  }
}

export function clearConflictAttemptState(sessionId: string, workstreamId: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `UPDATE workstreams
       SET conflict_attempts = 0,
           next_retry_at = NULL,
           last_reconcile_action = 'conflict_resolved',
           last_reconciled_at = datetime('now')
       WHERE session_id = ?
         AND id = ?`
    ).run(sessionId, workstreamId);
  } finally {
    close();
  }
}
