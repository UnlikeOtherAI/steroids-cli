import type Database from 'better-sqlite3';

interface InvocationRunnerRow {
  current_task_id: string | null;
  pid: number | null;
  heartbeat_fresh: number;
}

export interface InvocationLivenessRow {
  task_id: string;
  status: string;
  runner_id: string | null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunnerLiveForTask(
  globalDb: Database.Database,
  projectPath: string,
  taskId: string,
  runnerId: string,
): boolean {
  const row = globalDb
    .prepare(
      `SELECT
         r.current_task_id,
         r.pid,
         CASE
           WHEN r.heartbeat_at > datetime('now', '-5 minutes') THEN 1
           ELSE 0
         END AS heartbeat_fresh
       FROM runners r
       LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE r.id = ?
         AND (r.project_path = ? OR ps.project_path = ? OR r.project_path IS NULL)
       LIMIT 1`,
    )
    .get(runnerId, projectPath, projectPath) as InvocationRunnerRow | undefined;

  if (!row?.current_task_id || row.current_task_id !== taskId) {
    return false;
  }
  if (row.heartbeat_fresh !== 1) {
    return false;
  }
  if (row.pid === null) {
    return true;
  }
  return isProcessAlive(row.pid);
}

export function annotateInvocationLiveness<T extends InvocationLivenessRow>(
  globalDb: Database.Database,
  projectPath: string,
  invocations: T[],
): Array<T & { is_live?: boolean }> {
  const cache = new Map<string, boolean>();

  return invocations.map((invocation) => {
    if (invocation.status !== 'running' || !invocation.runner_id) {
      return invocation;
    }

    const cacheKey = `${invocation.runner_id}:${invocation.task_id}`;
    let isLive = cache.get(cacheKey);
    if (isLive === undefined) {
      isLive = isRunnerLiveForTask(globalDb, projectPath, invocation.task_id, invocation.runner_id);
      cache.set(cacheKey, isLive);
    }

    return {
      ...invocation,
      is_live: isLive,
    };
  });
}

export function selectLatestLiveRunningInvocation<T extends InvocationLivenessRow>(
  globalDb: Database.Database,
  projectPath: string,
  invocations: T[],
): T | undefined {
  const annotated = annotateInvocationLiveness(globalDb, projectPath, invocations);
  return annotated.find((invocation) => invocation.status === 'running' && invocation.is_live !== false);
}
