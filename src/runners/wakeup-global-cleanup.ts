import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { checkLockStatus, removeLock } from './lock.js';
import { findStaleRunners } from './heartbeat.js';
import { isProcessAlive } from './lock.js';
import { openDatabase } from '../database/connection.js';
import { killProcess } from './wakeup-runner.js';
import type { WakeupLogger, WakeupResult } from './wakeup-types.js';
import { cleanupStaleRemoteTaskBranches } from '../workspace/remote-branch-cleanup.js';

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
    const deadRunners = globalDb.prepare(
      `SELECT r.id, r.pid, r.heartbeat_at, r.current_task_id,
              COALESCE(ps.project_path, r.project_path) AS project_path,
              r.parallel_session_id
       FROM runners r
       LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE r.status != 'idle'`
    ).all() as Array<{
      id: string;
      pid: number | null;
      heartbeat_at: string;
      current_task_id: string | null;
      project_path: string | null;
      parallel_session_id: string | null;
    }>;

    const abandonedById = new Map<string, typeof deadRunners[number]>();
    for (const runner of staleRunners) {
      abandonedById.set(runner.id, runner);
    }
    for (const runner of deadRunners) {
      if (runner.pid !== null && isProcessAlive(runner.pid)) {
        continue;
      }
      abandonedById.set(runner.id, runner);
    }

    const abandonedRunners = [...abandonedById.values()];
    if (abandonedRunners.length === 0) {
      return results;
    }

    log(`Found ${abandonedRunners.length} abandoned runner(s), cleaning up...`);

    if (!dryRun) {
      for (const runner of abandonedRunners) {
        cleanupStaleRunnerTaskState(runner);

        if (runner.pid && isProcessAlive(runner.pid)) {
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
      reason: `Cleaned ${abandonedRunners.length} abandoned runner(s)`,
      staleRunners: abandonedRunners.length,
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

const STALE_PROVIDER_HOME_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const PROVIDER_HOME_PREFIXES = ['steroids-claude-', 'steroids-codex-', 'steroids-gemini-', 'steroids-mistral-'];

/**
 * Remove stale provider isolated-HOME directories from temp locations.
 * These are created by setupIsolatedHome() in each provider and should be
 * cleaned by the provider's close/error handler. When the runner process is
 * SIGTERM'd, the cleanup never fires and dirs accumulate (with npm caches
 * reaching 500MB+ each).
 *
 * Scans both os.tmpdir() and /private/tmp (macOS /tmp symlink target) since
 * older versions may have used a different temp root.
 */
export function cleanStaleProviderHomes(dryRun: boolean, log: WakeupLogger): number {
  let cleaned = 0;
  const cutoffMs = Date.now() - STALE_PROVIDER_HOME_AGE_MS;

  // Collect unique directories to scan
  const dirsToScan = new Set<string>();
  dirsToScan.add(tmpdir());
  // macOS: /tmp → /private/tmp, but os.tmpdir() returns /var/folders/.../T/
  if (process.platform === 'darwin') {
    dirsToScan.add('/private/tmp');
  }

  for (const scanDir of dirsToScan) {
    try {
      const entries = readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!PROVIDER_HOME_PREFIXES.some((p) => entry.name.startsWith(p))) continue;

        const dirPath = join(scanDir, entry.name);
        try {
          const stat = statSync(dirPath);
          if (stat.mtimeMs > cutoffMs) continue; // Still fresh, skip

          if (!dryRun) {
            rmSync(dirPath, { recursive: true, force: true });
          }
          cleaned++;
        } catch {
          // Stat or remove failed — skip this entry
        }
      }
    } catch {
      // Directory listing failed — not critical
    }
  }

  if (cleaned > 0) {
    log(`Cleaned ${cleaned} stale provider home dir(s)`);
  }

  return cleaned;
}

const TERMINAL_SESSION_STATUSES = ['completed', 'failed', 'aborted'];
const MAX_POOL_SLOTS_PER_PROJECT = 2;

/**
 * Remove workstream clone directories for completed/failed parallel sessions,
 * and prune excess idle pool slots beyond MAX_POOL_SLOTS_PER_PROJECT.
 *
 * Workstream clones (ws-*) are single-use — once the session ends, they're
 * dead weight. Pool slots (pool-*) are reusable across sessions, so we keep
 * a small number per project for fast re-start.
 */
async function pruneCompletedWorkspaces(globalDb: any, dryRun: boolean, log: WakeupLogger): Promise<number> {
  let cleaned = 0;

  try {
    // 1. Clean workstream clone dirs for terminal sessions
    const terminalClones = globalDb.prepare(
      `SELECT w.clone_path
       FROM workstreams w
       JOIN parallel_sessions s ON s.id = w.session_id
       WHERE s.status IN (${TERMINAL_SESSION_STATUSES.map(() => '?').join(',')})
         AND w.clone_path IS NOT NULL`
    ).all(...TERMINAL_SESSION_STATUSES) as Array<{ clone_path: string }>;

    for (const row of terminalClones) {
      if (!row.clone_path || !existsSync(row.clone_path)) continue;

      if (!dryRun) {
        try {
          rmSync(row.clone_path, { recursive: true, force: true });
          cleaned++;
        } catch {
          // Ignore individual removal failures
        }
      } else {
        cleaned++;
      }
    }

    // 2. Prune excess idle pool slots (keep MAX per project)
    const projectIds = globalDb.prepare(
      `SELECT DISTINCT project_id FROM workspace_pool_slots`
    ).all() as Array<{ project_id: string }>;

    for (const { project_id } of projectIds) {
      // Get all idle slots for this project, ordered by index (keep lowest)
      const idleSlots = globalDb.prepare(
        `SELECT id, slot_path, slot_index FROM workspace_pool_slots
         WHERE project_id = ? AND status = 'idle'
         ORDER BY slot_index ASC`
      ).all(project_id) as Array<{ id: number; slot_path: string; slot_index: number }>;

      // Keep the first MAX slots, prune the rest
      const toPrune = idleSlots.slice(MAX_POOL_SLOTS_PER_PROJECT);
      for (const slot of toPrune) {
        if (!dryRun) {
          try {
            if (slot.slot_path && existsSync(slot.slot_path)) {
              rmSync(slot.slot_path, { recursive: true, force: true });
            }
            globalDb.prepare('DELETE FROM workspace_pool_slots WHERE id = ?').run(slot.id);
            cleaned++;
          } catch {
            // Ignore individual removal failures
          }
        } else {
          cleaned++;
        }
      }
    }
    // 3. Remove entire workspace dirs for unregistered projects
    const { getRegisteredProjects } = await import('./projects.js');
    const { getProjectHash } = await import('../parallel/clone.js');
    const registeredHashes = new Set(
      getRegisteredProjects(false).map((p: { path: string }) => getProjectHash(p.path))
    );
    const workspaceRoot = join(homedir(), '.steroids', 'workspaces');
    if (existsSync(workspaceRoot)) {
      // Remove entire hash dirs for unregistered projects
      try {
        for (const hashEntry of readdirSync(workspaceRoot, { withFileTypes: true })) {
          if (!hashEntry.isDirectory()) continue;
          if (registeredHashes.has(hashEntry.name)) continue; // Active project, skip

          const hashDir = join(workspaceRoot, hashEntry.name);
          if (!dryRun) {
            try {
              rmSync(hashDir, { recursive: true, force: true });
              // Also clean DB records for this project hash
              globalDb.prepare('DELETE FROM workspace_pool_slots WHERE project_id = ?').run(hashEntry.name);
              cleaned++;
            } catch {
              // Ignore
            }
          } else {
            cleaned++;
          }
        }
      } catch {
        // Ignore workspace root scan errors
      }

      // Build set of all known clone paths from DB
      const allClonePaths = new Set<string>();
      const dbClones = globalDb.prepare(
        'SELECT clone_path FROM workstreams WHERE clone_path IS NOT NULL'
      ).all() as Array<{ clone_path: string }>;
      for (const c of dbClones) allClonePaths.add(c.clone_path);

      const dbSlots = globalDb.prepare(
        'SELECT slot_path FROM workspace_pool_slots WHERE slot_path IS NOT NULL'
      ).all() as Array<{ slot_path: string }>;
      for (const s of dbSlots) allClonePaths.add(s.slot_path);

      // Scan each project hash dir for orphan ws-*/pool-* subdirs
      try {
        for (const hashEntry of readdirSync(workspaceRoot, { withFileTypes: true })) {
          if (!hashEntry.isDirectory()) continue;
          const hashDir = join(workspaceRoot, hashEntry.name);

          for (const sub of readdirSync(hashDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            if (!sub.name.startsWith('ws-')) continue; // Only clean ws-* orphans; keep pool-* slots

            const subPath = join(hashDir, sub.name);
            if (allClonePaths.has(subPath)) continue; // Tracked in DB, skip

            if (!dryRun) {
              try {
                rmSync(subPath, { recursive: true, force: true });
                cleaned++;
              } catch {
                // Ignore
              }
            } else {
              cleaned++;
            }
          }
        }
      } catch {
        // Ignore workspace root scan errors
      }
    }
  } catch {
    // Workspace cleanup errors must not block other wakeup steps
  }

  if (cleaned > 0) {
    log(`Pruned ${cleaned} stale workspace clone(s) / excess pool slot(s)`);
  }

  return cleaned;
}

export async function performWakeupGlobalMaintenance(
  options: GlobalMaintenanceOptions
): Promise<WakeupResult[]> {
  const { globalDb, dryRun, log } = options;
  const results = cleanupStaleRunners(globalDb, dryRun, log);

  releaseExpiredLeases(globalDb, log);
  await reconcileStaleWorkspaces(globalDb, log);
  cleanupZombieLock(dryRun, log);
  cleanStaleProviderHomes(dryRun, log);
  cleanupStaleRemoteTaskBranches(dryRun, log);
  await pruneCompletedWorkspaces(globalDb, dryRun, log);

  return results;
}
