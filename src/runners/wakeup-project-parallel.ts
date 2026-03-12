import { hasActiveParallelSessionForProject } from './wakeup-checks.js';
import { startRunner, killProcess, restartWorkstreamRunner } from './wakeup-runner.js';
import { reconcileParallelSessionRecovery } from './wakeup-reconcile.js';
import type { WakeupLogger, WakeupResult } from './wakeup-types.js';

interface ProjectParallelOptions {
  globalDb: any;
  projectPath: string;
  dryRun: boolean;
  log: WakeupLogger;
  parallelEnabled: boolean;
  configuredMaxClones: number;
  deletedInvocationLogs: number;
}

type SessionRunner = {
  id: string;
  pid: number | null;
  status: string | null;
  current_task_id: string | null;
};

function getActiveSessions(globalDb: any, projectPath: string): Array<{ id: string }> {
  return globalDb.prepare(
    `SELECT id
     FROM parallel_sessions
     WHERE project_path = ?
       AND status NOT IN ('completed', 'failed', 'aborted', 'blocked_validation', 'blocked_recovery')`
  ).all(projectPath) as Array<{ id: string }>;
}

function getSessionRunners(globalDb: any, sessionId: string): SessionRunner[] {
  return globalDb.prepare(
    `SELECT id, pid, status, current_task_id
     FROM runners
     WHERE parallel_session_id = ?
       AND status != 'stopped'
       AND heartbeat_at > datetime('now', '-5 minutes')
     ORDER BY started_at DESC, heartbeat_at DESC`
  ).all(sessionId) as SessionRunner[];
}

function buildResult(
  action: WakeupResult['action'],
  reason: string,
  projectPath: string,
  deletedInvocationLogs: number,
  pid?: number
): WakeupResult {
  return { action, reason, projectPath, deletedInvocationLogs, pid };
}

function recycleIdleParallelSessionsForSingleMode(options: {
  activeSessions: Array<{ id: string }>;
  globalDb: any;
  dryRun: boolean;
  log: WakeupLogger;
  projectPath: string;
  deletedInvocationLogs: number;
}): WakeupResult | null {
  const { activeSessions, globalDb, dryRun, log, projectPath, deletedInvocationLogs } = options;
  if (activeSessions.length === 0) {
    return null;
  }

  const sessionRunners = activeSessions.flatMap((session) => getSessionRunners(globalDb, session.id));
  const hasBusyRunner = sessionRunners.some(
    (runner) => (runner.status ?? '').toLowerCase() !== 'idle' || !!runner.current_task_id
  );

  if (hasBusyRunner) {
    const reason = 'Parallel->single mode switch pending (active workstream runner busy)';
    log(`Skipping ${projectPath}: ${reason.toLowerCase()}`);
    return buildResult(dryRun ? 'would_start' : 'none', reason, projectPath, deletedInvocationLogs);
  }

  if (dryRun) {
    const reason = 'Would recycle idle parallel session to apply single-runner mode';
    log(`Would reconcile ${projectPath}: ${reason.toLowerCase()}`);
    return buildResult('would_start', reason, projectPath, deletedInvocationLogs);
  }

  for (const runner of sessionRunners) {
    if (runner.pid) {
      killProcess(runner.pid);
    }
    globalDb.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
  }

  for (const session of activeSessions) {
    globalDb.prepare(
      `UPDATE workstreams
       SET status = 'aborted',
           runner_id = NULL,
           lease_expires_at = NULL,
           next_retry_at = NULL,
           last_reconcile_action = 'mode_switch_to_single',
           last_reconciled_at = datetime('now'),
           completed_at = COALESCE(completed_at, datetime('now'))
       WHERE session_id = ?
         AND status NOT IN ('completed', 'failed', 'aborted')`
    ).run(session.id);

    globalDb.prepare(
      `UPDATE parallel_sessions
       SET status = 'aborted',
           completed_at = COALESCE(completed_at, datetime('now'))
       WHERE id = ?`
    ).run(session.id);
  }

  return null;
}

function reconcileSessionConcurrency(options: {
  globalDb: any;
  activeSessions: Array<{ id: string }>;
  dryRun: boolean;
  configuredMaxClones: number;
}): { scaledDown: number; resumed: number; wouldScaleDown: number; wouldResume: number } {
  const { globalDb, activeSessions, dryRun, configuredMaxClones } = options;
  let scaledDown = 0;
  let resumed = 0;
  let wouldScaleDown = 0;
  let wouldResume = 0;

  for (const session of activeSessions) {
    const sessionRunners = getSessionRunners(globalDb, session.id);

    if (sessionRunners.length > configuredMaxClones) {
      const idleCandidate = sessionRunners.find(
        (runner) => (runner.status ?? '').toLowerCase() === 'idle' && !runner.current_task_id
      );

      if (!idleCandidate) {
        continue;
      }

      if (dryRun) {
        wouldScaleDown += 1;
        continue;
      }

      if (idleCandidate.pid) {
        killProcess(idleCandidate.pid);
      }
      globalDb.prepare(
        `UPDATE workstreams
         SET runner_id = NULL,
             lease_expires_at = datetime('now', '+5 minutes'),
             next_retry_at = datetime('now', '+5 minutes'),
             last_reconcile_action = 'concurrency_throttle',
             last_reconciled_at = datetime('now')
         WHERE session_id = ?
           AND runner_id = ?`
      ).run(session.id, idleCandidate.id);
      globalDb.prepare('DELETE FROM runners WHERE id = ?').run(idleCandidate.id);
      scaledDown += 1;
      continue;
    }

    if (sessionRunners.length < configuredMaxClones) {
      const throttled = globalDb.prepare(
        `SELECT id
         FROM workstreams
         WHERE session_id = ?
           AND status = 'running'
           AND runner_id IS NULL
           AND next_retry_at > datetime('now')
           AND last_reconcile_action = 'concurrency_throttle'
         ORDER BY last_reconciled_at ASC
         LIMIT 1`
      ).get(session.id) as { id: string } | undefined;

      if (!throttled) {
        continue;
      }

      if (dryRun) {
        wouldResume += 1;
        continue;
      }

      globalDb.prepare(
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

  return { scaledDown, resumed, wouldScaleDown, wouldResume };
}

function reconcileStandaloneRunnerForParallelMode(options: {
  globalDb: any;
  projectPath: string;
  dryRun: boolean;
  log: WakeupLogger;
  parallelEnabled: boolean;
  deletedInvocationLogs: number;
}): WakeupResult | null {
  const { globalDb, projectPath, dryRun, log, parallelEnabled, deletedInvocationLogs } = options;
  if (!parallelEnabled) {
    return null;
  }

  const activeStandaloneRunner = globalDb.prepare(
    `SELECT id, pid, status, current_task_id
     FROM runners
     WHERE project_path = ?
       AND parallel_session_id IS NULL
       AND status != 'stopped'
       AND heartbeat_at > datetime('now', '-5 minutes')
     ORDER BY heartbeat_at DESC
     LIMIT 1`
  ).get(projectPath) as SessionRunner | undefined;

  if (!activeStandaloneRunner) {
    return null;
  }

  const isIdle =
    (activeStandaloneRunner.status ?? '').toLowerCase() === 'idle' &&
    !activeStandaloneRunner.current_task_id;
  if (!isIdle) {
    return null;
  }

  if (dryRun) {
    log(`Would recycle idle standalone runner for ${projectPath} to apply parallel mode`);
    return buildResult(
      'would_start',
      'Would restart idle runner to apply parallel mode',
      projectPath,
      deletedInvocationLogs
    );
  }

  if (activeStandaloneRunner.pid) {
    killProcess(activeStandaloneRunner.pid);
  }
  globalDb.prepare('DELETE FROM runners WHERE id = ?').run(activeStandaloneRunner.id);

  const restartResult = startRunner(projectPath);
  if (restartResult) {
    return buildResult(
      'restarted',
      'Restarted idle runner to apply parallel mode',
      projectPath,
      deletedInvocationLogs,
      restartResult.pid
    );
  }

  return buildResult(
    'none',
    'Failed to restart idle runner for parallel mode',
    projectPath,
    deletedInvocationLogs
  );
}

export function reconcileProjectParallelState(
  options: ProjectParallelOptions
): WakeupResult | null {
  const {
    globalDb,
    projectPath,
    dryRun,
    log,
    parallelEnabled,
    configuredMaxClones,
    deletedInvocationLogs,
  } = options;

  if (hasActiveParallelSessionForProject(projectPath)) {
    let retrySummary = '';
    let skipForParallelSession = true;
    const activeSessions = getActiveSessions(globalDb, projectPath);

    if (!parallelEnabled) {
      const modeSwitchResult = recycleIdleParallelSessionsForSingleMode({
        activeSessions,
        globalDb,
        dryRun,
        log,
        projectPath,
        deletedInvocationLogs,
      });
      if (modeSwitchResult) {
        return modeSwitchResult;
      }

      if (activeSessions.length > 0) {
        skipForParallelSession = false;
        retrySummary = ', recycled idle parallel session to apply single-runner mode';
      }
    }

    const concurrencySummary = reconcileSessionConcurrency({
      globalDb,
      activeSessions,
      dryRun,
      configuredMaxClones,
    });

    if (!dryRun) {
      const recovery = reconcileParallelSessionRecovery(globalDb, projectPath);
      if (recovery.workstreamsToRestart.length > 0) {
        for (const workstream of recovery.workstreamsToRestart) {
          restartWorkstreamRunner(workstream);
        }
        retrySummary += `, restarted ${recovery.workstreamsToRestart.length} workstream runner(s)`;
      }
      if (recovery.blockedWorkstreams > 0) {
        retrySummary += `, blocked ${recovery.blockedWorkstreams} workstream(s)`;
      }
      if (concurrencySummary.scaledDown > 0) {
        retrySummary +=
          `, scaled down ${concurrencySummary.scaledDown} idle runner(s) ` +
          `to maxClones=${configuredMaxClones}`;
      }
      if (concurrencySummary.resumed > 0) {
        retrySummary += `, resumed ${concurrencySummary.resumed} throttled workstream(s)`;
      }

      if (!hasActiveParallelSessionForProject(projectPath)) {
        skipForParallelSession = false;
        retrySummary += retrySummary.length > 0 ? ', session state reconciled' : ', session state reconciled';
      }
    } else {
      if (concurrencySummary.wouldScaleDown > 0) {
        retrySummary +=
          `, would scale down ${concurrencySummary.wouldScaleDown} idle runner(s) ` +
          `to maxClones=${configuredMaxClones}`;
      }
      if (concurrencySummary.wouldResume > 0) {
        retrySummary += `, would resume ${concurrencySummary.wouldResume} throttled workstream(s)`;
      }
    }

    if (skipForParallelSession) {
      log(`Skipping ${projectPath}: active parallel session in progress${retrySummary}`);
      return buildResult(
        'none',
        `Parallel session already running${retrySummary}`,
        projectPath,
        deletedInvocationLogs
      );
    }

    log(`Reconciled stale parallel session for ${projectPath}; proceeding with startup`);
  }

  return reconcileStandaloneRunnerForParallelMode({
    globalDb,
    projectPath,
    dryRun,
    log,
    parallelEnabled,
    deletedInvocationLogs,
  });
}
