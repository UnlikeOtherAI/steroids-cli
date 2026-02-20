/**
 * Merge conflict resolution orchestrator.
 */

import type Database from 'better-sqlite3';
import {
  approveTask,
  getTask,
  rejectTask,
  updateTaskStatus,
} from '../database/queries.js';
import {
  getCachedDiff,
  getCachedFiles,
  getCommitMessage,
  getConflictedFiles,
  getCommitPatch,
  hasCherryPickInProgress,
  hasUnmergedFiles,
  runGitCommand,
} from './merge-git.js';
import { ParallelMergeError } from './merge-errors.js';
import { upsertProgressEntry } from './merge-progress.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import {
  clearConflictAttemptState,
  MAX_CONFLICT_ATTEMPTS,
  recordConflictAttempt,
} from './merge-conflict-attempts.js';
import { invokeMergeConflictModel } from './merge-conflict-invoke.js';
import {
  createPromptForConflictCoder,
  createPromptForConflictReviewer,
  parseReviewDecision,
} from './merge-conflict-prompts.js';
import { ensureMergeConflictTask } from './merge-conflict-task.js';
import { refreshMergeLock } from './merge-lock.js';

export { parseReviewDecision } from './merge-conflict-prompts.js';

export interface ConflictRunOptions {
  db: Database.Database;
  projectPath: string;
  sessionId: string;
  workstreamId: string;
  runnerId: string;
  mergeLockHeartbeat?: {
    lockEpoch: number;
    timeoutMinutes: number;
  };
  branchName: string;
  position: number;
  commitSha: string;
  existingTaskId?: string;
}

function refreshMergeConflictLease(
  sessionId: string,
  workstreamId: string,
  projectPath: string,
  runnerId: string
): void {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT id, claim_generation, runner_id
         FROM workstreams
         WHERE session_id = ?
           AND id = ?
           AND clone_path = ?
           AND status IN ('running', 'completed')
         LIMIT 1`
      )
      .get(sessionId, workstreamId, projectPath) as
      | { id: string; claim_generation: number; runner_id: string | null }
      | undefined;

    if (!row) {
      throw new ParallelMergeError(
        'Parallel workstream lease row not found during conflict resolution',
        'LEASE_ROW_MISSING'
      );
    }

    if (row.runner_id !== null && row.runner_id !== runnerId) {
      throw new ParallelMergeError(
        `Parallel workstream lease owned by ${row.runner_id}, not ${runnerId}`,
        'LEASE_FENCE_FAILED'
      );
    }

    const update = db
      .prepare(
        `UPDATE workstreams
         SET runner_id = ?,
             lease_expires_at = datetime('now', '+120 seconds')
         WHERE id = ?
           AND status IN ('running', 'completed')
           AND claim_generation = ?
           AND (runner_id IS NULL OR runner_id = ?)`
      )
      .run(runnerId, row.id, row.claim_generation, runnerId);

    if (update.changes !== 1) {
      throw new ParallelMergeError(
        'Parallel workstream lease fence check failed during conflict resolution',
        'LEASE_FENCE_FAILED'
      );
    }
  } finally {
    close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForConflictRetryWindow(
  db: Database.Database,
  sessionId: string,
  workstreamId: string,
  projectPath: string,
  runnerId: string,
  backoffMinutes: number,
  mergeLockHeartbeat?: {
    lockEpoch: number;
    timeoutMinutes: number;
  }
): Promise<void> {
  if (backoffMinutes <= 0) {
    return;
  }

  let remainingMs = backoffMinutes * 60_000;
  const heartbeatSliceMs = 30_000;

  while (remainingMs > 0) {
    const waitMs = Math.min(heartbeatSliceMs, remainingMs);
    await delay(waitMs);
    remainingMs -= waitMs;

    refreshMergeConflictLease(sessionId, workstreamId, projectPath, runnerId);
    if (mergeLockHeartbeat) {
      refreshMergeLock(
        db,
        sessionId,
        runnerId,
        mergeLockHeartbeat.timeoutMinutes,
        mergeLockHeartbeat.lockEpoch
      );
    }
  }
}

export async function runConflictResolutionCycle(options: ConflictRunOptions): Promise<'continued' | 'skipped'> {
  const {
    db,
    projectPath,
    sessionId,
    workstreamId,
    runnerId,
    mergeLockHeartbeat,
    branchName,
    position,
    commitSha,
    existingTaskId,
  } = options;

  const shortSha = commitSha.slice(0, 7);
  const conflictedFiles = getConflictedFiles(projectPath);
  const conflictPatch = getCommitPatch(projectPath, commitSha);
  const commitMessage = getCommitMessage(projectPath, commitSha);
  const taskId = ensureMergeConflictTask(
    db,
    workstreamId,
    shortSha,
    branchName,
    commitMessage,
    conflictedFiles,
    conflictPatch,
    !existingTaskId
  );

  let conflictTaskId = existingTaskId ?? taskId;
  if (conflictTaskId !== taskId) {
    conflictTaskId = taskId;
  }

  upsertProgressEntry(
    db,
    sessionId,
    workstreamId,
    position,
    commitSha,
    'conflict',
    conflictTaskId
  );

  const currentConflictTask = getTask(db, conflictTaskId);
  if (!currentConflictTask) {
    throw new ParallelMergeError('Created merge-conflict task not found', 'TASK_MISSING');
  }

  refreshMergeConflictLease(sessionId, workstreamId, projectPath, runnerId);

  if (currentConflictTask.status === 'completed') {
    const appliedCommitSha = runGitCommand(projectPath, ['rev-parse', 'HEAD'], { allowFailure: true }).trim();
    upsertProgressEntry(
      db,
      sessionId,
      workstreamId,
      position,
      commitSha,
      'applied',
      conflictTaskId,
      appliedCommitSha || null
    );
    clearConflictAttemptState(sessionId, workstreamId);
    return 'continued';
  }

  updateTaskStatus(db, currentConflictTask.id, 'in_progress', 'merge-conflict-orchestrator');

  while (true) {
    const conflictAttempt = recordConflictAttempt(sessionId, workstreamId);
    if (conflictAttempt.blocked) {
      rejectTask(
        db,
        currentConflictTask.id,
        'merge-conflict-reviewer',
        `Conflict resolution attempt limit reached (${MAX_CONFLICT_ATTEMPTS}). Session moved to blocked_conflict.`
      );
      throw new ParallelMergeError(
        `Conflict resolution exceeded ${MAX_CONFLICT_ATTEMPTS} attempts for ${shortSha}`,
        'CONFLICT_ATTEMPT_LIMIT'
      );
    }

    refreshMergeConflictLease(sessionId, workstreamId, projectPath, runnerId);
    if (conflictAttempt.attempts > 1 && (conflictAttempt.backoffMinutes ?? 0) > 0) {
      updateTaskStatus(
        db,
        currentConflictTask.id,
        'in_progress',
        'merge-conflict-orchestrator',
        `Waiting ${conflictAttempt.backoffMinutes} minute(s) before retry ${conflictAttempt.attempts}.`
      );
      await waitForConflictRetryWindow(
        db,
        sessionId,
        workstreamId,
        projectPath,
        runnerId,
        conflictAttempt.backoffMinutes ?? 0,
        mergeLockHeartbeat
      );
    }

    const existingTask = getTask(db, currentConflictTask.id);
    const noteParts = [`Attempt ${conflictAttempt.attempts}/${MAX_CONFLICT_ATTEMPTS}.`];
    if (existingTask?.rejection_count) {
      noteParts.push(`After ${existingTask.rejection_count} rejection(s).`);
    }
    const lastNotes = noteParts.join(' ');

    const coderPrompt = createPromptForConflictCoder({
      workstreamId,
      shortSha,
      branchName,
      commitMessage,
      conflictedFiles,
      conflictPatch,
      rejectionNotes: lastNotes,
    });

    await invokeMergeConflictModel('coder', projectPath, currentConflictTask.id, coderPrompt);

    const remaining = getConflictedFiles(projectPath);
    if (remaining.length > 0) {
      updateTaskStatus(
        db,
        currentConflictTask.id,
        'in_progress',
        'merge-conflict-orchestrator',
        `Conflict markers still present: ${remaining.join(', ')}`
      );
      continue;
    }

    const stagedFiles = getCachedFiles(projectPath);
    const stagedDiff = getCachedDiff(projectPath);

    if (stagedFiles.length === 0 || stagedDiff.trim().length === 0) {
      updateTaskStatus(
        db,
        currentConflictTask.id,
        'in_progress',
        'merge-conflict-orchestrator',
        'No staged diff found. Stage resolved files before requesting review.'
      );
      continue;
    }

    updateTaskStatus(db, currentConflictTask.id, 'review', 'merge-conflict-orchestrator');

    const reviewerPrompt = createPromptForConflictReviewer({
      workstreamId,
      shortSha,
      branchName,
      commitMessage,
      stagedDiff,
      stagedFiles,
    });

    const decisionText = await invokeMergeConflictModel('reviewer', projectPath, currentConflictTask.id, reviewerPrompt);
    const decision = parseReviewDecision(decisionText);

    if (decision.decision === 'reject') {
      rejectTask(db, currentConflictTask.id, 'merge-conflict-reviewer', decision.notes);
      continue;
    }

    if (hasUnmergedFiles(projectPath)) {
      rejectTask(db, currentConflictTask.id, 'merge-conflict-reviewer', 'Conflict markers still present. Please fix.');
      continue;
    }

    if (!hasCherryPickInProgress(projectPath)) {
      throw new ParallelMergeError(
        'Cherry-pick no longer in progress while resolving conflict',
        'CHERRY_PICK_CONTEXT_LOST'
      );
    }

    try {
      refreshMergeConflictLease(sessionId, workstreamId, projectPath, runnerId);
      runGitCommand(projectPath, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
      approveTask(db, currentConflictTask.id, 'merge-conflict-reviewer', decision.notes);
      const appliedCommitSha = runGitCommand(projectPath, ['rev-parse', 'HEAD'], { allowFailure: true }).trim();
      upsertProgressEntry(
        db,
        sessionId,
        workstreamId,
        position,
        commitSha,
        'applied',
        currentConflictTask.id,
        appliedCommitSha || null
      );
      clearConflictAttemptState(sessionId, workstreamId);
      return 'continued';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to commit|previous cherry-pick is empty/i.test(message)) {
        refreshMergeConflictLease(sessionId, workstreamId, projectPath, runnerId);
        runGitCommand(projectPath, ['cherry-pick', '--skip']);
        upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'skipped', currentConflictTask.id);
        updateTaskStatus(
          db,
          currentConflictTask.id,
          'completed',
          'merge-conflict-reviewer',
          'Cherry-pick is now empty after resolution; skipped this commit.'
        );
        clearConflictAttemptState(sessionId, workstreamId);
        return 'skipped';
      }

      throw error;
    }
  }
}
