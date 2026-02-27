/**
 * Branch resolution utilities for section-targeting and pool workspace setup.
 *
 * resolveEffectiveBranch: determines the target branch for a task, preferring
 * section.branch (Phase 2+) over the project-level config default.
 *
 * ensureBranchExists: creates/tracks a branch in a workspace pool slot clone.
 * IMPORTANT: must only be called with slotPath (an isolated clone under
 * ~/.steroids/workspaces/), never with the user's projectPath.
 */

import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import { execGit } from '../workspace/git-helpers.js';

/**
 * Resolve the effective section branch override for a task.
 *
 * Returns the section-specific branch if one is configured, or null if the
 * task should use the project base branch (as resolved by prepareForTask).
 *
 * Resolution order:
 *   1. section.branch (migration 021) → return it if set
 *   2. No section override → return null (caller uses project base branch)
 *
 * Note: config is accepted for forward compat (future phases may use it for validation).
 */
export function resolveEffectiveBranch(
  db: Database.Database,
  sectionId: string | null,
  _config: SteroidsConfig
): string | null {
  if (!sectionId) return null;
  try {
    const row = db
      .prepare('SELECT branch FROM sections WHERE id = ?')
      .get(sectionId) as { branch: string | null } | undefined;
    return row?.branch ?? null;
  } catch {
    // Section row not found or branch column missing (pre-migration DB)
    return null;
  }
}

/**
 * Ensure a branch exists in the given slot path (an isolated pool clone).
 *
 * Resolution order:
 *   1. Remote branch exists → check out and track it
 *   2. Local branch exists → check out
 *   3. Neither → create from projectBase and push to remote
 *
 * NEVER call this on the user's projectPath — it issues git checkouts that
 * would corrupt an active working tree.
 */
export function ensureBranchExists(
  slotPath: string,
  branch: string,
  baseBranch: string,
  remote: string
): void {
  // Check remote branch first
  const hasRemote = execGit(
    slotPath,
    ['rev-parse', '--verify', `${remote}/${branch}`],
    { tolerateFailure: true }
  );
  if (hasRemote !== null) {
    execGit(slotPath, ['checkout', '-B', branch, `${remote}/${branch}`]);
    return;
  }

  // Check local branch
  const hasLocal = execGit(
    slotPath,
    ['rev-parse', '--verify', branch],
    { tolerateFailure: true }
  );
  if (hasLocal !== null) {
    execGit(slotPath, ['checkout', branch]);
    return;
  }

  // Create from project base and push
  execGit(slotPath, ['checkout', '-B', branch, `${remote}/${baseBranch}`]);
  execGit(slotPath, ['push', remote, branch]);
}
