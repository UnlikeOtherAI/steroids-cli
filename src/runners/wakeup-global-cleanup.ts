import { checkLockStatus, removeLock } from './lock.js';
import { findStaleRunners } from './heartbeat.js';
import { openDatabase } from '../database/connection.js';
import { killProcess } from './wakeup-runner.js';
import type { WakeupLogger, WakeupResult } from './wakeup-types.js';

interface GlobalMaintenanceOptions {
  globalDb: any;
  dryRun: boolean;
  log: WakeupLogger;
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

function cleanupStaleRunners(globalDb: any, dryRun: boolean, log: WakeupLogger): WakeupResult[] {
  const results: WakeupResult[] = [];

  try {
    const staleRunners = findStaleRunners(globalDb);
    if (staleRunners.length === 0) {
      return results;
    }

    log(`Found ${staleRunners.length} stale runner(s), cleaning up...`);

    if (!dryRun) {
      for (const runner of staleRunners) {
        cleanupStaleRunnerTaskState(runner);

        if (runner.pid) {
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

    results.push({
      action: 'cleaned',
      reason: `Cleaned ${staleRunners.length} stale runner(s)`,
      staleRunners: staleRunners.length,
    });
  } catch {
    // Ignore global DB issues; wakeup will still attempt per-project checks.
  }

  return results;
}

function releaseExpiredLeases(globalDb: any, log: WakeupLogger): void {
  try {
    const releasedLeases = globalDb.prepare(
      `UPDATE workstreams
       SET runner_id = NULL,
           lease_expires_at = NULL
       WHERE status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= datetime('now')`
    ).run().changes;

    if (releasedLeases > 0) {
      log(`Released ${releasedLeases} expired workstream lease(s)`);
    }
  } catch {
    // Ignore lease cleanup issues in wakeup.
  }
}

async function reconcileStaleWorkspaces(globalDb: any, log: WakeupLogger): Promise<void> {
  try {
    const { reconcileStaleWorkspaces: reconcile } = await import('../workspace/reconcile.js');
    const reconcileResult = reconcile(globalDb);
    if (reconcileResult.resetSlots > 0 || reconcileResult.deletedLocks > 0) {
      log(
        `Workspace pool reconciliation: reset ${reconcileResult.resetSlots} slot(s), ` +
        `deleted ${reconcileResult.deletedLocks} stale lock(s)`
      );
    }
  } catch {
    // Ignore workspace pool reconciliation issues in wakeup.
  }
}

function cleanupZombieLock(dryRun: boolean, log: WakeupLogger): void {
  const lockStatus = checkLockStatus();
  if (!lockStatus.isZombie || !lockStatus.pid) {
    return;
  }

  log(`Found zombie lock (PID: ${lockStatus.pid}), cleaning...`);
  if (!dryRun) {
    removeLock();
  }
}

export async function performWakeupGlobalMaintenance(
  options: GlobalMaintenanceOptions
): Promise<WakeupResult[]> {
  const { globalDb, dryRun, log } = options;
  const results = cleanupStaleRunners(globalDb, dryRun, log);

  releaseExpiredLeases(globalDb, log);
  await reconcileStaleWorkspaces(globalDb, log);
  cleanupZombieLock(dryRun, log);

  return results;
}
