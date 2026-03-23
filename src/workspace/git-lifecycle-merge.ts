/**
 * Phase 5: Post-Review Merge Pipeline.
 *
 * Extracted from git-lifecycle.ts for 500-line compliance.
 * Implements rebase, push, ff-only merge, push base, verify, cleanup.
 */

import type Database from 'better-sqlite3';

import type { PoolSlot } from './types.js';
import {
  execGit,
  abortRebase,
  pushWithRetries,
  isAncestor,
  getLogOneline,
} from './git-helpers.js';
import { verifyBaseRef } from './git-lifecycle.js';
import { updateSlotStatus } from './pool.js';
import {
  acquireWorkspaceMergeLock,
  releaseWorkspaceMergeLock,
} from './merge-lock.js';

// ─────────────────────────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────────────────────────

export type MergeResult =
  | { ok: true; mergedSha: string }
  | { ok: false; reason: string; conflict: boolean; infrastructure?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Merge pipeline
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
      const fetchResult = execGit(slotPath, ['fetch', remote], {
        tolerateFailure: true,
        timeoutMs: 120_000,
      });
      if (fetchResult === null) {
        // Transient fetch failure — existing retry path
        releaseWorkspaceMergeLock(globalDb, slot.project_id);
        return { ok: false, reason: 'git fetch origin failed during merge', conflict: false };
      }
      // Verify base branch exists after successful fetch
      if (verifyBaseRef(slotPath, baseBranch, localOnly) === 'missing') {
        releaseWorkspaceMergeLock(globalDb, slot.project_id);
        return {
          ok: false,
          reason: `Remote base branch '${baseBranch}' does not exist on origin`,
          conflict: false,
          infrastructure: true,
        };
      }
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
