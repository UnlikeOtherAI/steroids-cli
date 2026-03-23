/**
 * Merge queue rebase cycle — handles LLM-powered conflict resolution.
 *
 * Responsibility: rebase coder invocation, diff fence validation,
 * rebase review orchestration, and merge_phase transitions.
 *
 * Step functions are exported for unit testing.
 */

import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { updateTaskStatus, addAuditEntry } from '../database/queries.js';
import type { Task } from '../database/queries.js';
import { transitionToRebasing } from './merge-queue.js';
import type { SteroidsConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Pure step functions ────────────────────────────────────────────────────

export function resetBranchToSha(
  slotPath: string,
  taskBranch: string,
  sha: string,
): void {
  execFileSync('git', ['checkout', '-B', taskBranch, sha], {
    cwd: slotPath, encoding: 'utf-8', timeout: 30_000,
  });
}

export interface ConflictCapture {
  ok: boolean;
  conflictFiles: string[];
  error?: string;
}

export function captureConflictFiles(
  slotPath: string,
  taskBranch: string,
  targetBranch: string,
): ConflictCapture {
  // Start rebase to discover conflicts
  try {
    execFileSync('git', ['rebase', `origin/${targetBranch}`], {
      cwd: slotPath, encoding: 'utf-8', timeout: 120_000,
    });
    // No conflicts — rebase succeeded cleanly (shouldn't reach here if
    // attemptRebaseAndFastForward already failed, but handle gracefully)
    return { ok: true, conflictFiles: [] };
  } catch {
    // Expected — rebase failed due to conflicts
  }

  // Capture conflicting files
  let conflictFiles: string[] = [];
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: slotPath, encoding: 'utf-8', timeout: 10_000,
    }).trim();
    conflictFiles = output ? output.split('\n').filter(Boolean) : [];
  } catch {
    // Fallback: no conflict info available
  }

  // Abort the in-progress rebase
  try {
    execFileSync('git', ['rebase', '--abort'], {
      cwd: slotPath, encoding: 'utf-8', timeout: 10_000,
    });
  } catch { /* already clean */ }

  if (conflictFiles.length === 0) {
    return { ok: false, conflictFiles: [], error: 'Could not determine conflicting files' };
  }

  return { ok: true, conflictFiles };
}

export interface DiffFenceResult {
  valid: boolean;
  violations: string[];
}

export function validateDiffFence(
  slotPath: string,
  allowedFiles: string[],
  baseRef: string,
): DiffFenceResult {
  let modifiedFiles: string[];
  try {
    const output = execFileSync('git', ['diff', '--name-only', baseRef], {
      cwd: slotPath, encoding: 'utf-8', timeout: 10_000,
    }).trim();
    modifiedFiles = output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return { valid: false, violations: ['Could not determine modified files'] };
  }

  const allowedSet = new Set(allowedFiles);
  const violations = modifiedFiles.filter(f => !allowedSet.has(f));

  return { valid: violations.length === 0, violations };
}

// ─── Rebase coder prompt ────────────────────────────────────────────────────

function buildRebaseCoderPrompt(
  task: Task,
  conflictFiles: string[],
  targetBranch: string,
): string {
  return [
    `TASK ID: ${task.id}`,
    '',
    '# Rebase Conflict Resolution',
    '',
    `You are resolving merge conflicts so this task branch can be merged into \`${targetBranch}\`.`,
    '',
    '## Conflict Files',
    ...conflictFiles.map(f => `- ${f}`),
    '',
    '## Rules',
    '1. Read CLAUDE.md and AGENTS.md before starting.',
    '2. ONLY modify files listed above. Do NOT touch any other files.',
    '3. Resolve each conflict by understanding both sides and producing correct merged code.',
    '4. Run the build command to verify your changes compile.',
    '5. Run the test command to verify nothing is broken.',
    '6. If you cannot resolve a conflict correctly, say so — do not guess.',
    '',
    '## Task Context',
    `Title: ${task.title}`,
    '',
    '## Instructions',
    `1. Run: git rebase origin/${targetBranch}`,
    '2. For each conflict file, resolve the conflict markers.',
    '3. Stage resolved files: git add <file>',
    '4. Continue rebase: git rebase --continue',
    '5. Build and test to verify.',
  ].join('\n');
}

// ─── Orchestrator: handleRebaseCoder ────────────────────────────────────────

export async function handleRebaseCoder(
  db: Database.Database,
  task: Task,
  config: SteroidsConfig,
  slotPath: string,
  targetBranch: string,
  taskBranch: string,
  runnerId?: string,
): Promise<void> {
  const approvedSha = task.approved_sha;
  if (!approvedSha) {
    updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
      '[merge_queue] No approved_sha for rebase — cannot proceed');
    return;
  }

  // Step 1: Reset task branch to approved_sha (clean slate for each attempt)
  try {
    execFileSync('git', ['fetch', 'origin', targetBranch, taskBranch], {
      cwd: slotPath, encoding: 'utf-8', timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    // Transient — retry next iteration
    return;
  }

  resetBranchToSha(slotPath, taskBranch, `origin/${taskBranch}`);

  // Step 2: Capture conflict files
  const capture = captureConflictFiles(slotPath, taskBranch, targetBranch);
  if (!capture.ok) {
    if (capture.conflictFiles.length === 0 && !capture.error) {
      // Clean rebase succeeded — no conflicts, go back to queued for merge attempt
      db.prepare(
        `UPDATE tasks SET merge_phase = 'queued', updated_at = datetime('now') WHERE id = ?`
      ).run(task.id);
      return;
    }
    db.prepare(
      `UPDATE tasks SET status = 'disputed', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(task.id);
    addAuditEntry(db, task.id, 'merge_pending', 'disputed', 'orchestrator', {
      actorType: 'orchestrator',
      notes: `[merge_queue] Could not capture conflict files: ${capture.error}`,
    });
    return;
  }

  if (capture.conflictFiles.length === 0) {
    // No conflicts — go back to queued
    db.prepare(
      `UPDATE tasks SET merge_phase = 'queued', updated_at = datetime('now') WHERE id = ?`
    ).run(task.id);
    return;
  }

  // Reset branch again for the LLM to work on
  resetBranchToSha(slotPath, taskBranch, `origin/${taskBranch}`);
  const preRebaseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: slotPath, encoding: 'utf-8', timeout: 10_000,
  }).trim();

  // Step 3: Invoke LLM rebase coder
  const coderConfig = config.ai?.coder;
  if (!coderConfig?.provider || !coderConfig.model) {
    updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
      '[merge_queue] No coder AI provider configured for rebase');
    return;
  }

  const prompt = buildRebaseCoderPrompt(task, capture.conflictFiles, targetBranch);
  const promptFile = join(tmpdir(), `steroids-rebase-coder-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  let llmSuccess = false;
  try {
    const registry = await getProviderRegistry();
    const provider = registry.get(coderConfig.provider);

    if (!(await provider.isAvailable())) {
      updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
        `[merge_queue] Rebase coder provider '${coderConfig.provider}' not available`);
      return;
    }

    const result = await logInvocation(
      prompt,
      (ctx) => provider.invoke(prompt, {
        model: coderConfig.model!,
        timeout: 1800_000, // 30 min
        cwd: slotPath,
        promptFile,
        role: 'coder',
        streamOutput: false,
        onActivity: ctx?.onActivity,
      }),
      {
        role: 'rebase_coder',
        provider: coderConfig.provider,
        model: coderConfig.model,
        taskId: task.id,
        projectPath: slotPath,
        runnerId,
      }
    );

    llmSuccess = result.success;
  } catch {
    llmSuccess = false;
  } finally {
    try { unlinkSync(promptFile); } catch { /* ignore */ }
  }

  if (!llmSuccess) {
    db.prepare(
      `UPDATE tasks SET status = 'disputed', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(task.id);
    addAuditEntry(db, task.id, 'merge_pending', 'disputed', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[merge_queue] LLM rebase coder failed — escalating to disputed',
    });
    return;
  }

  // Step 4: Validate diff fence
  const fence = validateDiffFence(slotPath, capture.conflictFiles, preRebaseSha);
  if (!fence.valid) {
    db.prepare(
      `UPDATE tasks SET status = 'disputed', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(task.id);
    addAuditEntry(db, task.id, 'merge_pending', 'disputed', 'orchestrator', {
      actorType: 'orchestrator',
      notes: `[merge_queue] Diff fence violation — LLM modified files outside conflict scope: ${fence.violations.join(', ')}`,
    });
    return;
  }

  // Step 5: Force-push updated task branch
  try {
    execFileSync('git', ['push', 'origin', taskBranch, '--force-with-lease'], {
      cwd: slotPath, encoding: 'utf-8', timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
      '[merge_queue] Failed to push rebased task branch');
    return;
  }

  // Step 6: Transition to rebase_review (do NOT set approved_sha)
  db.prepare(
    `UPDATE tasks SET merge_phase = 'rebase_review', updated_at = datetime('now') WHERE id = ?`
  ).run(task.id);
  addAuditEntry(db, task.id, 'merge_pending', 'merge_pending', 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[merge_queue] Rebase coder completed — awaiting rebase review (conflicts: ${capture.conflictFiles.join(', ')})`,
  });
}

// ─── Orchestrator: handleRebaseReview ───────────────────────────────────────

export async function handleRebaseReview(
  db: Database.Database,
  task: Task,
  config: SteroidsConfig,
  slotPath: string,
  targetBranch: string,
  taskBranch: string,
  runnerId?: string,
): Promise<void> {
  // Fetch latest
  try {
    execFileSync('git', ['fetch', 'origin', targetBranch, taskBranch], {
      cwd: slotPath, encoding: 'utf-8', timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    return; // Transient — retry next iteration
  }

  // Invoke reviewer on the rebased task branch
  const reviewerConfig = config.ai?.reviewer;
  if (!reviewerConfig?.provider || !reviewerConfig.model) {
    updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
      '[merge_queue] No reviewer AI provider configured for rebase review');
    return;
  }

  const prompt = [
    `TASK ID: ${task.id}`,
    '',
    '# Rebase Review',
    '',
    'Review the conflict resolution changes on this task branch.',
    'Focus on: correctness of merge conflict resolution, no regressions, build passes.',
    '',
    `Task: ${task.title}`,
    '',
    'Instructions:',
    '1. Read CLAUDE.md and AGENTS.md.',
    `2. Review the diff: git diff origin/${targetBranch}...origin/${taskBranch}`,
    '3. Verify build and tests pass.',
    '4. Output DECISION: APPROVE or DECISION: REJECT with reasoning.',
  ].join('\n');

  const promptFile = join(tmpdir(), `steroids-rebase-reviewer-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  let reviewerStdout = '';
  let reviewerSuccess = false;

  try {
    const registry = await getProviderRegistry();
    const provider = registry.get(reviewerConfig.provider);

    if (!(await provider.isAvailable())) {
      updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
        `[merge_queue] Rebase reviewer provider '${reviewerConfig.provider}' not available`);
      return;
    }

    const result = await logInvocation(
      prompt,
      (ctx) => provider.invoke(prompt, {
        model: reviewerConfig.model!,
        timeout: 900_000, // 15 min
        cwd: slotPath,
        promptFile,
        role: 'reviewer',
        streamOutput: false,
        onActivity: ctx?.onActivity,
      }),
      {
        role: 'rebase_reviewer',
        provider: reviewerConfig.provider,
        model: reviewerConfig.model,
        taskId: task.id,
        projectPath: slotPath,
        runnerId,
      }
    );

    reviewerStdout = result.stdout;
    reviewerSuccess = result.success;
  } catch {
    reviewerSuccess = false;
  } finally {
    try { unlinkSync(promptFile); } catch { /* ignore */ }
  }

  if (!reviewerSuccess) {
    db.prepare(
      `UPDATE tasks SET status = 'disputed', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(task.id);
    addAuditEntry(db, task.id, 'merge_pending', 'disputed', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[merge_queue] Rebase reviewer failed — escalating to disputed',
    });
    return;
  }

  // Parse decision from reviewer output
  const decision = parseRebaseReviewDecision(reviewerStdout);

  if (decision === 'approve') {
    // Re-record approved_sha from remote HEAD of task branch
    let newApprovedSha: string | undefined;
    try {
      newApprovedSha = execFileSync('git', ['rev-parse', `origin/${taskBranch}`], {
        cwd: slotPath, encoding: 'utf-8', timeout: 10_000,
      }).trim();
    } catch { /* fall through */ }

    if (!newApprovedSha) {
      updateTaskStatus(db, task.id, 'blocked_error', 'orchestrator',
        '[merge_queue] Could not resolve approved_sha after rebase review');
      return;
    }

    db.prepare(
      `UPDATE tasks SET merge_phase = 'queued', approved_sha = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(newApprovedSha, task.id);
    addAuditEntry(db, task.id, 'merge_pending', 'merge_pending', 'orchestrator', {
      actorType: 'orchestrator',
      notes: `[merge_queue] Rebase review approved — re-queued for merge (new sha: ${newApprovedSha})`,
    });
  } else {
    // Reject — transition back to rebasing (handles increment + cap)
    transitionToRebasing(db, task.id, 'Rebase review rejected');
  }
}

// ─── Decision parser ────────────────────────────────────────────────────────

export function parseRebaseReviewDecision(stdout: string): 'approve' | 'reject' {
  const upper = stdout.toUpperCase();
  // Look for explicit DECISION: APPROVE/REJECT tokens
  if (upper.includes('DECISION: APPROVE') || upper.includes('DECISION:APPROVE')) {
    return 'approve';
  }
  // Default to reject if no clear approval signal
  return 'reject';
}
