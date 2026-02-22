/**
 * Merge workspace preparation and cleanup
 */

import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { getProjectHash } from './clone.js';
import { hasCherryPickInProgress, gitStatusLines } from './merge-git.js';
import { ParallelMergeError } from './merge-errors.js';

export function ensureMergeWorkingTree(projectPath: string): void {
  const lines = gitStatusLines(projectPath);
  if (lines.length === 0) return;

  if (!hasCherryPickInProgress(projectPath)) {
    throw new ParallelMergeError(
      'Working tree is dirty. Commit or stash changes before merging.',
      'DIRTY_WORKTREE'
    );
  }
}

export function cleanupWorkspaceState(
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
