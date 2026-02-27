/**
 * Deterministic git lifecycle for workspace pool slots.
 *
 * All git operations are host-controlled. The LLM may commit freely
 * during coding but never runs branching, reset, push, rebase, or merge.
 */

import type Database from 'better-sqlite3';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { PoolSlot } from './types.js';
import {
  execGit,
  hasMidRebase,
  abortRebase,
  resolveBaseBranch,
  isShallowRepository,
  pushWithRetries,
  isAncestor,
  getStatusPorcelain,
  getLogOneline,
} from './git-helpers.js';
import { updateSlotStatus, ensureSlotClone } from './pool.js';
import {
  acquireWorkspaceMergeLock,
  releaseWorkspaceMergeLock,
} from './merge-lock.js';
import { ensureWorkspaceSteroidsSymlink } from '../parallel/clone.js';

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export type PrepareResult =
  | { ok: true; startingSha: string; baseBranch: string; taskBranch: string }
  | { ok: false; reason: string; blocked: boolean };

export type PostCoderResult =
  | { ok: true; autoCommitted: boolean }
  | { ok: false; reason: string };

export type MergeResult =
  | { ok: true; mergedSha: string }
  | { ok: false; reason: string; conflict: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Task Pickup — Clean Slate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prepare a pool slot for a new task.
 * Implements Phase 1 steps 1–10 from the design doc.
 */
export function prepareForTask(
  globalDb: Database.Database,
  slot: PoolSlot,
  taskId: string,
  projectPath: string
): PrepareResult {
  const slotPath = slot.slot_path;
  let localOnly = slot.remote_url === null;
  const remote = 'origin';

  // Ensure the clone exists
  try {
    ensureSlotClone(slot, slot.remote_url, projectPath);
  } catch (error) {
    return {
      ok: false,
      reason: `Failed to ensure slot clone: ${error instanceof Error ? error.message : String(error)}`,
      blocked: true,
    };
  }

  // Self-heal: if slot has no remote_url, check if the clone's origin points to
  // a local repo that itself has a real remote. Repair both the clone and the DB.
  if (localOnly) {
    const cloneOrigin = execGit(slotPath, ['remote', 'get-url', 'origin'], { tolerateFailure: true });
    if (cloneOrigin && (cloneOrigin.startsWith('/') || cloneOrigin.startsWith('.') || cloneOrigin.startsWith('~'))) {
      try {
        // Normalize relative/tilde origins against slotPath before resolving.
        const resolvedOrigin = cloneOrigin.startsWith('.')
          ? resolve(slotPath, cloneOrigin)
          : cloneOrigin;
        const upstreamRemote = execFileSync('git', ['remote', 'get-url', 'origin'], {
          cwd: resolvedOrigin,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (upstreamRemote && !upstreamRemote.startsWith('/') && !upstreamRemote.startsWith('.') && !upstreamRemote.startsWith('~')) {
          // Repair: update the clone's origin and the DB record.
          execGit(slotPath, ['remote', 'set-url', 'origin', upstreamRemote]);
          globalDb.prepare('UPDATE workspace_pool_slots SET remote_url = ? WHERE id = ?')
            .run(upstreamRemote, slot.id);
          // Update in-memory slot to prevent re-clone fallback from re-poisoning.
          slot.remote_url = upstreamRemote;
          localOnly = false;
        }
      } catch {
        // Can't resolve upstream — leave as localOnly.
      }
    }
  }

  // Step 2: Mid-rebase guard
  if (hasMidRebase(slotPath)) {
    abortRebase(slotPath);
  }

  // Step 3: Fetch (skip for local-only)
  if (!localOnly) {
    const fetchResult = execGit(slotPath, ['fetch', remote], {
      tolerateFailure: true,
      timeoutMs: 120_000,
    });
    if (fetchResult === null) {
      return {
        ok: false,
        reason: 'git fetch origin failed',
        blocked: false,
      };
    }
  }

  // Step 4: Resolve base branch
  const baseBranch = resolveBaseBranch(slotPath, localOnly ? null : remote);
  if (!baseBranch) {
    return {
      ok: false,
      reason: 'No valid base branch (neither main nor master found)',
      blocked: true,
    };
  }

  // Step 5: Reset to base
  const baseRef = localOnly ? baseBranch : `${remote}/${baseBranch}`;
  execGit(slotPath, ['checkout', baseBranch], { tolerateFailure: true });
  execGit(slotPath, ['reset', '--hard', baseRef]);

  // Step 6: Clean worktree (preserve .steroids)
  execGit(slotPath, ['clean', '-fd', '-e', '.steroids']);

  // Step 7: Verify clean state
  let porcelain = getStatusPorcelain(slotPath);
  if (porcelain.length > 0) {
    // Delete directory and re-clone once
    rmSync(slotPath, { recursive: true, force: true });
    try {
      ensureSlotClone(slot, slot.remote_url, projectPath);
    } catch (error) {
      return {
        ok: false,
        reason: `Re-clone failed: ${error instanceof Error ? error.message : String(error)}`,
        blocked: true,
      };
    }

    // Re-run steps 3–6
    if (!localOnly) {
      execGit(slotPath, ['fetch', remote], { tolerateFailure: true, timeoutMs: 120_000 });
    }
    execGit(slotPath, ['checkout', baseBranch], { tolerateFailure: true });
    execGit(slotPath, ['reset', '--hard', baseRef]);
    execGit(slotPath, ['clean', '-fd', '-e', '.steroids']);

    porcelain = getStatusPorcelain(slotPath);
    if (porcelain.length > 0) {
      return {
        ok: false,
        reason: 'Worktree not clean after re-clone',
        blocked: true,
      };
    }
  }

  // Step 8: Record starting SHA
  const startingSha = execGit(slotPath, ['rev-parse', 'HEAD']);
  if (!startingSha) {
    return { ok: false, reason: 'Cannot determine HEAD sha', blocked: true };
  }

  // Step 9: Create task branch (-B handles reruns)
  const taskBranch = `steroids/task-${taskId}`;
  execGit(slotPath, ['checkout', '-B', taskBranch]);

  // Step 10: Update DB
  updateSlotStatus(globalDb, slot.id, 'coder_active', {
    task_id: taskId,
    task_branch: taskBranch,
    base_branch: baseBranch,
    starting_sha: startingSha,
  });

  return { ok: true, startingSha, baseBranch, taskBranch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Post-Coder Verification Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After coder exits, verify and auto-commit if needed.
 * Returns ok=false if no commits were made (task should retry).
 */
export function postCoderGate(
  slotPath: string,
  startingSha: string,
  taskTitle: string
): PostCoderResult {
  // Step 1: Check for uncommitted work
  const porcelain = getStatusPorcelain(slotPath);
  let autoCommitted = false;

  if (porcelain.length > 0) {
    execGit(slotPath, ['add', '-A']);
    const message = `feat: implement ${taskTitle} (auto-committed by steroids)`;
    execGit(slotPath, ['commit', '-m', message]);
    autoCommitted = true;
  }

  // Step 2: Check for any commits since task pickup
  const log = getLogOneline(slotPath, `${startingSha}..HEAD`);
  if (!log || log.trim().length === 0) {
    return { ok: false, reason: 'No changes detected' };
  }

  return { ok: true, autoCommitted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 Pre-step: Post-Review Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discard any uncommitted reviewer changes.
 */
export function postReviewGate(slotPath: string): void {
  const porcelain = getStatusPorcelain(slotPath);
  if (porcelain.length > 0) {
    console.warn('[workspace] Discarding uncommitted reviewer changes');
    execGit(slotPath, ['checkout', '--', '.']);
    execGit(slotPath, ['clean', '-fd']);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Post-Review Merge Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full merge pipeline: rebase, push, ff-only merge, push base, verify, cleanup.
 * Acquires merge lock for serialization.
 */
export function mergeToBase(
  globalDb: Database.Database,
  slot: PoolSlot,
  taskId: string
): MergeResult {
  const slotPath = slot.slot_path;
  const localOnly = slot.remote_url === null;
  const remote = 'origin';
  const baseBranch = slot.base_branch!;
  const taskBranch = slot.task_branch!;
  const startingSha = slot.starting_sha!;
  const baseRef = localOnly ? baseBranch : `${remote}/${baseBranch}`;

  // Step 2: Verify commits exist
  const log = getLogOneline(slotPath, `${startingSha}..HEAD`);
  if (!log || log.trim().length === 0) {
    return { ok: false, reason: 'No commits to merge', conflict: false };
  }

  // Step 3: Acquire merge lock
  const lockAcquired = acquireWorkspaceMergeLock(
    globalDb,
    slot.project_id,
    slot.runner_id!,
    slot.id,
    300_000,  // 5 min timeout
    5_000     // 5s poll
  );
  if (!lockAcquired) {
    return {
      ok: false,
      reason: 'Could not acquire merge lock within 5 minutes',
      conflict: false,
    };
  }

  // Update status to merging
  updateSlotStatus(globalDb, slot.id, 'merging');

  try {
    // Step 4: Fetch base (skip for local-only)
    if (!localOnly) {
      execGit(slotPath, ['fetch', remote, baseBranch], {
        timeoutMs: 120_000,
      });
    }

    // Step 5: Rebase task branch onto base
    const rebaseResult = execGit(
      slotPath,
      ['rebase', baseRef],
      { tolerateFailure: true }
    );
    if (rebaseResult === null) {
      // Rebase failed (likely conflicts)
      abortRebase(slotPath);
      execGit(slotPath, ['rebase', '--abort'], { tolerateFailure: true });
      releaseWorkspaceMergeLock(globalDb, slot.project_id);
      return { ok: false, reason: 'Rebase conflict', conflict: true };
    }

    if (!localOnly) {
      // Step 6: Push task branch with force-with-lease
      const pushTaskResult = pushWithRetries(
        slotPath,
        remote,
        taskBranch,
        3,
        [1000, 4000, 16000],
        true // --force-with-lease
      );
      if (!pushTaskResult.success) {
        releaseWorkspaceMergeLock(globalDb, slot.project_id);
        return {
          ok: false,
          reason: pushTaskResult.error || 'Push task branch failed',
          conflict: false,
        };
      }
    }

    // Step 7: Merge to base branch (ff-only)
    execGit(slotPath, ['checkout', baseBranch]);
    execGit(slotPath, ['reset', '--hard', baseRef]);
    const mergeResult = execGit(
      slotPath,
      ['merge', '--ff-only', taskBranch],
      { tolerateFailure: true }
    );
    if (mergeResult === null) {
      releaseWorkspaceMergeLock(globalDb, slot.project_id);
      return {
        ok: false,
        reason: 'ff-only merge failed (invariant violation)',
        conflict: false,
      };
    }

    if (!localOnly) {
      // Step 8: Push base branch
      const pushBaseResult = pushWithRetries(
        slotPath,
        remote,
        baseBranch,
        3,
        [2000, 8000, 32000]
      );
      if (!pushBaseResult.success) {
        releaseWorkspaceMergeLock(globalDb, slot.project_id);
        return {
          ok: false,
          reason: pushBaseResult.error || 'Push base branch failed',
          conflict: false,
        };
      }
    }

    // Step 9: Release merge lock
    releaseWorkspaceMergeLock(globalDb, slot.project_id);

    // Step 10: Verify reachability (remote only)
    if (!localOnly) {
      execGit(slotPath, ['fetch', remote, baseBranch], {
        tolerateFailure: true,
        timeoutMs: 120_000,
      });
      const mergedSha = execGit(slotPath, ['rev-parse', taskBranch]);
      if (mergedSha) {
        const reachable = isAncestor(slotPath, mergedSha, `${remote}/${baseBranch}`);
        if (!reachable) {
          console.error(
            `[workspace] ERROR: merged SHA ${mergedSha} not reachable from ${remote}/${baseBranch} — push may have failed silently`
          );
          // Don't delete task branch — leave it for manual inspection
          return { ok: false, reason: `Merged SHA ${mergedSha} not reachable from remote base (push failed silently)`, conflict: false };
        }
      }
    }

    // Step 11: Cleanup
    const mergedSha = execGit(slotPath, ['rev-parse', taskBranch]) || '';

    if (!localOnly) {
      // Delete remote task branch (ignore failure)
      execGit(slotPath, ['push', remote, '--delete', taskBranch], {
        tolerateFailure: true,
      });
    }

    // Delete local task branch
    execGit(slotPath, ['branch', '-D', taskBranch], { tolerateFailure: true });

    // Reset worktree to base
    execGit(slotPath, ['checkout', baseBranch]);
    execGit(slotPath, ['reset', '--hard', baseRef]);

    return { ok: true, mergedSha };
  } catch (error) {
    // Release lock on any unexpected error
    releaseWorkspaceMergeLock(globalDb, slot.project_id);
    return {
      ok: false,
      reason: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      conflict: false,
    };
  }
}
