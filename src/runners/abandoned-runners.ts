import type Database from 'better-sqlite3';
import { openDatabase } from '../database/connection.js';
import { isProcessAlive } from './lock.js';
import { killProcess } from './wakeup-runner.js';
import type { WakeupLogger, WakeupResult } from './wakeup-types.js';

export interface AbandonedRunnerRow {
  id: string;
  status: string;
  pid: number | null;
  heartbeat_at: string;
  current_task_id: string | null;
  project_path: string | null;
  raw_project_path: string | null;
  parallel_session_id: string | null;
  project_resolved: boolean;
  process_alive: boolean;
  reason: 'dead_pid' | 'stale_heartbeat';
}

interface RunnerRow {
  id: string;
  status: string;
  pid: number | null;
  heartbeat_at: string;
  current_task_id: string | null;
  project_path: string | null;
  raw_project_path: string | null;
  parallel_session_id: string | null;
  project_resolved: number;
  stale_heartbeat: number;
}

function cleanupStaleRunnerTaskState(runner: {
  current_task_id?: string | null;
  project_path?: string | null;
}): void {
  if (!runner.current_task_id || !runner.project_path) {
    return;
  }

  try {
    const { db: projectDb, close: closeProjectDb } = openDatabase(runner.project_path);
    try {
      const nowMs = Date.now();
      projectDb.prepare(
        `UPDATE task_invocations
         SET status = 'failed', success = 0, timed_out = 0, exit_code = 1,
             completed_at_ms = ?, duration_ms = ?,
             error = COALESCE(error, 'Runner process died (stale heartbeat).')
         WHERE task_id = ? AND status = 'running'`
      ).run(nowMs, 0, runner.current_task_id);
      projectDb.prepare(
        `UPDATE tasks SET status = 'pending', updated_at = datetime('now')
         WHERE id = ? AND status = 'in_progress'`
      ).run(runner.current_task_id);
      projectDb.prepare(
        `DELETE FROM task_locks WHERE task_id = ?`
      ).run(runner.current_task_id);
    } finally {
      closeProjectDb();
    }
  } catch {
    // Project DB errors must not block runner row cleanup.
  }
}

export function findAbandonedRunners(globalDb: Database.Database): AbandonedRunnerRow[] {
  const rows = globalDb.prepare(
    `SELECT
       r.id,
       r.status,
       r.pid,
       r.heartbeat_at,
       r.current_task_id,
       COALESCE(ps.project_path, r.project_path) AS project_path,
       r.project_path AS raw_project_path,
       r.parallel_session_id,
       CASE WHEN ps.id IS NOT NULL OR p.path IS NOT NULL THEN 1 ELSE 0 END AS project_resolved,
       CASE WHEN r.heartbeat_at < datetime('now', '-5 minutes') THEN 1 ELSE 0 END AS stale_heartbeat
     FROM runners r
     LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
     LEFT JOIN projects p ON p.path = COALESCE(ps.project_path, r.project_path)
     WHERE r.pid IS NOT NULL
        OR r.heartbeat_at < datetime('now', '-5 minutes')`
  ).all() as RunnerRow[];

  const abandoned: AbandonedRunnerRow[] = [];
  for (const row of rows) {
    const processAlive = row.pid !== null ? isProcessAlive(row.pid) : false;
    const deadPid = row.pid !== null && !processAlive;
    const staleHeartbeat = row.stale_heartbeat === 1;

    if (!deadPid && !staleHeartbeat) {
      continue;
    }

    abandoned.push({
      id: row.id,
      status: row.status,
      pid: row.pid,
      heartbeat_at: row.heartbeat_at,
      current_task_id: row.current_task_id,
      project_path: row.project_path,
      raw_project_path: row.raw_project_path,
      parallel_session_id: row.parallel_session_id,
      project_resolved: row.project_resolved === 1,
      process_alive: processAlive,
      reason: deadPid ? 'dead_pid' : 'stale_heartbeat',
    });
  }

  return abandoned;
}

export function cleanupAbandonedRunners(
  globalDb: Database.Database,
  options: { dryRun: boolean; log: WakeupLogger },
): WakeupResult[] {
  const { dryRun, log } = options;
  const abandonedRunners = findAbandonedRunners(globalDb);
  if (abandonedRunners.length === 0) {
    return [];
  }

  log(`Found ${abandonedRunners.length} abandoned runner(s), cleaning up...`);

  if (!dryRun) {
    for (const runner of abandonedRunners) {
      cleanupStaleRunnerTaskState(runner);

      if (runner.pid && runner.process_alive) {
        killProcess(runner.pid);
      }

      globalDb.prepare(
        `UPDATE workstreams
         SET runner_id = NULL,
             lease_expires_at = datetime('now')
         WHERE runner_id = ?`
      ).run(runner.id);
      globalDb.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
    }
  }

  return [{
    action: 'cleaned',
    reason: `Cleaned ${abandonedRunners.length} abandoned runner(s)`,
    staleRunners: abandonedRunners.length,
  }];
}
