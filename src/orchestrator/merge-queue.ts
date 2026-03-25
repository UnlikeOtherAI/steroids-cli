/**
 * Merge queue pipeline — routes merge_pending tasks through the merge gate.
 *
 * Responsibility: pipeline routing, merge orchestration, pool slot and lock lifecycle.
 * Step functions (fetchAndPrepare, attemptRebaseAndFastForward, etc.) are composed
 * here but contain their own logic.
 */

import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { updateTaskStatus, addAuditEntry } from '../database/queries.js';
import type { Task } from '../database/queries.js';
import { acquireWorkspaceMergeLock, releaseWorkspaceMergeLock } from '../workspace/merge-lock.js';
import { claimSlot, finalizeSlotPath, releaseSlot, resolveRemoteUrl } from '../workspace/pool.js';
import { getProjectHash } from '../parallel/clone.js';
import { pushWithRetriesAsync } from '../workspace/git-helpers.js';
import type { SteroidsConfig } from '../config/loader.js';
import { openGlobalDatabase } from '../runners/global-db.js';

// ─── Error classifiers (pure functions) ──────────────────────────────────────

export type PushErrorClass = 'race_loss' | 'transient' | 'permanent';
export type FetchErrorClass = 'transient' | 'permanent';

export function classifyPushError(error: string): PushErrorClass {
  const lower = error.toLowerCase();
  if (lower.includes('non-fast-forward') || lower.includes('fetch first') || lower.includes('stale info')) {
    return 'race_loss';
  }
  if (
    lower.includes('could not resolve') ||
    lower.includes('connection') ||
    lower.includes('timeout') ||
    lower.includes('unable to access') ||
    lower.includes('temporary failure')
  ) {
    return 'transient';
  }
  return 'permanent';
}

export function classifyFetchError(error: string): FetchErrorClass {
  const lower = error.toLowerCase();
  if (
    lower.includes('could not resolve') ||
    lower.includes('connection') ||
    lower.includes('timeout') ||
    lower.includes('unable to access') ||
    lower.includes('temporary failure')
  ) {
    return 'transient';
  }
  return 'permanent';
}

// ─── Step functions ──────────────────────────────────────────────────────────

export interface PrepResult {
  ok: boolean;
  alreadyMerged?: boolean;
  error?: 'sha_mismatch' | 'fetch_transient' | 'fetch_permanent';
  slotPath?: string;
  taskBranchLocal?: string;
  targetBranch?: string;
}

export function fetchAndPrepare(
  slotPath: string,
  taskBranch: string,
  targetBranch: string,
  approvedSha: string,
): PrepResult {
  // Fetch latest from remote
  try {
    execFileSync('git', ['fetch', 'origin', targetBranch, taskBranch], {
      cwd: slotPath, encoding: 'utf-8', timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const errText = stderr.trim() || msg;
    const classification = classifyFetchError(errText);
    return { ok: false, error: classification === 'transient' ? 'fetch_transient' : 'fetch_permanent' };
  }

  // Idempotency check: if approved_sha is already an ancestor of target HEAD, skip
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', approvedSha, `origin/${targetBranch}`], {
      cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
    });
    return { ok: true, alreadyMerged: true };
  } catch {
    // Not an ancestor — proceed with merge
  }

  // SHA verification: branch HEAD must match approved_sha
  try {
    const branchHead = execFileSync('git', ['rev-parse', `origin/${taskBranch}`], {
      cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
    }).trim();
    if (branchHead !== approvedSha) {
      return { ok: false, error: 'sha_mismatch' };
    }
  } catch {
    return { ok: false, error: 'fetch_permanent' };
  }

  return { ok: true, slotPath, taskBranchLocal: taskBranch, targetBranch };
}

export function handlePrepFailure(
  db: Database.Database,
  taskId: string,
  error: 'sha_mismatch' | 'fetch_transient' | 'fetch_permanent',
): void {
  switch (error) {
    case 'sha_mismatch':
      // Task branch was modified after approval — return to review
      db.prepare(
        `UPDATE tasks SET status = 'review', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now')
         WHERE id = ?`
      ).run(taskId);
      addAuditEntry(db, taskId, 'merge_pending', 'review', 'orchestrator', {
        actorType: 'orchestrator',
        notes: '[merge_queue] SHA mismatch — task branch modified after approval, returning to review',
      });
      break;
    case 'fetch_transient':
      // Transient network error — retry next iteration (no status change)
      break;
    case 'fetch_permanent':
      updateTaskStatus(db, taskId, 'blocked_error', 'orchestrator',
        '[merge_queue] Permanent fetch failure — remote may be unreachable or credentials expired');
      break;
  }
}

export interface MergeAttemptResult {
  merged: boolean;
  reason?: 'conflicts' | 'ff_only';
}

export function attemptRebaseAndFastForward(
  slotPath: string,
  taskBranch: string,
  targetBranch: string,
): MergeAttemptResult {
  // Checkout target branch at origin HEAD
  execFileSync('git', ['checkout', '-B', targetBranch, `origin/${targetBranch}`], {
    cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
  });

  // Try ff-only merge first
  try {
    execFileSync('git', ['merge', '--ff-only', `origin/${taskBranch}`], {
      cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
    });
    return { merged: true };
  } catch {
    // Not fast-forwardable — try deterministic rebase
  }

  // Deterministic rebase: rebase task branch onto target, then ff merge
  try {
    execFileSync('git', ['checkout', '-B', taskBranch, `origin/${taskBranch}`], {
      cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
    });
    execFileSync('git', ['rebase', `origin/${targetBranch}`], {
      cwd: slotPath, encoding: 'utf-8', timeout: 120_000,
    });
    // Switch back to target and ff-merge the rebased branch
    execFileSync('git', ['checkout', targetBranch], {
      cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
    });
    execFileSync('git', ['merge', '--ff-only', taskBranch], {
      cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
    });
    return { merged: true };
  } catch {
    // Abort any in-progress rebase
    try {
      execFileSync('git', ['rebase', '--abort'], { cwd: slotPath, encoding: 'utf-8', timeout: 10_000 });
    } catch { /* already clean */ }
    return { merged: false, reason: 'conflicts' };
  }
}

export async function pushTargetBranch(
  slotPath: string,
  targetBranch: string,
): Promise<{ ok: boolean; errorClass?: PushErrorClass; error?: string }> {
  const result = await pushWithRetriesAsync(slotPath, 'origin', targetBranch, 3, [1000, 4000, 16000]);
  if (result.success) {
    return { ok: true };
  }
  const errorClass = classifyPushError(result.error ?? '');
  return { ok: false, errorClass, error: result.error };
}

export function cleanupTaskBranch(
  slotPath: string,
  taskBranch: string,
): void {
  try {
    execFileSync('git', ['push', 'origin', '--delete', taskBranch], {
      cwd: slotPath, encoding: 'utf-8', timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    // Non-fatal — branch may already be deleted or remote unreachable
  }
}

export function markCompleted(
  db: Database.Database,
  taskId: string,
  mergedSha?: string,
): void {
  db.prepare(
    `UPDATE tasks SET status = 'completed', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now')
     WHERE id = ?`
  ).run(taskId);
  addAuditEntry(db, taskId, 'merge_pending', 'completed', 'orchestrator', {
    actorType: 'orchestrator',
    notes: '[merge_queue] Merge completed successfully',
    commitSha: mergedSha,
  });
}

const MAX_REBASE_ATTEMPTS = 3;

export function transitionToRebasing(
  db: Database.Database,
  taskId: string,
  reason: string,
): void {
  // Increment rebase_attempts and check cap
  const task = db.prepare('SELECT rebase_attempts FROM tasks WHERE id = ?').get(taskId) as { rebase_attempts: number } | undefined;
  const attempts = (task?.rebase_attempts ?? 0) + 1;

  if (attempts > MAX_REBASE_ATTEMPTS) {
    db.prepare(
      `UPDATE tasks SET status = 'disputed', merge_phase = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(taskId);
    addAuditEntry(db, taskId, 'merge_pending', 'disputed', 'orchestrator', {
      actorType: 'orchestrator',
      notes: `[merge_queue] Rebase cap reached (${MAX_REBASE_ATTEMPTS} attempts): ${reason}`,
    });
    return;
  }

  db.prepare(
    `UPDATE tasks SET merge_phase = 'rebasing', rebase_attempts = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(attempts, taskId);
  addAuditEntry(db, taskId, 'merge_pending', 'merge_pending', 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[merge_queue] Transitioning to rebase (attempt ${attempts}/${MAX_REBASE_ATTEMPTS}): ${reason}`,
  });
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function handleMergeAttempt(
  db: Database.Database,
  task: Task,
  config: SteroidsConfig,
  sourceProjectPath: string,
  runnerId?: string,
): Promise<void> {
  const remote = config.git?.remote ?? 'origin';
  const targetBranch = config.git?.branch ?? 'main';
  const approvedSha = task.approved_sha;

  if (!approvedSha) {
    updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
      '[merge_queue] No approved_sha — cannot merge without reviewer-verified SHA');
    return;
  }

  // Local-only guard: no remote configured → skip merge queue
  const remoteUrl = resolveRemoteUrl(sourceProjectPath);
  if (!remoteUrl) {
    markCompleted(db, task.id, approvedSha);
    return;
  }

  const projectId = getProjectHash(sourceProjectPath);
  const gdb = openGlobalDatabase();
  let slotId: number | undefined;
  let lockAcquired = false;

  try {
    // Claim pool slot for merge workspace
    const slot = claimSlot(gdb.db, projectId, runnerId ?? `merge:${process.pid}`, task.id);
    const finalSlot = finalizeSlotPath(gdb.db, slot.id, sourceProjectPath, remoteUrl);
    slotId = finalSlot.id;

    // Try to acquire merge lock (non-blocking)
    lockAcquired = acquireWorkspaceMergeLock(
      gdb.db, projectId, runnerId ?? `merge:${process.pid}`, slotId, 0, 0, true
    );
    if (!lockAcquired) {
      // Another merge is in progress — retry next iteration
      return;
    }

    const taskBranch = finalSlot.task_branch ?? `steroids/task-${task.id}`;
    const slotPath = finalSlot.slot_path;

    // Step 1: Fetch and prepare
    const prepResult = fetchAndPrepare(slotPath, taskBranch, targetBranch, approvedSha);

    if (prepResult.alreadyMerged) {
      markCompleted(db, task.id, approvedSha);
      cleanupTaskBranch(slotPath, taskBranch);
      return;
    }

    if (!prepResult.ok) {
      handlePrepFailure(db, task.id, prepResult.error!);
      return;
    }

    // Step 2: Attempt rebase and fast-forward
    const mergeResult = attemptRebaseAndFastForward(slotPath, taskBranch, targetBranch);

    if (!mergeResult.merged) {
      transitionToRebasing(db, task.id, 'Merge conflicts detected during fast-forward attempt');
      return;
    }

    // Step 3: Push target branch
    const pushResult = await pushTargetBranch(slotPath, targetBranch);

    if (!pushResult.ok) {
      switch (pushResult.errorClass) {
        case 'race_loss':
          // Another merge won the race — retry next iteration (no status change)
          return;
        case 'transient':
          // Network issue — retry next iteration (no status change)
          return;
        case 'permanent':
          updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
            `[merge_queue] Permanent push failure: ${pushResult.error}`);
          return;
      }
    }

    // Step 4: Get merged SHA
    let mergedSha: string | undefined;
    try {
      mergedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: slotPath, encoding: 'utf-8', timeout: 10_000,
      }).trim();
    } catch { /* non-critical */ }

    // Step 5: Cleanup task branch (non-fatal)
    cleanupTaskBranch(slotPath, taskBranch);

    // Step 6: Mark completed
    markCompleted(db, task.id, mergedSha);
  } finally {
    if (lockAcquired) {
      try {
        releaseWorkspaceMergeLock(gdb.db, projectId);
      } catch { /* ignore */ }
    }
    if (slotId !== undefined) {
      try {
        releaseSlot(gdb.db, slotId);
      } catch { /* ignore */ }
    }
    try {
      gdb.close();
    } catch { /* ignore */ }
  }
}

// ─── Rebase phase wrapper ────────────────────────────────────────────────────

async function handleRebasePhase(
  db: Database.Database,
  task: Task,
  config: SteroidsConfig,
  sourceProjectPath: string,
  phase: 'rebasing' | 'rebase_review',
  runnerId?: string,
): Promise<void> {
  const { handleRebaseCoder, handleRebaseReview } = await import('./merge-queue-rebase.js');
  const targetBranch = config.git?.branch ?? 'main';

  // Look up the existing slot's remote_url that was stored by handleMergeAttempt.
  // This is critical when the runner's CWD is a worktree from a different repo —
  // calling resolveRemoteUrl(sourceProjectPath) would return the wrong git remote.
  const gdb = openGlobalDatabase();
  const existingSlot = gdb.db
    .prepare(
      `SELECT remote_url, slot_path FROM workspace_pool_slots
       WHERE task_id = ? AND remote_url IS NOT NULL AND remote_url != ''
       ORDER BY id DESC LIMIT 1`
    )
    .get(task.id) as { remote_url: string; slot_path: string } | undefined;

  const remoteUrl = existingSlot?.remote_url ?? resolveRemoteUrl(sourceProjectPath);

  if (!remoteUrl) {
    // Local-only — no rebase needed, mark completed
    markCompleted(db, task.id, task.approved_sha ?? undefined);
    return;
  }

  const projectId = getProjectHash(sourceProjectPath);
  let slotId: number | undefined;

  try {
    const slot = claimSlot(gdb.db, projectId, runnerId ?? `rebase:${process.pid}`, task.id);
    const finalSlot = finalizeSlotPath(gdb.db, slot.id, sourceProjectPath, remoteUrl);
    slotId = finalSlot.id;

    const taskBranch = finalSlot.task_branch ?? `steroids/task-${task.id}`;
    const slotPath = finalSlot.slot_path;

    if (phase === 'rebasing') {
      await handleRebaseCoder(db, task, config, slotPath, targetBranch, taskBranch, runnerId);
    } else {
      await handleRebaseReview(db, task, config, slotPath, targetBranch, taskBranch, runnerId);
    }
  } finally {
    if (slotId !== undefined) {
      try { releaseSlot(gdb.db, slotId); } catch { /* ignore */ }
    }
    try { gdb.close(); } catch { /* ignore */ }
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export async function processMergeQueue(
  db: Database.Database,
  task: Task,
  config: SteroidsConfig,
  sourceProjectPath: string,
  runnerId?: string,
): Promise<void> {
  const mergePhase = task.merge_phase ?? 'queued';

  switch (mergePhase) {
    case 'queued':
      await handleMergeAttempt(db, task, config, sourceProjectPath, runnerId);
      break;
    case 'rebasing':
    case 'rebase_review':
      await handleRebasePhase(db, task, config, sourceProjectPath, mergePhase, runnerId);
      break;
    default:
      updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
        `[merge_queue] Unknown merge_phase: ${mergePhase}`);
      break;
  }
}
