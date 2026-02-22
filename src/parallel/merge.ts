/**
 * Parallel merge orchestration
 * Cherry-picks completed workstream branches into main with crash-safe progress tracking.
 */

import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { getDefaultWorkspaceRoot, getProjectHash, createIntegrationWorkspace } from './clone.js';
import { openDatabase } from '../database/connection.js';
import {
  openGlobalDatabase,
  recordValidationEscalation,
  resolveValidationEscalationsForSession,
  updateParallelSessionStatus,
} from '../runners/global-db.js';
import {
  hasCherryPickInProgress,
  runGitCommand,
  isNoPushError,
  safeRunMergeCommand,
} from './merge-git.js';
import {
  MergeLockRecord,
  acquireMergeLock,
  assertMergeLockEpoch,
  refreshMergeLock,
  releaseMergeLock,
} from './merge-lock.js';
import { listMergeProgress } from './merge-progress.js';
import { ParallelMergeError } from './merge-errors.js';
import { runValidationGate, snippet } from './merge-validation.js';
import { ensureMergeWorkingTree, cleanupWorkspaceState } from './merge-workspace.js';
import { sealWorkstreamsForMerge } from './merge-sealing.js';
import { processWorkstream } from './merge-process.js';

export interface MergeWorkstreamSpec {
  id: string;
  branchName: string;
}

export interface MergeOptions {
  projectPath: string;
  sessionId: string;
  runnerId: string;
  workstreams: MergeWorkstreamSpec[];
  remote?: string;
  mainBranch?: string;
  lockTimeoutMinutes?: number;
  heartbeatIntervalMs?: number;
  remoteWorkspaceRoot?: string;
  cleanupOnSuccess?: boolean;
  integrationBranchName?: string;
  validationCommand?: string;
  /**
   * When true, do NOT mark the session as 'completed' after merging this
   * workstream. The caller is responsible for checking whether all workstreams
   * are done and marking the session complete. Used by autoMergeOnCompletion
   * so that a single fast workstream finishing doesn't mark the whole session
   * complete while other workstreams are still running.
   */
  skipSessionComplete?: boolean;
}

export interface MergeResult {
  success: boolean;
  completedCommits: number;
  conflicts: number;
  skipped: number;
  errors: string[];
  validationEscalationId?: string;
  validationWorkspacePath?: string;
}

const DEFAULT_REMOTE = 'origin';
const DEFAULT_MAIN_BRANCH = 'main';
const DEFAULT_LOCK_TIMEOUT_MINUTES = 120;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Run cherry-pick merge loop across completed workstreams.
 */
export async function runParallelMerge(options: MergeOptions): Promise<MergeResult> {
  const projectPath = resolve(options.projectPath);
  const sessionId = options.sessionId;
  const runnerId = options.runnerId;
  const workstreams = options.workstreams;
  const remote = options.remote ?? DEFAULT_REMOTE;
  const mainBranch = options.mainBranch ?? DEFAULT_MAIN_BRANCH;
  const lockTimeoutMinutes = options.lockTimeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const workspaceRoot = options.remoteWorkspaceRoot ?? getDefaultWorkspaceRoot();
  const cleanupOnSuccess = options.cleanupOnSuccess ?? true;
  const integrationBranchName = options.integrationBranchName ?? `steroids/integration-${sessionId.slice(0, 8)}`;
  const validationCommand = options.validationCommand;
  let mergePath = projectPath;
  let integrationWorkspacePath: string | null = null;

  const { db, close } = openDatabase(projectPath);
  const summary: MergeResult = {
    success: false,
    completedCommits: 0,
    conflicts: 0,
    skipped: 0,
    errors: [],
  };

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lockEpoch = 0;

  try {
    const lock = acquireMergeLock(db, {
      sessionId,
      runnerId,
      timeoutMinutes: lockTimeoutMinutes,
    });

    if (!lock.acquired) {
      summary.errors.push(`Could not acquire merge lock (held by ${lock.lock?.runner_id ?? 'another process'})`);
      return summary;
    }
    lockEpoch = lock.lock?.lock_epoch ?? 0;
    assertMergeLockEpoch(db, sessionId, runnerId, lockEpoch);
    updateParallelSessionStatus(sessionId, 'merging');

    const integrationWorkspace = createIntegrationWorkspace({
      projectPath,
      sessionId,
      baseBranch: mainBranch,
      remote,
      workspaceRoot,
      integrationBranchName,
    });
    mergePath = integrationWorkspace.workspacePath;
    integrationWorkspacePath = integrationWorkspace.workspacePath;

    const recoveringFromCherryPick = hasCherryPickInProgress(mergePath);

    heartbeatTimer = setInterval(() => {
      try {
        refreshMergeLock(db, sessionId, runnerId, lockTimeoutMinutes, lockEpoch);
        assertMergeLockEpoch(db, sessionId, runnerId, lockEpoch);
      } catch {
        // If heartbeat fails, merge keeps running until lock-dependent operations fail.
      }
    }, heartbeatIntervalMs);

    ensureMergeWorkingTree(mergePath);
    assertMergeLockEpoch(db, sessionId, runnerId, lockEpoch);

    for (const stream of workstreams) {
      assertMergeLockEpoch(db, sessionId, runnerId, lockEpoch);
      safeRunMergeCommand(mergePath, remote, stream.branchName);
    }
    sealWorkstreamsForMerge(
      db,
      sessionId,
      runnerId,
      lockEpoch,
      mergePath,
      remote,
      mainBranch,
      workstreams
    );

    if (!recoveringFromCherryPick) {
      const pullOutput = runGitCommand(mergePath, ['pull', '--ff-only', remote, mainBranch], { allowFailure: true });
      const pullOutputLower = pullOutput.toLowerCase();

      if (pullOutputLower.includes('fatal:') || pullOutputLower.includes('error:') || pullOutputLower.includes('error ')) {
        if (
          pullOutputLower.includes('could not apply') ||
          pullOutputLower.includes('not possible to fast-forward')
        ) {
          throw new ParallelMergeError(
            'main is behind; local commits detected. Run "git pull --rebase" before merge.',
            'NON_FAST_FORWARD'
          );
        }

        throw new ParallelMergeError(
          `Failed to refresh main from ${remote}/${mainBranch}: ${pullOutput}`,
          'PULL_FAILED'
        );
      }
    }

    const progressRows = listMergeProgress(db, sessionId);
    for (const workstream of workstreams) {
      const stats = await processWorkstream(
        db,
        mergePath,
        sessionId,
        workstream,
        mainBranch,
        remote,
        progressRows,
        { sessionId, runnerId, timeoutMinutes: lockTimeoutMinutes, lockEpoch }
      );

      summary.completedCommits += stats.applied;
      summary.skipped += stats.skipped;
      summary.conflicts += stats.conflicts;
    }

    runValidationGate(mergePath, validationCommand);

    assertMergeLockEpoch(db, sessionId, runnerId, lockEpoch);
    const pushResult = runGitCommand(mergePath, ['push', remote, mainBranch], { allowFailure: true });
    if (isNoPushError(pushResult)) {
      summary.errors.push('Push to main failed.');
      throw new ParallelMergeError(pushResult, 'PUSH_FAILED');
    }

    updateParallelSessionStatus(sessionId, 'cleanup_draining');

    for (const stream of workstreams) {
      try {
        assertMergeLockEpoch(db, sessionId, runnerId, lockEpoch);
        runGitCommand(mergePath, ['push', remote, '--delete', stream.branchName]);
      } catch {
        // Ignore branch delete failures; branch may already be deleted.
      }
    }

    runGitCommand(mergePath, ['remote', 'prune', remote]);
    if (cleanupOnSuccess) {
      cleanupWorkspaceState(projectPath, workspaceRoot, workstreams.map((stream) => stream.id), {
        cleanupOnSuccess,
      });

      if (integrationWorkspacePath) {
        rmSync(integrationWorkspacePath, { recursive: true, force: true });
        integrationWorkspacePath = null;
      }
    } else {
      updateParallelSessionStatus(sessionId, 'cleanup_pending');
    }

    summary.success = true;
    try {
      resolveValidationEscalationsForSession(sessionId);
    } catch {
      // best-effort resolution marker; merge completion should not fail because of escalation bookkeeping.
    }
    if (options.skipSessionComplete) {
      // Caller will decide when to mark session complete (e.g. after all workstreams finish).
      // Reset to 'running' so wakeup does not see a terminal-ish status and spawn a new session.
      updateParallelSessionStatus(sessionId, 'running');
    } else {
      updateParallelSessionStatus(sessionId, 'completed', true);
    }
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!summary.errors.includes(message)) {
      summary.errors.push(message);
    }
    if (error instanceof ParallelMergeError && error.code === 'VALIDATION_FAILED') {
      const commandFromError = typeof error.details?.command === 'string' ? error.details.command : null;
      const stderrFromError = typeof error.details?.stderr === 'string' ? error.details.stderr : null;
      const stdoutFromError = typeof error.details?.stdout === 'string' ? error.details.stdout : null;
      try {
        const escalation = recordValidationEscalation({
          sessionId,
          projectPath,
          workspacePath: integrationWorkspacePath ?? mergePath,
          validationCommand: commandFromError ?? (validationCommand?.trim() || '(not configured)'),
          errorMessage: message,
          stdoutSnippet: snippet(stdoutFromError),
          stderrSnippet: snippet(stderrFromError || message),
        });
        summary.validationEscalationId = escalation.id;
        summary.validationWorkspacePath = escalation.workspace_path;
        summary.errors.push(
          `Validation blocked for session ${sessionId}. Escalation ${escalation.id} created. Workspace preserved at ${escalation.workspace_path}.`
        );
      } catch (escalationError) {
        const escalationMessage =
          escalationError instanceof Error ? escalationError.message : String(escalationError);
        summary.errors.push(
          `Validation escalation persistence failed for session ${sessionId}: ${escalationMessage}. Workspace preserved at ${integrationWorkspacePath ?? mergePath}.`
        );
      }
      updateParallelSessionStatus(sessionId, 'blocked_validation', false);
    } else if (error instanceof ParallelMergeError && error.code === 'CONFLICT_ATTEMPT_LIMIT') {
      updateParallelSessionStatus(sessionId, 'blocked_conflict', false);
    } else {
      updateParallelSessionStatus(sessionId, 'failed', true);
    }
    return summary;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (cleanupOnSuccess && integrationWorkspacePath && summary.success) {
      rmSync(integrationWorkspacePath, { recursive: true, force: true });
    }

    if (lockEpoch > 0) {
      releaseMergeLock(db, sessionId, runnerId, lockEpoch);
    }
    close();
  }
}

export {
  MergeLockRecord,
  ParallelMergeError,
  cleanupWorkspaceState,
};
