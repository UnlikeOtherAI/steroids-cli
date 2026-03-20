import { existsSync } from 'node:fs';

import { loadConfig } from '../config/loader.js';
import { getTask, type TaskStatus } from '../database/queries.js';
import { openDatabase } from '../database/connection.js';
import { getRegisteredProjects } from '../runners/projects.js';
import type { WakeupLogger } from '../runners/wakeup-types.js';
import { resolveRemoteUrl } from './pool.js';
import { execGit, isAncestor, resolveBaseBranch } from './git-helpers.js';

const TASK_BRANCH_PREFIX = 'steroids/task-';
const REMOTE_NAME = 'origin';
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  'completed',
  'disputed',
  'failed',
  'skipped',
  'partial',
  'blocked_error',
  'blocked_conflict',
]);

export interface StaleRemoteBranch {
  branchName: string;
  taskId: string;
  reason: 'merged_completed' | 'terminal_not_completed';
}

interface RemoteTaskBranch {
  branchName: string;
  sha: string;
}

function listRemoteTaskBranches(projectPath: string): RemoteTaskBranch[] {
  const output = execGit(
    projectPath,
    ['ls-remote', '--heads', REMOTE_NAME, `refs/heads/${TASK_BRANCH_PREFIX}*`],
    { tolerateFailure: true, timeoutMs: 30_000 }
  );

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .map(([sha, ref]) => ({ sha: sha ?? '', ref: ref ?? '' }))
    .filter(({ sha, ref }) => sha.length > 0 && ref.startsWith('refs/heads/'))
    .map(({ sha, ref }) => ({
      sha,
      branchName: ref.slice('refs/heads/'.length),
    }))
    .filter(({ branchName }) => branchName.startsWith(TASK_BRANCH_PREFIX));
}

function getTaskIdFromBranch(branchName: string): string | null {
  if (!branchName.startsWith(TASK_BRANCH_PREFIX)) {
    return null;
  }

  const taskId = branchName.slice(TASK_BRANCH_PREFIX.length).trim();
  return taskId.length > 0 ? taskId : null;
}

export function identifyStaleBranches(projectPath: string): StaleRemoteBranch[] {
  if (!existsSync(projectPath) || !resolveRemoteUrl(projectPath)) {
    return [];
  }

  const branches = listRemoteTaskBranches(projectPath);
  if (branches.length === 0) {
    return [];
  }

  const config = loadConfig(projectPath);
  const baseBranch = resolveBaseBranch(projectPath, REMOTE_NAME, config.git?.branch ?? null);
  execGit(projectPath, ['fetch', REMOTE_NAME, baseBranch], {
    tolerateFailure: true,
    timeoutMs: 120_000,
  });

  const { db, close } = openDatabase(projectPath);
  try {
    const staleBranches: StaleRemoteBranch[] = [];

    for (const branch of branches) {
      const taskId = getTaskIdFromBranch(branch.branchName);
      if (!taskId) continue;

      const task = getTask(db, taskId);
      if (!task || !TERMINAL_TASK_STATUSES.has(task.status)) {
        continue;
      }

      const remoteBaseRef = `${REMOTE_NAME}/${baseBranch}`;
      if (!isAncestor(projectPath, branch.sha, remoteBaseRef)) {
        continue;
      }

      if (task.status !== 'completed') {
        staleBranches.push({
          branchName: branch.branchName,
          taskId,
          reason: 'terminal_not_completed',
        });
        continue;
      }

      staleBranches.push({
        branchName: branch.branchName,
        taskId,
        reason: 'merged_completed',
      });
    }

    return staleBranches;
  } finally {
    close();
  }
}

export function cleanupStaleRemoteTaskBranches(dryRun: boolean, log: WakeupLogger): number {
  let deleted = 0;

  for (const project of getRegisteredProjects(true)) {
    let staleBranches: StaleRemoteBranch[] = [];
    try {
      staleBranches = identifyStaleBranches(project.path);
    } catch {
      continue;
    }

    for (const branch of staleBranches) {
      if (!dryRun) {
        const deletedRemote = execGit(
          project.path,
          ['push', REMOTE_NAME, '--delete', branch.branchName],
          { tolerateFailure: true, timeoutMs: 120_000 }
        );
        if (deletedRemote === null) {
          continue;
        }
      }
      deleted++;
    }
  }

  if (deleted > 0) {
    log(`Deleted ${deleted} stale remote task branch(es)`);
  }

  return deleted;
}
