/**
 * Parallel session reconciliation for wakeup
 */

import { openGlobalDatabase } from './global-db.js';

export interface WorkstreamToRestart {
  workstreamId: string;
  sessionId: string;
  clonePath: string;
  sectionIds: string;
  branchName: string;
}

export function reconcileParallelSessionRecovery(
  db: ReturnType<typeof openGlobalDatabase>['db'],
  projectPath: string
): { scheduledRetries: number; blockedWorkstreams: number; workstreamsToRestart: WorkstreamToRestart[] } {
  const sessions = db
    .prepare(
      `SELECT id
       FROM parallel_sessions
       WHERE project_path = ?
         AND status NOT IN ('completed', 'failed', 'aborted', 'blocked_validation', 'blocked_recovery')`
    )
    .all(projectPath) as Array<{ id: string }>;

  let scheduledRetries = 0;
  let blockedWorkstreams = 0;
  const workstreamsToRestart: WorkstreamToRestart[] = [];

  for (const session of sessions) {
    let blockedInSession = 0;
    const candidates = db
      .prepare(
        `SELECT id, recovery_attempts, clone_path, section_ids, branch_name
         FROM workstreams
         WHERE session_id = ?
           AND status = 'running'
           AND (lease_expires_at IS NULL OR lease_expires_at <= datetime('now'))
           AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))`
      )
      .all(session.id) as Array<{
        id: string;
        recovery_attempts: number;
        clone_path: string;
        section_ids: string;
        branch_name: string;
      }>;

    for (const candidate of candidates) {
      const nextAttempts = (candidate.recovery_attempts ?? 0) + 1;

      if (nextAttempts >= 5) {
        db.prepare(
          `UPDATE workstreams
           SET status = 'failed',
               recovery_attempts = ?,
               next_retry_at = NULL,
               last_reconcile_action = 'blocked_recovery',
               last_reconciled_at = datetime('now')
           WHERE id = ?`
        ).run(nextAttempts, candidate.id);
        blockedWorkstreams += 1;
        blockedInSession += 1;
        continue;
      }

      db.prepare(
        `UPDATE workstreams
         SET recovery_attempts = ?,
             next_retry_at = NULL,
             last_reconcile_action = 'runner_restarted',
             last_reconciled_at = datetime('now')
         WHERE id = ?`
      ).run(nextAttempts, candidate.id);

      workstreamsToRestart.push({
        workstreamId: candidate.id,
        sessionId: session.id,
        clonePath: candidate.clone_path,
        sectionIds: candidate.section_ids,
        branchName: candidate.branch_name,
      });
      scheduledRetries += 1;
    }

    if (blockedInSession > 0) {
      db.prepare(
        `UPDATE parallel_sessions
         SET status = 'blocked_recovery',
             completed_at = NULL
         WHERE id = ?`
      ).run(session.id);
      continue;
    }

    // If all workstreams are in a terminal state but the session is still marked
    // running (e.g. because autoMergeOnCompletion crashed before it could call
    // updateParallelSessionStatus), close it out now so wakeup doesn't block.
    const nonTerminal = db.prepare(
      `SELECT COUNT(*) as count FROM workstreams
       WHERE session_id = ? AND status NOT IN ('completed', 'failed', 'aborted')`
    ).get(session.id) as { count: number };

    if (nonTerminal.count === 0) {
      const total = db.prepare(
        `SELECT COUNT(*) as count FROM workstreams WHERE session_id = ?`
      ).get(session.id) as { count: number };

      if (total.count > 0) {
        // All workstreams finished — mark session completed so wakeup can move on.
        db.prepare(
          `UPDATE parallel_sessions
           SET status = 'completed',
               completed_at = COALESCE(completed_at, datetime('now'))
           WHERE id = ?`
        ).run(session.id);
      }
    }
  }

  return { scheduledRetries, blockedWorkstreams, workstreamsToRestart };
}
