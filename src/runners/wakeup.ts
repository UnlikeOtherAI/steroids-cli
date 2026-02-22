/**
 * Cron wake-up command for restarting stale/dead runners
 */

import { existsSync } from 'node:fs';
import { checkLockStatus, removeLock } from './lock.js';
import { openGlobalDatabase } from './global-db.js';
import { findStaleRunners } from './heartbeat.js';
import { getRegisteredProjects } from './projects.js';
import { openDatabase } from '../database/connection.js';
import { loadConfig } from '../config/loader.js';
import { recoverStuckTasks } from '../health/stuck-task-recovery.js';
import { cleanupInvocationLogs } from '../cleanup/invocation-logs.js';

// Import from helper files
import {
  SanitiseSummary,
  runPeriodicSanitiseForProject,
  sanitisedActionCount,
} from './wakeup-sanitise.js';
import { reconcileParallelSessionRecovery } from './wakeup-reconcile.js';
import {
  projectHasPendingWork,
  hasActiveRunnerForProject,
  hasActiveParallelSessionForProject,
} from './wakeup-checks.js';
import { startRunner, killProcess, restartWorkstreamRunner } from './wakeup-runner.js';
import { recordWakeupTime, getLastWakeupTime } from './wakeup-timing.js';

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
  sanitisedActions?: number;
}

export { getLastWakeupTime, hasActiveRunnerForProject, hasActiveParallelSessionForProject };

/**
 * Main wake-up function
 * Called by cron every minute to ensure runners are healthy
 * Iterates over ALL registered projects and starts runners as needed
 * Returns per-project results
 */
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
      const releasedLeases = global.db.prepare(
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

      let recoveredActions = 0;
      let skippedRecoveryDueToSafetyLimit = false;
      let sanitisedActions = 0;

      try {
        const { db: projectDb, close: closeProjectDb } = openDatabase(project.path);
        try {
          const sanitiseSummary = runPeriodicSanitiseForProject(
            global.db,
            projectDb,
            project.path,
            dryRun
          );
          sanitisedActions = sanitisedActionCount(sanitiseSummary);
          if (sanitisedActions > 0 && !quiet) {
            log(`Sanitised ${sanitisedActions} stale item(s) in ${project.path}`);
          }

          // Step 4a: Recover stuck tasks (best-effort) before deciding whether to (re)start a runner.
          // This is what unblocks orphaned/infinite-hang scenarios without manual intervention.
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
        // If sanitise/recovery can't run (DB missing/corrupt), we still proceed with runner checks.
      }

      // Check for pending work after sanitise/recovery
      const hasWork = await projectHasPendingWork(project.path);
      if (!hasWork) {
        const noWorkReason =
          sanitisedActions > 0
            ? `No pending tasks after sanitise (${sanitisedActions} action(s))`
            : 'No pending tasks';
        log(`Skipping ${project.path}: ${noWorkReason.toLowerCase()}`);
        results.push({
          action: 'none',
          reason: noWorkReason,
          projectPath: project.path,
          recoveredActions,
          skippedRecoveryDueToSafetyLimit,
          deletedInvocationLogs,
          sanitisedActions,
        });
        continue;
      }

      const projectConfig = loadConfig(project.path);
      const parallelEnabled = projectConfig.runners?.parallel?.enabled === true;
      const configuredMaxClonesRaw = Number(projectConfig.runners?.parallel?.maxClones);
      const configuredMaxClones =
        Number.isFinite(configuredMaxClonesRaw) && configuredMaxClonesRaw > 0
          ? configuredMaxClonesRaw
          : 3;

      // Skip projects currently executing a parallel session before attempting recovery/startup.
      // This prevents parallel runners from being interfered with by a cron-managed runner.
      if (hasActiveParallelSessionForProject(project.path)) {
        let retrySummary = '';
        let scaledDown = 0;
        let resumed = 0;
        let wouldScaleDown = 0;
        let wouldResume = 0;
        const activeSessions = global.db
          .prepare(
            `SELECT id
             FROM parallel_sessions
             WHERE project_path = ?
               AND status NOT IN ('completed', 'failed', 'aborted', 'blocked_validation', 'blocked_recovery')`
          )
          .all(project.path) as Array<{ id: string }>;

        for (const session of activeSessions) {
          const sessionRunners = global.db
            .prepare(
              `SELECT id, pid, status, current_task_id
               FROM runners
               WHERE parallel_session_id = ?
                 AND status != 'stopped'
                 AND heartbeat_at > datetime('now', '-5 minutes')
               ORDER BY started_at DESC, heartbeat_at DESC`
            )
            .all(session.id) as Array<{
              id: string;
              pid: number | null;
              status: string | null;
              current_task_id: string | null;
            }>;

          if (sessionRunners.length > configuredMaxClones) {
            const idleCandidate = sessionRunners.find(
              (r) => (r.status ?? '').toLowerCase() === 'idle' && !r.current_task_id
            );
            if (idleCandidate) {
              if (dryRun) {
                wouldScaleDown += 1;
              } else {
                if (idleCandidate.pid) {
                  killProcess(idleCandidate.pid);
                }
                global.db.prepare(
                  `UPDATE workstreams
                   SET runner_id = NULL,
                       lease_expires_at = datetime('now', '+5 minutes'),
                       next_retry_at = datetime('now', '+5 minutes'),
                       last_reconcile_action = 'concurrency_throttle',
                       last_reconciled_at = datetime('now')
                   WHERE session_id = ?
                     AND runner_id = ?`
                ).run(session.id, idleCandidate.id);
                global.db.prepare('DELETE FROM runners WHERE id = ?').run(idleCandidate.id);
                scaledDown += 1;
              }
            }
          } else if (sessionRunners.length < configuredMaxClones) {
            const throttled = global.db
              .prepare(
                `SELECT id
                 FROM workstreams
                 WHERE session_id = ?
                   AND status = 'running'
                   AND runner_id IS NULL
                   AND next_retry_at > datetime('now')
                   AND last_reconcile_action = 'concurrency_throttle'
                 ORDER BY last_reconciled_at ASC
                 LIMIT 1`
              )
              .get(session.id) as { id: string } | undefined;

            if (throttled) {
              if (dryRun) {
                wouldResume += 1;
              } else {
                global.db.prepare(
                  `UPDATE workstreams
                   SET lease_expires_at = datetime('now'),
                       next_retry_at = datetime('now'),
                       last_reconcile_action = 'concurrency_resume',
                       last_reconciled_at = datetime('now')
                   WHERE id = ?`
                ).run(throttled.id);
                resumed += 1;
              }
            }
          }
        }

        if (!dryRun) {
          const recovery = reconcileParallelSessionRecovery(global.db, project.path);
          if (recovery.workstreamsToRestart.length > 0) {
            for (const ws of recovery.workstreamsToRestart) {
              restartWorkstreamRunner(ws);
            }
            retrySummary += `, restarted ${recovery.workstreamsToRestart.length} workstream runner(s)`;
          }
          if (recovery.blockedWorkstreams > 0) {
            retrySummary += `, blocked ${recovery.blockedWorkstreams} workstream(s)`;
          }
          if (scaledDown > 0) {
            retrySummary += `, scaled down ${scaledDown} idle runner(s) to maxClones=${configuredMaxClones}`;
          }
          if (resumed > 0) {
            retrySummary += `, resumed ${resumed} throttled workstream(s)`;
          }
        } else {
          if (wouldScaleDown > 0) {
            retrySummary += `, would scale down ${wouldScaleDown} idle runner(s) to maxClones=${configuredMaxClones}`;
          }
          if (wouldResume > 0) {
            retrySummary += `, would resume ${wouldResume} throttled workstream(s)`;
          }
        }

        log(`Skipping ${project.path}: active parallel session in progress${retrySummary}`);
        results.push({
          action: 'none',
          reason: `Parallel session already running${retrySummary}`,
          projectPath: project.path,
          deletedInvocationLogs,
        });
        continue;
      }

      // Config-aware mode reconciliation:
      // if parallel is enabled but an idle standalone runner is active, recycle it
      // so wakeup applies current parallel settings without manual restart.
      const activeStandaloneRunner = global.db
        .prepare(
          `SELECT id, pid, status, current_task_id
           FROM runners
           WHERE project_path = ?
             AND parallel_session_id IS NULL
             AND status != 'stopped'
             AND heartbeat_at > datetime('now', '-5 minutes')
           ORDER BY heartbeat_at DESC
           LIMIT 1`
        )
        .get(project.path) as
        | { id: string; pid: number | null; status: string | null; current_task_id: string | null }
        | undefined;

      if (activeStandaloneRunner && parallelEnabled) {
        const isIdle = (activeStandaloneRunner.status ?? '').toLowerCase() === 'idle' && !activeStandaloneRunner.current_task_id;
        if (isIdle) {
          if (dryRun) {
            log(`Would recycle idle standalone runner for ${project.path} to apply parallel mode`);
            results.push({
              action: 'would_start',
              reason: 'Would restart idle runner to apply parallel mode',
              projectPath: project.path,
              deletedInvocationLogs,
            });
            continue;
          }

          if (activeStandaloneRunner.pid) {
            killProcess(activeStandaloneRunner.pid);
          }
          global.db.prepare('DELETE FROM runners WHERE id = ?').run(activeStandaloneRunner.id);

          const restartResult = startRunner(project.path);
          if (restartResult) {
            results.push({
              action: 'restarted',
              reason: 'Restarted idle runner to apply parallel mode',
              pid: restartResult.pid,
              projectPath: project.path,
              deletedInvocationLogs,
            });
          } else {
            results.push({
              action: 'none',
              reason: 'Failed to restart idle runner for parallel mode',
              projectPath: project.path,
              deletedInvocationLogs,
            });
          }
          continue;
        }
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
          sanitisedActions,
        });
        continue;
      }

      // Start runner for this project
      const willParallel = parallelEnabled;
      log(`Starting ${willParallel ? 'parallel session' : 'runner'} for: ${project.path}`);

      if (dryRun) {
        results.push({
          action: 'would_start',
          reason: recoveredActions > 0 ? `Recovered ${recoveredActions} stuck item(s); would start runner (dry-run)` : `Would start runner (dry-run)`,
          projectPath: project.path,
          recoveredActions,
          skippedRecoveryDueToSafetyLimit,
          deletedInvocationLogs,
          sanitisedActions,
        });
        continue;
      }

      const startResult = startRunner(project.path);
      if (startResult) {
        const mode = startResult.parallel ? 'parallel session' : 'runner';
        results.push({
          action: 'started',
          reason: recoveredActions > 0 ? `Recovered ${recoveredActions} stuck item(s); started ${mode}` : `Started ${mode}`,
          pid: startResult.pid,
          projectPath: project.path,
          recoveredActions,
          skippedRecoveryDueToSafetyLimit,
          deletedInvocationLogs,
          sanitisedActions,
        });
      } else {
        results.push({
          action: 'none',
          reason: recoveredActions > 0 ? `Recovered ${recoveredActions} stuck item(s); failed to start runner` : 'Failed to start runner',
          projectPath: project.path,
          recoveredActions,
          skippedRecoveryDueToSafetyLimit,
          deletedInvocationLogs,
          sanitisedActions,
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
