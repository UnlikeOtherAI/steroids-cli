/**
 * Deterministic git helper functions for workspace pool lifecycle.
 * All operations are synchronous and host-controlled — no LLM involvement.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ExecGitOptions {
  /** Timeout in milliseconds (default 120_000). */
  timeoutMs?: number;
  /** If true, return null on non-zero exit instead of throwing. */
  tolerateFailure?: boolean;
}

/**
 * Run a git command synchronously.  Returns trimmed stdout on success.
 * Throws on non-zero exit unless `tolerateFailure` is set.
 */
export function execGit(
  cwd: string,
  args: string[],
  options?: ExecGitOptions
): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options?.timeoutMs ?? 120_000,
    }).trim();
  } catch (error) {
    if (options?.tolerateFailure) {
      return null;
    }
    throw error;
  }
}

/**
 * Check if a repository is shallow.
 */
export function isShallowRepository(cwd: string): boolean {
  const result = execGit(cwd, ['rev-parse', '--is-shallow-repository'], {
    tolerateFailure: true,
  });
  return result === 'true';
}

/**
 * Check if the repo is in a mid-rebase state.
 */
export function hasMidRebase(cwd: string): boolean {
  return (
    existsSync(join(cwd, '.git', 'rebase-merge')) ||
    existsSync(join(cwd, '.git', 'rebase-apply')) ||
    existsSync(join(cwd, '.git', 'REBASE_HEAD'))
  );
}

/**
 * Abort an in-progress rebase. Tolerates exit 128 (no rebase in progress).
 */
export function abortRebase(cwd: string): void {
  execGit(cwd, ['rebase', '--abort'], { tolerateFailure: true });
}

/**
 * Resolve the base branch (main or master) from the remote.
 * Returns the branch name without `origin/` prefix.
 * For local-only mode, pass `remote = null` to check local branches.
 */
export function resolveBaseBranch(cwd: string, remote: string | null): string | null {
  const prefix = remote ? `${remote}/` : '';

  // Check main first
  const mainResult = execGit(cwd, ['rev-parse', '--verify', `${prefix}main`], {
    tolerateFailure: true,
  });
  if (mainResult) return 'main';

  // Then master
  const masterResult = execGit(cwd, ['rev-parse', '--verify', `${prefix}master`], {
    tolerateFailure: true,
  });
  if (masterResult) return 'master';

  return null;
}

/**
 * Push a refspec with retry and exponential backoff.
 * Returns true on success.
 */
export function pushWithRetries(
  cwd: string,
  remote: string,
  refspec: string,
  retries: number = 3,
  backoffMs: number[] = [1000, 4000, 16000],
  forceWithLease: boolean = false
): { success: boolean; error?: string } {
  const pushArgs = ['push', remote, refspec];
  if (forceWithLease) {
    pushArgs.push('--force-with-lease');
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    const result = execGit(cwd, pushArgs, {
      tolerateFailure: true,
      timeoutMs: 120_000,
    });
    if (result !== null) {
      return { success: true };
    }

    if (attempt < retries - 1 && attempt < backoffMs.length) {
      const delay = backoffMs[attempt];
      // Synchronous sleep via busy-wait is acceptable here since this runs
      // in the host process between git operations.
      const end = Date.now() + delay;
      while (Date.now() < end) {
        // busy-wait
      }
    }
  }

  return { success: false, error: `Push failed after ${retries} attempts` };
}

/**
 * Check if `ancestor` is an ancestor of `descendant`.
 */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = execGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], {
    tolerateFailure: true,
  });
  // `--is-ancestor` exits 0 (success) if true, 1 if false.
  // execGit returns null on non-zero exit when tolerateFailure is set.
  // But execFileSync only throws on non-zero exit. The result when successful is empty string.
  return result !== null;
}

/**
 * Get the porcelain status (empty string = clean worktree).
 */
export function getStatusPorcelain(cwd: string): string {
  return execGit(cwd, ['status', '--porcelain']) || '';
}

/**
 * Get log entries between two refs (oneline format).
 */
export function getLogOneline(cwd: string, range: string): string {
  return execGit(cwd, ['log', range, '--oneline'], { tolerateFailure: true }) || '';
}
