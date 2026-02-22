/**
 * Parallel merge orchestration
 * Cherry-picks completed workstream branches into main with crash-safe progress tracking.
 */

import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getDefaultWorkspaceRoot } from './clone.js';
import { getProjectHash } from './clone.js';
import { createIntegrationWorkspace } from './clone.js';
import { openDatabase } from '../database/connection.js';
import {
  openGlobalDatabase,
  recordValidationEscalation,
  resolveValidationEscalationsForSession,
  updateParallelSessionStatus,
} from '../runners/global-db.js';
import {
  getCommitShortSha,
  getWorkstreamCommitList,
  hasCherryPickInProgress,
  gitStatusLines,
  safeRunMergeCommand,
  runGitCommand,
  isNoPushError,
} from './merge-git.js';
import {
  MergeLockRecord,
  acquireMergeLock,
  assertMergeLockEpoch,
  refreshMergeLock,
  releaseMergeLock,
} from './merge-lock.js';
import {
  clearProgressEntry,
  listMergeProgress,
  upsertProgressEntry,
  getMergeProgressForWorkstream,
  MergeProgressRow,
} from './merge-progress.js';
import { runConflictResolutionCycle } from './merge-conflict.js';
import { ParallelMergeError } from './merge-errors.js';

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
const VALIDATION_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const VALIDATION_SNIPPET_LIMIT = 8_000;

function getNowISOString(): string {
  return new Date().toISOString();
}

function ensureMergeWorkingTree(projectPath: string): void {
  const lines = gitStatusLines(projectPath);
  if (lines.length === 0) return;

  if (!hasCherryPickInProgress(projectPath)) {
    throw new ParallelMergeError(
      'Working tree is dirty. Commit or stash changes before merging.',
      'DIRTY_WORKTREE'
    );
  }
}

function cleanupWorkspaceState(
  projectPath: string,
  workspaceRoot: string,
  workstreamIds: string[],
  options: { cleanupOnSuccess: boolean }
): void {
  if (!options.cleanupOnSuccess) return;

  const baseRoot = resolve(workspaceRoot);
  const hash = getProjectHash(projectPath);
  const projectWorkspaceRoot = resolve(baseRoot, hash);

  if (!projectWorkspaceRoot.startsWith(baseRoot)) {
    return;
  }

  for (const workstreamId of workstreamIds) {
    const folder = resolve(
      projectWorkspaceRoot,
      workstreamId.startsWith('ws-') ? workstreamId : `ws-${workstreamId}`
    );

    if (resolve(folder).startsWith(projectWorkspaceRoot)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

function runValidationGate(mergePath: string, validationCommand?: string): void {
  if (!validationCommand || validationCommand.trim().length === 0) {
    return;
  }

  try {
    execSync(validationCommand, {
      cwd: mergePath,
      stdio: 'pipe',
      encoding: 'utf-8',
      maxBuffer: VALIDATION_MAX_BUFFER_BYTES,
    });
  } catch (error: unknown) {
    const err = error as Error & { code?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? '';
    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString() ?? '';
    if (err.code === 'ENOBUFS') {
      throw new ParallelMergeError(
        'Validation gate output exceeded the maximum buffer size. Reduce output verbosity or split the command.',
        'VALIDATION_FAILED',
        {
          details: {
            command: validationCommand.trim(),
            stderr: stderr ?? '',
            stdout: stdout ?? '',
          },
        }
      );
    }

    const message = [stderr, stdout, err.message].filter(Boolean).join('\n') || String(error);
    throw new ParallelMergeError(
      `Validation gate failed: ${message}`,
      'VALIDATION_FAILED',
      {
        details: {
          command: validationCommand.trim(),
          stderr,
          stdout,
        },
      }
    );
  }
}

function snippet(value: string | null | undefined, limit = VALIDATION_SNIPPET_LIMIT): string {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }

  return trimmed.slice(-limit);
}

function isAppliedCommitIntegrated(projectPath: string, commitSha: string | null): boolean {
  if (!commitSha) {
    return false;
  }

  const output = runGitCommand(
    projectPath,
    ['branch', '--contains', commitSha, '--list', 'HEAD'],
    { allowFailure: true }
  );
  const lower = output.toLowerCase();

  if (lower.includes('fatal:') || lower.includes('error:')) {
    return false;
  }

  return output.trim().length > 0;
}

function resolveGitSha(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (/fatal:|error:/i.test(trimmed)) return null;
  return trimmed.split('\n').at(-1)?.trim() ?? null;
}

function sealWorkstreamsForMerge(
  mergeDb: ReturnType<typeof openDatabase>['db'],
  sessionId: string,
  runnerId: string,
  lockEpoch: number,
  mergePath: string,
  remote: string,
  mainBranch: string,
  workstreams: MergeWorkstreamSpec[]
): void {
  const { db, close } = openGlobalDatabase();
  try {
    const sealedEntries: Array<{
      streamId: string;
      sealedBaseSha: string;
      sealedHeadSha: string;
      commits: string[];
      completionOrder: number;
    }> = [];

    assertMergeLockEpoch(mergeDb, sessionId, runnerId, lockEpoch);

    for (let index = 0; index < workstreams.length; index += 1) {
      assertMergeLockEpoch(mergeDb, sessionId, runnerId, lockEpoch);
      const stream = workstreams[index];
      const commits = getWorkstreamCommitList(mergePath, remote, stream.branchName, mainBranch);
      const sealedHeadSha = resolveGitSha(
        runGitCommand(mergePath, ['rev-parse', `${remote}/${stream.branchName}`], { allowFailure: true })
      );
      const sealedBaseSha = resolveGitSha(
        runGitCommand(mergePath, ['merge-base', `${remote}/${mainBranch}`, `${remote}/${stream.branchName}`], { allowFailure: true })
      );

      if (!sealedHeadSha || !sealedBaseSha) {
        throw new ParallelMergeError(
          `Could not resolve sealed merge SHAs for ${remote}/${stream.branchName}`,
          'REMOTE_BRANCH_MISSING'
        );
      }

      sealedEntries.push({
        streamId: stream.id,
        sealedBaseSha,
        sealedHeadSha,
        commits,
        completionOrder: index + 1,
      });
    }

    const applySealedUpdates = db.transaction(() => {
      for (const entry of sealedEntries) {
        const update = db.prepare(
          `UPDATE workstreams
           SET sealed_base_sha = ?,
               sealed_head_sha = ?,
               sealed_commit_shas = ?,
               completion_order = COALESCE(completion_order, ?),
               completed_at = COALESCE(completed_at, datetime('now')),
               status = 'completed'
           WHERE session_id = ?
             AND id = ?
             AND status IN ('running', 'completed')`
        ).run(
          entry.sealedBaseSha,
          entry.sealedHeadSha,
          JSON.stringify(entry.commits),
          entry.completionOrder,
          sessionId,
          entry.streamId
        );

        if (update.changes !== 1) {
          throw new ParallelMergeError(
            `Workstream lease check failed while sealing ${entry.streamId}`,
            'LEASE_FENCE_FAILED'
          );
        }
      }
    });

    applySealedUpdates();
  } finally {
    close();
  }
}

async function processWorkstream(
  db: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  sessionId: string,
  workstream: MergeWorkstreamSpec,
  mainBranch: string,
  remote: string,
  progressRows: MergeProgressRow[],
  heartbeat: { sessionId: string; runnerId: string; timeoutMinutes: number; lockEpoch: number }
): Promise<{ applied: number; skipped: number; conflicts: number }> {
  const summary = { applied: 0, skipped: 0, conflicts: 0 };
  const commits = getWorkstreamCommitList(projectPath, remote, workstream.branchName, mainBranch);

  if (commits.length === 0) {
    return summary;
  }

  const workstreamProgress = getMergeProgressForWorkstream(progressRows, workstream.id);
  const workstreamLookup = new Map<number, MergeProgressRow>();
  for (const row of workstreamProgress) {
    workstreamLookup.set(row.position, row);
  }

  for (let position = 0; position < commits.length; position += 1) {
    const commitSha = commits[position];
    const shortSha = getCommitShortSha(commitSha);
    const prior = workstreamLookup.get(position);

    if (prior?.status === 'applied' && prior.commit_sha === commitSha) {
      if (isAppliedCommitIntegrated(projectPath, prior.applied_commit_sha)) {
        summary.applied += 1;
        continue;
      }

      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    if (prior?.status === 'skipped' && prior.commit_sha === commitSha) {
      summary.skipped += 1;
      continue;
    }

    if (prior?.status === 'conflict' && prior.commit_sha === commitSha) {
      if (hasCherryPickInProgress(projectPath)) {
      const outcome = await runConflictResolutionCycle({
        db,
        projectPath,
        sessionId,
        workstreamId: workstream.id,
        runnerId: heartbeat.runnerId,
        mergeLockHeartbeat: {
          lockEpoch: heartbeat.lockEpoch,
          timeoutMinutes: heartbeat.timeoutMinutes,
        },
        branchName: workstream.branchName,
        position,
        commitSha,
        existingTaskId: prior.conflict_task_id ?? undefined,
      });

        if (outcome === 'skipped') summary.skipped += 1;
        else summary.applied += 1;
        summary.conflicts += 1;
        continue;
      }

      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    if (prior && prior.commit_sha !== commitSha) {
      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    try {
      runGitCommand(projectPath, ['cherry-pick', commitSha]);
      const appliedCommitSha = runGitCommand(projectPath, ['rev-parse', 'HEAD']).trim();
      upsertProgressEntry(
        db,
        sessionId,
        workstream.id,
        position,
        commitSha,
        'applied',
        null,
        appliedCommitSha
      );
      summary.applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CONFLICT|merge conflict|could not apply|needs merge/i.test(message)) {
        throw error;
      }

      const outcome = await runConflictResolutionCycle({
        db,
        projectPath,
        sessionId,
        workstreamId: workstream.id,
        runnerId: heartbeat.runnerId,
        mergeLockHeartbeat: {
          lockEpoch: heartbeat.lockEpoch,
          timeoutMinutes: heartbeat.timeoutMinutes,
        },
        branchName: workstream.branchName,
        position,
        commitSha,
      });

      if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.applied += 1;
      }

      summary.conflicts += 1;
    }

    refreshMergeLock(
      db,
      heartbeat.sessionId,
      heartbeat.runnerId,
      heartbeat.timeoutMinutes,
      heartbeat.lockEpoch
    );
  }

  return summary;
}

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
  getNowISOString,
  cleanupWorkspaceState,
};
