import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getProjectHash } from '../parallel/clone.js';
import { releaseSlot } from '../workspace/pool.js';

export const FORCE_DELETE_TASK_STATUSES = ['in_progress', 'review', 'merge_pending'] as const;

export function taskDeleteRequiresForce(status: string): boolean {
  return FORCE_DELETE_TASK_STATUSES.includes(status as (typeof FORCE_DELETE_TASK_STATUSES)[number]);
}

export interface TaskRuntimeCleanupSummary {
  runnerIds: string[];
  releasedSlotIds: number[];
  unblockedSessionIds: string[];
  releasedMergeLocks: number;
}

export function cleanupTaskRuntimeState(
  globalDb: Database.Database,
  taskId: string,
  projectPath: string,
  out?: { log: (message: string) => void },
  projectDb?: Database.Database,
): TaskRuntimeCleanupSummary {
  const projectId = getProjectHash(projectPath);
  const runnerMap = new Map<string, { id: string; pid: number | null }>();
  const candidateRunnerIds = new Set<string>();

  if (projectDb) {
    const invocationRunnerIds = projectDb
      .prepare(
        `SELECT DISTINCT runner_id
         FROM task_invocations
         WHERE task_id = ?
           AND runner_id IS NOT NULL
           AND status = 'running'`
      )
      .all(taskId) as Array<{ runner_id: string }>;

    for (const row of invocationRunnerIds) {
      candidateRunnerIds.add(row.runner_id);
    }
  }

  const runners = globalDb
    .prepare(
      `SELECT DISTINCT r.id, r.pid
       FROM runners r
       LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE r.current_task_id = ?
         AND (r.project_path = ? OR ps.project_path = ?)`
    )
    .all(taskId, projectPath, projectPath) as Array<{ id: string; pid: number | null }>;

  for (const runner of runners) {
    runnerMap.set(runner.id, runner);
    candidateRunnerIds.add(runner.id);
  }

  for (const runnerId of candidateRunnerIds) {
    if (runnerMap.has(runnerId)) {
      continue;
    }

    const runner = globalDb
      .prepare(
        `SELECT r.id, r.pid, r.current_task_id
         FROM runners r
         LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
         WHERE r.id = ?
           AND (r.project_path = ? OR ps.project_path = ? OR r.project_path IS NULL)`
      )
      .get(runnerId, projectPath, projectPath) as {
      id: string;
      pid: number | null;
      current_task_id: string | null;
    } | undefined;

    if (runner && runner.current_task_id && runner.current_task_id !== taskId) {
      continue;
    }

    runnerMap.set(runnerId, { id: runnerId, pid: runner?.pid ?? null });
  }

  for (const runner of runnerMap.values()) {
    if (!runner.pid) continue;

    const ps = spawnSync('ps', ['-p', String(runner.pid), '-o', 'command='], { encoding: 'utf-8' });
    const cmdOutput = `${ps.stdout ?? ''}${ps.stderr ?? ''}`.toLowerCase();
    if (!cmdOutput.includes('steroids') || !cmdOutput.includes('runners')) {
      continue;
    }

    out?.log(`  -> Killing active runner process (PID: ${runner.pid})`);
    try {
      process.kill(runner.pid, 'SIGKILL');
      spawnSync('sleep', ['0.1']);
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        throw new Error(`Failed to kill active runner PID ${runner.pid}: ${error.message}`);
      }
    }
  }

  const sessionIdsToUnblock = new Set<string>();
  const releasedSlotIds: number[] = [];
  let releasedMergeLocks = 0;

  globalDb.transaction(() => {
    for (const runner of runnerMap.values()) {
      const workstreams = globalDb
        .prepare('SELECT id, session_id FROM workstreams WHERE runner_id = ?')
        .all(runner.id) as Array<{ id: string; session_id: string }>;

      for (const workstream of workstreams) {
        out?.log(`  -> Revoking workstream lease (${workstream.id})`);
        globalDb
          .prepare('UPDATE workstreams SET runner_id = NULL, lease_expires_at = NULL WHERE id = ?')
          .run(workstream.id);
        sessionIdsToUnblock.add(workstream.session_id);
      }

      globalDb.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
    }

    for (const sessionId of sessionIdsToUnblock) {
      globalDb
        .prepare(
          `UPDATE parallel_sessions
           SET status = 'running'
           WHERE id = ?
             AND status IN ('blocked_recovery', 'failed', 'blocked_validation', 'blocked_conflict')`
        )
        .run(sessionId);
    }

    const slots = globalDb
      .prepare('SELECT id FROM workspace_pool_slots WHERE project_id = ? AND task_id = ?')
      .all(projectId, taskId) as Array<{ id: number }>;

    for (const slot of slots) {
      releaseSlot(globalDb, slot.id);
      releasedSlotIds.push(slot.id);
    }

    for (const runnerId of runnerMap.keys()) {
      const released = globalDb
        .prepare(
          `DELETE FROM workspace_merge_locks
           WHERE project_id = ?
             AND runner_id = ?`
        )
        .run(projectId, runnerId);
      releasedMergeLocks += released.changes;
    }

    for (const slotId of releasedSlotIds) {
      const released = globalDb
        .prepare(
          `DELETE FROM workspace_merge_locks
           WHERE project_id = ?
             AND slot_id = ?`
        )
        .run(projectId, slotId);
      releasedMergeLocks += released.changes;
    }
  })();

  if (releasedMergeLocks > 0) {
    out?.log(`  -> Released ${releasedMergeLocks} merge lock(s)`);
  }

  return {
    runnerIds: [...runnerMap.keys()],
    releasedSlotIds,
    unblockedSessionIds: [...sessionIdsToUnblock],
    releasedMergeLocks,
  };
}
