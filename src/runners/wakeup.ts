/**
 * Cron wake-up command for restarting stale/dead runners
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { checkLockStatus, removeLock } from './lock.js';
import { openGlobalDatabase } from './global-db.js';
import { findStaleRunners } from './heartbeat.js';
import { getRegisteredProjects } from './projects.js';
import { openDatabase } from '../database/connection.js';
import { loadConfig } from '../config/loader.js';
import { recoverStuckTasks } from '../health/stuck-task-recovery.js';
import { cleanupInvocationLogs } from '../cleanup/invocation-logs.js';

export interface WakeupOptions {
  quiet?: boolean;
  dryRun?: boolean;
}

export interface WakeupResult {
  action: 'none' | 'started' | 'restarted' | 'cleaned' | 'would_start';
  reason: string;
  runnerId?: string;
  pid?: number;
  staleRunners?: number;
  pendingTasks?: number;
  projectPath?: string;
  recoveredActions?: number;
  skippedRecoveryDueToSafetyLimit?: boolean;
  deletedInvocationLogs?: number;
}

/**
 * Check if a project has pending work
 */
async function projectHasPendingWork(projectPath: string): Promise<boolean> {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    // Use dynamic import for ESM compatibility
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status IN ('pending', 'in_progress', 'review')`
      )
      .get() as { count: number };

    db.close();
    return result.count > 0;
  } catch {
    return false;
  }
}

/**
 * Check if there's an active runner for a specific project
 * Exported for use in daemon startup checks
 */
export function hasActiveRunnerForProject(projectPath: string): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM runners
         WHERE project_path = ?
         AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes')
         AND parallel_session_id IS NULL`
      )
      .get(projectPath) as { 1: number } | undefined;

    return row !== undefined;
  } finally {
    close();
  }
}

export function hasActiveParallelSessionForProject(projectPath: string): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM parallel_sessions
         WHERE project_path = ?
           AND status NOT IN ('completed', 'failed', 'aborted')`
      )
      .get(projectPath) as { 1: number } | undefined;

    return row !== undefined;
  } finally {
    close();
  }
}

function releaseExpiredWorkstreamLeases(db: ReturnType<typeof openGlobalDatabase>['db']): number {
  const result = db.prepare(
    `UPDATE workstreams
     SET runner_id = NULL,
         lease_expires_at = NULL
     WHERE status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= datetime('now')`
  ).run();

  return result.changes;
}

/**
 * Kill a process by PID
 */
function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a new runner daemon
 * Uses 'steroids runners start --detach' so the runner registers in the global DB
 * and updates heartbeat, allowing hasActiveRunnerForProject() to detect it
 */
function startRunner(projectPath: string): { pid: number } | null {
  try {
    // Use runners start --detach so the daemon registers itself in the global DB
    // This is critical: hasActiveRunnerForProject() checks the runners table,
    // and only the daemon (not loop directly) writes to that table
    const args = ['runners', 'start', '--detach', '--project', projectPath];

    const child = spawn('steroids', args, {
      cwd: projectPath,
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    return { pid: child.pid ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Main wake-up function
 * Called by cron every minute to ensure runners are healthy
 * Iterates over ALL registered projects and starts runners as needed
 * Returns per-project results
 */
/**
 * Record the last wakeup invocation time
 */
function recordWakeupTime(): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO _global_schema (key, value) VALUES ('last_wakeup_at', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = datetime('now')`
    ).run();
  } finally {
    close();
  }
}

/**
 * Get the last wakeup invocation time
 */
export function getLastWakeupTime(): string | null {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare("SELECT value FROM _global_schema WHERE key = 'last_wakeup_at'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    close();
  }
}

export async function wakeup(options: WakeupOptions = {}): Promise<WakeupResult[]> {
  const { quiet = false, dryRun = false } = options;
  const results: WakeupResult[] = [];

  const log = (msg: string): void => {
    if (!quiet) console.log(msg);
  };

  // Record wakeup invocation time (even for dry runs)
  if (!dryRun) {
    recordWakeupTime();
  }

  // Step 1: Clean up stale runners first
  const global = openGlobalDatabase();
  try {
    try {
      const staleRunners = findStaleRunners(global.db);
      if (staleRunners.length > 0) {
        log(`Found ${staleRunners.length} stale runner(s), cleaning up...`);
        if (!dryRun) {
          for (const runner of staleRunners) {
            if (runner.pid) {
              killProcess(runner.pid);
            }
            global.db.prepare(
              `UPDATE workstreams
               SET runner_id = NULL,
                   lease_expires_at = datetime('now')
               WHERE runner_id = ?`
            ).run(runner.id);
            global.db.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
          }
        }
        results.push({
          action: 'cleaned',
          reason: `Cleaned ${staleRunners.length} stale runner(s)`,
          staleRunners: staleRunners.length,
        });
      }
    } catch {
      // ignore global DB issues; wakeup will still attempt per-project checks
    }

    try {
      const releasedLeases = releaseExpiredWorkstreamLeases(global.db);
      if (releasedLeases > 0) {
        log(`Released ${releasedLeases} expired workstream lease(s)`);
      }
    } catch {
      // ignore lease cleanup issues in wakeup
    }

  // Step 2: Clean zombie lock if present
  const lockStatus = checkLockStatus();
  if (lockStatus.isZombie && lockStatus.pid) {
    log(`Found zombie lock (PID: ${lockStatus.pid}), cleaning...`);
    if (!dryRun) {
      removeLock();
    }
  }

  // Step 3: Get all registered projects from global registry
  const registeredProjects = getRegisteredProjects(false); // enabled only

  if (registeredProjects.length === 0) {
    log('No registered projects found');
    log('Run "steroids projects add <path>" to register a project');
    results.push({
      action: 'none',
      reason: 'No registered projects',
      pendingTasks: 0,
    });
    return results;
  }

  log(`Checking ${registeredProjects.length} registered project(s)...`);

  // Step 4: Check each project and start runners as needed
  for (const project of registeredProjects) {
    // Skip if project directory doesn't exist
    if (!existsSync(project.path)) {
      log(`Skipping ${project.path}: directory not found`);
      results.push({
        action: 'none',
        reason: 'Directory not found',
        projectPath: project.path,
      });
      continue;
    }

    // Phase 6 (live monitoring): best-effort retention cleanup of invocation activity logs.
    // This is safe to run even if the project has no pending tasks.
    let deletedInvocationLogs = 0;
    try {
      const cleanup = cleanupInvocationLogs(project.path, { retentionDays: 7, dryRun });
      deletedInvocationLogs = cleanup.deletedFiles;
      if (cleanup.deletedFiles > 0 && !quiet) {
        log(`Cleaned ${cleanup.deletedFiles} old invocation log(s) in ${project.path}`);
      }
    } catch {
      // Ignore cleanup errors; wakeup must remain robust.
    }

    // Skip if project already has an active runner
    // Check for pending work
    const hasWork = await projectHasPendingWork(project.path);
    if (!hasWork) {
      log(`Skipping ${project.path}: no pending tasks`);
      results.push({
        action: 'none',
        reason: 'No pending tasks',
        projectPath: project.path,
        deletedInvocationLogs,
      });
      continue;
    }

    // Skip projects currently executing a parallel session before attempting recovery/startup.
    // This prevents parallel runners from being interfered with by a cron-managed runner.
    if (hasActiveParallelSessionForProject(project.path)) {
      log(`Skipping ${project.path}: active parallel session in progress`);
      results.push({
        action: 'none',
        reason: 'Parallel session already running',
        projectPath: project.path,
        deletedInvocationLogs,
      });
      continue;
    }

    // Step 4a: Recover stuck tasks (best-effort) before deciding whether to (re)start a runner.
    // This is what unblocks orphaned/infinite-hang scenarios without manual intervention.

    let recoveredActions = 0;
    let skippedRecoveryDueToSafetyLimit = false;
    try {
      const { db: projectDb, close: closeProjectDb } = openDatabase(project.path);
      try {
        const config = loadConfig(project.path);
        const recovery = await recoverStuckTasks({
          projectPath: project.path,
          projectDb,
          globalDb: global.db,
          config,
          dryRun,
        });
        recoveredActions = recovery.actions.length;
        skippedRecoveryDueToSafetyLimit = recovery.skippedDueToSafetyLimit;
        if (recoveredActions > 0 && !quiet) {
          log(`Recovered ${recoveredActions} stuck item(s) in ${project.path}`);
        }
        if (skippedRecoveryDueToSafetyLimit && !quiet) {
          log(`Skipping auto-recovery in ${project.path}: safety limit hit (maxIncidentsPerHour)`);
        }
      } finally {
        closeProjectDb();
      }
    } catch {
      // If recovery can't run (DB missing/corrupt), we still proceed with runner checks.
    }

    // Skip if project already has an active runner (after recovery, which may have killed/removed it).
    if (hasActiveRunnerForProject(project.path)) {
      log(`Skipping ${project.path}: runner already active`);
      results.push({
        action: 'none',
        reason:
          recoveredActions > 0
            ? `Runner already active (recovered ${recoveredActions} stuck item(s))`
            : 'Runner already active',
        projectPath: project.path,
        recoveredActions,
        skippedRecoveryDueToSafetyLimit,
        deletedInvocationLogs,
      });
      continue;
    }

    // Start runner for this project
    log(`Starting runner for: ${project.path}`);

    if (dryRun) {
      results.push({
        action: 'would_start',
        reason: recoveredActions > 0 ? `Recovered ${recoveredActions} stuck item(s); would start runner (dry-run)` : `Would start runner (dry-run)`,
        projectPath: project.path,
        recoveredActions,
        skippedRecoveryDueToSafetyLimit,
        deletedInvocationLogs,
      });
      continue;
    }

    const startResult = startRunner(project.path);
    if (startResult) {
      results.push({
        action: 'started',
        reason: recoveredActions > 0 ? `Recovered ${recoveredActions} stuck item(s); started runner` : `Started runner`,
        pid: startResult.pid,
        projectPath: project.path,
        recoveredActions,
        skippedRecoveryDueToSafetyLimit,
        deletedInvocationLogs,
      });
    } else {
      results.push({
        action: 'none',
        reason: recoveredActions > 0 ? `Recovered ${recoveredActions} stuck item(s); failed to start runner` : 'Failed to start runner',
        projectPath: project.path,
        recoveredActions,
        skippedRecoveryDueToSafetyLimit,
        deletedInvocationLogs,
      });
    }
  }

  // If no specific results, add a summary
  if (results.length === 0) {
    results.push({
      action: 'none',
      reason: 'No action needed',
    });
  }

    return results;
  } finally {
    global.close();
  }
}

/**
 * Check if wake-up is needed without taking action
 */
export async function checkWakeupNeeded(): Promise<{
  needed: boolean;
  reason: string;
}> {
  const lockStatus = checkLockStatus();

  if (lockStatus.locked && lockStatus.pid) {
    const { db, close } = openGlobalDatabase();
    try {
      const staleRunners = findStaleRunners(db);
      if (staleRunners.length > 0) {
        return {
          needed: true,
          reason: `${staleRunners.length} stale runner(s) need cleanup`,
        };
      }
      return { needed: false, reason: 'Runner is healthy' };
    } finally {
      close();
    }
  }

  if (lockStatus.isZombie) {
    return { needed: true, reason: 'Zombie lock needs cleanup' };
  }

  // Check registered projects
  const registeredProjects = getRegisteredProjects(false);
  let projectsWithWork = 0;

  for (const project of registeredProjects) {
    if (existsSync(project.path) && (await projectHasPendingWork(project.path))) {
      projectsWithWork++;
    }
  }

  if (projectsWithWork > 0) {
    return {
      needed: true,
      reason: `${projectsWithWork} project(s) have pending tasks`,
    };
  }

  return { needed: false, reason: 'No pending tasks' };
}
