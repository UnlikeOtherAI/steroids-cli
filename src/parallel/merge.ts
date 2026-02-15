/**
 * Parallel merge orchestration
 * Cherry-picks completed workstream branches into main with crash-safe progress tracking.
 */

import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { getDefaultWorkspaceRoot } from './clone.js';
import { getProjectHash } from './clone.js';
import { openDatabase } from '../database/connection.js';
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
}

export interface MergeResult {
  success: boolean;
  completedCommits: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

const DEFAULT_REMOTE = 'origin';
const DEFAULT_MAIN_BRANCH = 'main';
const DEFAULT_LOCK_TIMEOUT_MINUTES = 120;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

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

async function processWorkstream(
  db: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  sessionId: string,
  workstream: MergeWorkstreamSpec,
  mainBranch: string,
  remote: string,
  progressRows: MergeProgressRow[],
  heartbeat: { sessionId: string; runnerId: string; timeoutMinutes: number }
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
      summary.applied += 1;
      continue;
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
      upsertProgressEntry(db, sessionId, workstream.id, position, commitSha, 'applied');
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

    refreshMergeLock(db, heartbeat.sessionId, heartbeat.runnerId, heartbeat.timeoutMinutes);
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

  const { db, close } = openDatabase(projectPath);
  const summary: MergeResult = {
    success: false,
    completedCommits: 0,
    conflicts: 0,
    skipped: 0,
    errors: [],
  };

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

    const recoveringFromCherryPick = hasCherryPickInProgress(projectPath);

    heartbeatTimer = setInterval(() => {
      try {
        refreshMergeLock(db, sessionId, runnerId, lockTimeoutMinutes);
      } catch {
        // If heartbeat fails, merge keeps running until lock-dependent operations fail.
      }
    }, heartbeatIntervalMs);

    ensureMergeWorkingTree(projectPath);

    for (const stream of workstreams) {
      safeRunMergeCommand(projectPath, remote, stream.branchName);
    }

    if (!recoveringFromCherryPick) {
      const pullOutput = runGitCommand(projectPath, ['pull', '--ff-only', remote, mainBranch], { allowFailure: true });
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
        projectPath,
        sessionId,
        workstream,
        mainBranch,
        remote,
        progressRows,
        { sessionId, runnerId, timeoutMinutes: lockTimeoutMinutes }
      );

      summary.completedCommits += stats.applied;
      summary.skipped += stats.skipped;
      summary.conflicts += stats.conflicts;
    }

    const pushResult = runGitCommand(projectPath, ['push', remote, mainBranch], { allowFailure: true });
    if (isNoPushError(pushResult)) {
      summary.errors.push('Push to main failed.');
      throw new ParallelMergeError(pushResult, 'PUSH_FAILED');
    }

    for (const stream of workstreams) {
      try {
        runGitCommand(projectPath, ['push', remote, '--delete', stream.branchName]);
      } catch {
        // Ignore branch delete failures; branch may already be deleted.
      }
    }

    runGitCommand(projectPath, ['remote', 'prune', remote]);
    cleanupWorkspaceState(projectPath, workspaceRoot, workstreams.map((stream) => stream.id), {
      cleanupOnSuccess,
    });

    summary.success = true;
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!summary.errors.includes(message)) {
      summary.errors.push(message);
    }
    return summary;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    releaseMergeLock(db, sessionId, runnerId);
    close();
  }
}

export {
  MergeLockRecord,
  ParallelMergeError,
  getNowISOString,
  cleanupWorkspaceState,
};
