import { existsSync } from 'node:fs';
import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { recoverStuckTasks } from '../health/stuck-task-recovery.js';
import { cleanupInvocationLogs } from '../cleanup/invocation-logs.js';
import { pollIntakeProject } from '../intake/poller.js';
import { syncGitHubIntakeGate } from '../intake/github-gate.js';
import { clearProviderBackoff } from './global-db.js';
import { getProviderBackoffInfo, getProjectProviderBackoff } from './global-db-backoffs.js';
import {
  SanitiseSummary,
  runPeriodicSanitiseForProject,
  sanitisedActionCount,
} from './wakeup-sanitise.js';
import {
  projectHasPendingWork,
  hasActiveRunnerForProject,
} from './wakeup-checks.js';
import { startRunner } from './wakeup-runner.js';
import { waitForRunnerRegistration } from './wakeup-registration.js';
import { reconcileProjectParallelState } from './wakeup-project-parallel.js';
import type { WakeupLogger, WakeupResult } from './wakeup-types.js';

interface ProjectMaintenanceState {
  recoveredActions: number;
  skippedRecoveryDueToSafetyLimit: boolean;
  deletedInvocationLogs: number;
  sanitisedActions: number;
  polledIntakeReports: number;
  intakePollErrors: number;
  githubGateIssuesCreated: number;
  githubGateApprovalsApplied: number;
  githubGateRejectionsApplied: number;
  githubGateErrors: number;
}

interface ProcessProjectOptions {
  globalDb: any;
  projectPath: string;
  dryRun: boolean;
  log: WakeupLogger;
}

function cleanupProjectInvocationLogs(
  projectPath: string,
  dryRun: boolean,
  log: WakeupLogger
): number {
  try {
    const cleanup = cleanupInvocationLogs(projectPath, { retentionDays: 7, dryRun });
    if (cleanup.deletedFiles > 0) {
      log(`Cleaned ${cleanup.deletedFiles} old invocation log(s) in ${projectPath}`);
    }
    return cleanup.deletedFiles;
  } catch {
    return 0;
  }
}

async function runProjectMaintenance(
  globalDb: any,
  projectPath: string,
  config: ReturnType<typeof loadConfig>,
  dryRun: boolean,
  log: WakeupLogger
): Promise<ProjectMaintenanceState> {
  const state: ProjectMaintenanceState = {
    recoveredActions: 0,
    skippedRecoveryDueToSafetyLimit: false,
    deletedInvocationLogs: cleanupProjectInvocationLogs(projectPath, dryRun, log),
    sanitisedActions: 0,
    polledIntakeReports: 0,
    intakePollErrors: 0,
    githubGateIssuesCreated: 0,
    githubGateApprovalsApplied: 0,
    githubGateRejectionsApplied: 0,
    githubGateErrors: 0,
  };

  try {
    const { db: projectDb, close: closeProjectDb } = openDatabase(projectPath);
    try {
      const intakePollSummary = await pollIntakeProject({
        projectDb,
        config,
        projectPath,
        dryRun,
      });
      state.polledIntakeReports = intakePollSummary.totalReportsPersisted;
      state.intakePollErrors = intakePollSummary.connectorResults.filter(
        (result) => result.status === 'error'
      ).length + (intakePollSummary.status === 'error' && intakePollSummary.connectorResults.length === 0 ? 1 : 0);
      if (intakePollSummary.status === 'success' || intakePollSummary.status === 'partial') {
        log(`Intake poll for ${projectPath}: ${intakePollSummary.reason}`);
      } else if (intakePollSummary.status === 'error') {
        log(`Intake poll for ${projectPath} failed: ${intakePollSummary.reason}`);
      }

      const githubGateSummary = await syncGitHubIntakeGate({
        projectDb,
        config,
        projectPath,
        dryRun,
      });
      state.githubGateIssuesCreated = githubGateSummary.issuesCreated;
      state.githubGateApprovalsApplied = githubGateSummary.approvalsApplied;
      state.githubGateRejectionsApplied = githubGateSummary.rejectionsApplied;
      state.githubGateErrors = githubGateSummary.errors.length;
      if (githubGateSummary.status === 'success' || githubGateSummary.status === 'partial') {
        log(`GitHub intake gate for ${projectPath}: ${githubGateSummary.reason}`);
      } else if (githubGateSummary.status === 'error') {
        log(`GitHub intake gate for ${projectPath} failed: ${githubGateSummary.reason}`);
      }

      const sanitiseSummary: SanitiseSummary = runPeriodicSanitiseForProject(
        globalDb,
        projectDb,
        projectPath,
        dryRun
      );
      state.sanitisedActions = sanitisedActionCount(sanitiseSummary);
      if (state.sanitisedActions > 0) {
        log(`Sanitised ${state.sanitisedActions} stale item(s) in ${projectPath}`);
      }

      const recovery = await recoverStuckTasks({
        projectPath,
        projectDb,
        globalDb,
        config,
        dryRun,
      });
      state.recoveredActions = recovery.actions.length;
      state.skippedRecoveryDueToSafetyLimit = recovery.skippedDueToSafetyLimit;

      if (state.recoveredActions > 0) {
        log(`Recovered ${state.recoveredActions} stuck item(s) in ${projectPath}`);
      }
      if (state.skippedRecoveryDueToSafetyLimit) {
        log(`Skipping auto-recovery in ${projectPath}: safety limit hit (maxIncidentsPerHour)`);
      }
    } finally {
      closeProjectDb();
    }
  } catch {
    // If maintenance can't run (DB missing/corrupt), still proceed with runner checks.
  }

  return state;
}

function createProjectResult(
  action: WakeupResult['action'],
  reason: string,
  projectPath: string,
  state: ProjectMaintenanceState,
  pid?: number
): WakeupResult {
  return {
    action,
    reason,
    pid,
    projectPath,
    recoveredActions: state.recoveredActions,
    skippedRecoveryDueToSafetyLimit: state.skippedRecoveryDueToSafetyLimit,
    deletedInvocationLogs: state.deletedInvocationLogs,
    sanitisedActions: state.sanitisedActions,
    polledIntakeReports: state.polledIntakeReports,
    intakePollErrors: state.intakePollErrors,
    githubGateIssuesCreated: state.githubGateIssuesCreated,
    githubGateApprovalsApplied: state.githubGateApprovalsApplied,
    githubGateRejectionsApplied: state.githubGateRejectionsApplied,
    githubGateErrors: state.githubGateErrors,
  };
}

// Uses shared getProjectProviderBackoff from global-db-backoffs.ts

/**
 * For auth-error backoffs, probe the provider with a quick "say hi" invocation.
 * If it succeeds, clear the backoff and return true (provider recovered).
 * If it fails, keep the backoff and return false.
 */
async function probeAuthErrorProviders(projectPath: string, log: WakeupLogger): Promise<boolean> {
  const projectConfig = loadConfig(projectPath);
  const coderProvider = projectConfig.ai?.coder?.provider;
  const reviewerProvider = projectConfig.ai?.reviewer?.provider;
  const multiReviewerProviders = (projectConfig.ai?.reviewers ?? [])
    .map(r => r.provider)
    .filter(Boolean) as string[];
  const providersToCheck = [...new Set(
    [coderProvider, reviewerProvider, ...multiReviewerProviders].filter(Boolean) as string[]
  )];

  for (const providerName of providersToCheck) {
    const info = getProviderBackoffInfo(providerName);
    if (!info || info.reasonType !== 'auth_error') continue;

    // This provider has an auth-error backoff — probe it
    log(`Probing ${providerName} for auth recovery...`);
    try {
      const { getProviderRegistry } = await import('../providers/registry.js');
      const registry = await getProviderRegistry();
      const provider = registry.tryGet(providerName);
      if (!provider) continue;

      const model = (providerName === coderProvider
        ? projectConfig.ai?.coder?.model
        : providerName === reviewerProvider
          ? projectConfig.ai?.reviewer?.model
          : (projectConfig.ai?.reviewers ?? []).find(r => r.provider === providerName)?.model
      ) ?? 'default';

      const result = await provider.invoke('Say "ok".', { model, timeout: 30_000 });

      if (result.success) {
        log(`Provider ${providerName} auth recovered — clearing backoff`);
        clearProviderBackoff(providerName);
      } else {
        const classified = provider.classifyResult(result);
        if (classified?.type === 'auth_error') {
          log(`Provider ${providerName} still auth-failed: ${classified.message}`);
        } else {
          // Non-auth error on probe (rate limit, etc.) — clear auth backoff anyway
          log(`Provider ${providerName} probe failed (${classified?.type ?? 'unknown'}) but not auth — clearing auth backoff`);
          clearProviderBackoff(providerName);
        }
      }
    } catch (err) {
      log(`Provider ${providerName} probe error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Re-check if any provider is still backed off
  return getProjectProviderBackoff(projectPath) === null;
}

export async function processWakeupProject(
  options: ProcessProjectOptions
): Promise<WakeupResult> {
  const { globalDb, projectPath, dryRun, log } = options;

  if (!existsSync(projectPath)) {
    log(`Skipping ${projectPath}: directory not found`);
    return { action: 'none', reason: 'Directory not found', projectPath };
  }

  const projectConfig = loadConfig(projectPath);
  const state = await runProjectMaintenance(globalDb, projectPath, projectConfig, dryRun, log);

  const hasWork = await projectHasPendingWork(projectPath);
  if (!hasWork) {
    const noWorkReason =
      state.sanitisedActions > 0
        ? `No pending tasks after sanitise (${state.sanitisedActions} action(s))`
        : 'No pending tasks';
    log(`Skipping ${projectPath}: ${noWorkReason.toLowerCase()}`);
    return createProjectResult('none', noWorkReason, projectPath, state);
  }

  const providerBackoff = getProjectProviderBackoff(projectPath);
  if (providerBackoff) {
    // If this is an auth-error backoff, probe the provider to check recovery
    const info = getProviderBackoffInfo(providerBackoff.provider);
    if (info?.reasonType === 'auth_error') {
      const recovered = await probeAuthErrorProviders(projectPath, log);
      if (!recovered) {
        const remainingMinutes = Math.ceil(providerBackoff.remainingMs / 60000);
        log(
          `Skipping ${projectPath}: Provider '${providerBackoff.provider}' ` +
          `auth still failing (backoff ${remainingMinutes}m)`
        );
        return {
          action: 'skipped',
          reason: `Provider '${providerBackoff.provider}' auth error (backoff ${remainingMinutes}m)`,
          projectPath,
        };
      }
      // Auth recovered — fall through to normal runner spawn
    } else {
      const remainingMinutes = Math.ceil(providerBackoff.remainingMs / 60000);
      log(
        `Skipping ${projectPath}: Provider '${providerBackoff.provider}' ` +
        `is in backoff for ${remainingMinutes}m`
      );
      return {
        action: 'skipped',
        reason: `Provider '${providerBackoff.provider}' backed off for ${remainingMinutes}m`,
        projectPath,
      };
    }
  }

  const parallelEnabled = projectConfig.runners?.parallel?.enabled === true;
  const configuredMaxClonesRaw = Number(projectConfig.runners?.parallel?.maxClones);
  const configuredMaxClones =
    Number.isFinite(configuredMaxClonesRaw) && configuredMaxClonesRaw > 0
      ? configuredMaxClonesRaw
      : 3;

  const parallelResult = reconcileProjectParallelState({
    globalDb,
    projectPath,
    dryRun,
    log,
    parallelEnabled,
    configuredMaxClones,
    deletedInvocationLogs: state.deletedInvocationLogs,
  });
  if (parallelResult) {
    return parallelResult;
  }

  if (hasActiveRunnerForProject(projectPath)) {
    log(`Skipping ${projectPath}: runner already active`);
    return createProjectResult(
      'none',
      state.recoveredActions > 0
        ? `Runner already active (recovered ${state.recoveredActions} stuck item(s))`
        : 'Runner already active',
      projectPath,
      state
    );
  }

  log(`Starting ${parallelEnabled ? 'parallel session' : 'runner'} for: ${projectPath}`);
  if (dryRun) {
    return createProjectResult(
      'would_start',
      state.recoveredActions > 0
        ? `Recovered ${state.recoveredActions} stuck item(s); would start runner (dry-run)`
        : 'Would start runner (dry-run)',
      projectPath,
      state
    );
  }

  const startResult = startRunner(projectPath);
  if (!startResult) {
    return createProjectResult(
      'none',
      state.recoveredActions > 0
        ? `Recovered ${state.recoveredActions} stuck item(s); failed to start runner`
        : 'Failed to start runner',
      projectPath,
      state
    );
  }

  const mode = startResult.parallel ? 'parallel session' : 'runner';
  const registered = await waitForRunnerRegistration(
    globalDb,
    projectPath,
    startResult.parallel === true
  );

  if (!registered) {
    return createProjectResult(
      'none',
      state.recoveredActions > 0
        ? `Recovered ${state.recoveredActions} stuck item(s); ${mode} failed to register`
        : `${mode} failed to register`,
      projectPath,
      state
    );
  }

  return createProjectResult(
    'started',
    state.recoveredActions > 0
      ? `Recovered ${state.recoveredActions} stuck item(s); started ${mode}`
      : `Started ${mode}`,
    projectPath,
    state,
    startResult.pid
  );
}
