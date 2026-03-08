type DbLike = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => { changes: number };
    get: (...args: unknown[]) => unknown;
  };
};

const TERMINAL_SESSION_STATUSES = "'completed', 'failed', 'aborted', 'blocked_validation', 'blocked_recovery'";
const TERMINAL_WORKSTREAM_STATUSES = "'completed', 'failed', 'aborted'";

export function closeStaleParallelSessions(
  db: DbLike,
  filters: { projectPath?: string; projectRepoId?: string } = {}
): number {
  const conditions: string[] = [`ps.status NOT IN (${TERMINAL_SESSION_STATUSES})`];
  const params: unknown[] = [];

  if (filters.projectPath) {
    conditions.push('ps.project_path = ?');
    params.push(filters.projectPath);
  }

  if (filters.projectRepoId) {
    conditions.push('ps.project_repo_id = ?');
    params.push(filters.projectRepoId);
  }

  const whereSql = conditions.join(' AND ');

  // Step 1: Mark orphaned workstreams as failed.
  // A workstream is orphaned when it's still 'running' but its session has no alive runners
  // (e.g. runner was killed/stopped without cleanly updating workstream status).
  db.prepare(
    `UPDATE workstreams
     SET status = 'failed'
     WHERE status NOT IN (${TERMINAL_WORKSTREAM_STATUSES})
       AND EXISTS (
         SELECT 1
         FROM parallel_sessions ps
         WHERE ps.id = workstreams.session_id
           AND ${whereSql}
       )
       AND NOT EXISTS (
         SELECT 1
         FROM runners r
         WHERE r.parallel_session_id = workstreams.session_id
           AND r.status != 'stopped'
           AND r.heartbeat_at > datetime('now', '-5 minutes')
       )
       AND (workstreams.lease_expires_at IS NULL OR workstreams.lease_expires_at <= datetime('now'))`
  ).run(...params);

  // Step 2: Close sessions with no active workstreams and no alive runners.
  return db
    .prepare(
      `UPDATE parallel_sessions AS ps
       SET status = 'completed',
           completed_at = COALESCE(completed_at, datetime('now'))
       WHERE ${whereSql}
         AND NOT EXISTS (
           SELECT 1
           FROM workstreams ws
           WHERE ws.session_id = ps.id
             AND ws.status NOT IN (${TERMINAL_WORKSTREAM_STATUSES})
         )
         AND NOT EXISTS (
           SELECT 1
           FROM runners r
           WHERE r.parallel_session_id = ps.id
             AND r.status != 'stopped'
             AND r.heartbeat_at > datetime('now', '-5 minutes')
         )`
    )
    .run(...params).changes;
}

export function findActiveParallelSessionForRepo(
  db: DbLike,
  projectRepoId: string
): { id: string; status: string } | undefined {
  return db
    .prepare(
      `SELECT ps.id, ps.status
       FROM parallel_sessions ps
       WHERE ps.project_repo_id = ?
         AND ps.status NOT IN (${TERMINAL_SESSION_STATUSES})
         AND (
           EXISTS (
             SELECT 1
             FROM workstreams ws
             WHERE ws.session_id = ps.id
               AND ws.status NOT IN (${TERMINAL_WORKSTREAM_STATUSES})
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
    .get(projectRepoId) as { id: string; status: string } | undefined;
}

export function hasActiveParallelSessionForProjectDb(db: DbLike, projectPath: string): boolean {
  const sessionRow = db
    .prepare(
      `SELECT 1
       FROM parallel_sessions ps
       WHERE ps.project_path = ?
         AND ps.status NOT IN (${TERMINAL_SESSION_STATUSES})
         AND (
           EXISTS (
             SELECT 1
             FROM workstreams ws
             WHERE ws.session_id = ps.id
               AND ws.status NOT IN (${TERMINAL_WORKSTREAM_STATUSES})
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

  const runnerRow = db
    .prepare(
      `SELECT 1
       FROM runners r
       JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE ps.project_path = ?
         AND r.status != 'stopped'
         AND r.heartbeat_at > datetime('now', '-5 minutes')
       LIMIT 1`
    )
    .get(projectPath) as { 1: number } | undefined;

  return runnerRow !== undefined;
}
