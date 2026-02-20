/**
 * Merge conflict resolution helpers.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config/loader.js';
import {
  approveTask,
  createTask,
  getTask,
  rejectTask,
  addAuditEntry,
  updateTaskStatus,
} from '../database/queries.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { getProviderRegistry } from '../providers/registry.js';
import {
  cleanTreeHasConflicts,
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

interface ParseReviewDecisionResult {
  decision: 'approve' | 'reject';
  notes: string;
}

export interface ConflictRunOptions {
  db: Database.Database;
  projectPath: string;
  sessionId: string;
  workstreamId: string;
  branchName: string;
  position: number;
  commitSha: string;
  existingTaskId?: string;
}

function refreshMergeConflictLease(sessionId: string, workstreamId: string, projectPath: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT id, claim_generation, runner_id
         FROM workstreams
         WHERE session_id = ?
           AND id = ?
           AND clone_path = ?
           AND status = 'running'
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

    const owner = row.runner_id ?? `merge-conflict:${process.pid ?? 'unknown'}`;
    const update = db
      .prepare(
        `UPDATE workstreams
         SET runner_id = ?,
             lease_expires_at = datetime('now', '+120 seconds')
         WHERE id = ?
           AND status = 'running'
           AND claim_generation = ?`
      )
      .run(owner, row.id, row.claim_generation);

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

export function parseReviewDecision(raw: string): ParseReviewDecisionResult {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  const hasApprove = upper.includes('APPROVE');
  const hasReject = upper.includes('REJECT');

  if (hasApprove && !hasReject) {
    return {
      decision: 'approve',
      notes: trimmed || 'APPROVED by merge-conflict reviewer',
    };
  }

  if (hasReject) {
    return {
      decision: 'reject',
      notes: trimmed || 'Please review and correct conflict resolution',
    };
  }

  return {
    decision: 'reject',
    notes: trimmed || 'Decision was not clear. Please provide explicit APPROVE/REJECT.',
  };
}

function buildMergeConflictSectionName(): string {
  return 'merge-conflicts';
}

function getNowISOString(): string {
  return new Date().toISOString();
}

function createMergeConflictSection(db: Database.Database): string {
  const sectionName = buildMergeConflictSectionName();
  const existing = db
    .prepare('SELECT id FROM sections WHERE name = ? LIMIT 1')
    .get(sectionName) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const maxPosRow = db
    .prepare('SELECT MAX(position) as maxPos FROM sections')
    .get() as { maxPos: number | null };

  const position = (maxPosRow?.maxPos ?? -1) + 1;
  const sectionId = createHash('sha1').update(sectionName + position).digest('hex');

  db.prepare(
    `INSERT INTO sections (id, name, position, priority, skipped, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sectionId, sectionName, position, 80, 0, getNowISOString());

  return sectionId;
}

function ensureMergeConflictTask(
  db: Database.Database,
  workstreamId: string,
  shortSha: string,
  branchName: string,
  commitMessage: string,
  conflictedFiles: string[],
  conflictPatch: string,
  forceNew = false
): string {
  const sectionId = createMergeConflictSection(db);

  if (!forceNew) {
    const existing = db
      .prepare(
        `SELECT t.id
         FROM tasks t
         INNER JOIN sections s ON s.id = t.section_id
         WHERE s.name = ? AND t.title LIKE ?
         ORDER BY t.created_at DESC
         LIMIT 1`
      )
      .get(buildMergeConflictSectionName(), `Merge conflict: cherry-pick ${shortSha}%`) as { id: string } | undefined;

    if (existing?.id) {
      return existing.id;
    }
  }

  const title = `Merge conflict: cherry-pick ${shortSha} from ${branchName}`;
  const created = createTask(db, title, {
    sectionId,
    sourceFile: `merge-conflict (${workstreamId})`,
    filePath: conflictedFiles.join(', '),
    status: 'pending',
    fileContentHash: conflictPatch.substring(0, 2048),
    fileCommitSha: commitMessage,
  });

  addAuditEntry(
    db,
    created.id,
    'null',
    'pending',
    'merge',
    {
      actorType: 'orchestrator',
      notes: `Generated from conflict while cherry-picking ${shortSha} from ${branchName}:\n${commitMessage}`,
    }
  );

  return created.id;
}

function createPromptForConflictCoder(
  options: {
    workstreamId: string;
    shortSha: string;
    branchName: string;
    commitMessage: string;
    conflictedFiles: string[];
    conflictPatch: string;
    rejectionNotes?: string;
  }
): string {
  const notesSection = options.rejectionNotes
    ? `\n\nLatest review note from the resolver:\n${options.rejectionNotes}\n`
    : '';

  return `You are resolving a merge conflict for a cherry-pick during parallel merge.\n\n## Conflict context\nWorkstream: ${options.workstreamId}\nBranch: ${options.branchName}\nCommit: ${options.shortSha}\nCommit Message:\n${options.commitMessage}\n\nConflicted files:\n${options.conflictedFiles.map((file) => `- ${file}`).join('\n')}\n\nIntended patch:\n${options.conflictPatch}\n\nRules:\n1) Edit conflicted files to a correct resolution.\n2) Remove ALL conflict markers (<<<<<<, =======, >>>>>>) in resolved files.\n3) Stage only the resolved files using git add.\n4) Do NOT commit.\n5) Be surgical; change only files required for this commit.\n${notesSection}\n\nRespond with a short confirmation when done.`;
}

function createPromptForConflictReviewer(
  options: {
    workstreamId: string;
    shortSha: string;
    branchName: string;
    commitMessage: string;
    stagedDiff: string;
    stagedFiles: string[];
  }
): string {
  const files = options.stagedFiles.length > 0
    ? options.stagedFiles.map((file) => `- ${file}`).join('\n')
    : 'No files staged yet';

  return `You are reviewing a staged resolution for a cherry-pick conflict in parallel merge.\n\nWorkstream: ${options.workstreamId}\nBranch: ${options.branchName}\nCommit: ${options.shortSha}\nOriginal message: ${options.commitMessage}\n\nCurrent staged diff to be committed by cherry-pick --continue:\n${options.stagedDiff || '(empty diff)'}\n\nFiles staged:\n${files}\n\nDecision rules:\n- Reply with APPROVE if the resolution is correct.\n- Reply with REJECT and actionable notes if any conflict marker remains or logic is incorrect.\n\nFormat:\nAPPROVE - <optional note> or\nREJECT - <checklist itemized note>`;
}

async function invokeModel(
  role: 'coder' | 'reviewer',
  projectPath: string,
  taskId: string | undefined,
  prompt: string
): Promise<string> {
  const config = loadConfig(projectPath);
  const modelConfig = role === 'coder' ? config.ai?.coder : config.ai?.reviewer;

  if (!modelConfig?.provider || !modelConfig?.model) {
    throw new ParallelMergeError(
      `Missing AI ${role} configuration. Configure via config.ai.${role}.`,
      'AI_CONFIG_MISSING'
    );
  }

  const providerName = modelConfig.provider;
  const model = modelConfig.model;

  const registry = getProviderRegistry();
  const provider = registry.get(providerName);
  const result = await logInvocation(
    prompt,
    (ctx) =>
      provider.invoke(prompt, {
        model,
        timeout: 60 * 60 * 1000,
        cwd: projectPath,
        role,
        streamOutput: false,
        onActivity: ctx?.onActivity,
      }),
    {
      role,
      provider: providerName,
      model,
      taskId,
      projectPath,
    }
  );

  if (!result.success) {
    const details = result.stderr || result.stdout || 'model returned non-zero exit code';
    throw new ParallelMergeError(
      `${role.toUpperCase()} invocation failed during merge conflict handling: ${details}`,
      'AI_INVOCATION_FAILED'
    );
  }

  if (result.timedOut) {
    throw new ParallelMergeError(`${role} invocation timed out`, 'AI_INVOKE_TIMEOUT');
  }

  return result.stdout;
}

export async function runConflictResolutionCycle(options: ConflictRunOptions): Promise<'continued' | 'skipped'> {
  const {
    db,
    projectPath,
    sessionId,
    workstreamId,
    branchName,
    position,
    commitSha,
    existingTaskId,
  } = options;

  const shortSha = options.commitSha.slice(0, 7);
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
  refreshMergeConflictLease(sessionId, workstreamId, projectPath);

  if (currentConflictTask.status === 'completed') {
    upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'applied', conflictTaskId);
    return 'continued';
  }

  updateTaskStatus(db, currentConflictTask.id, 'in_progress', 'merge-conflict-orchestrator');

  while (true) {
    refreshMergeConflictLease(sessionId, workstreamId, projectPath);
    const existingTask = getTask(db, currentConflictTask.id);
    const lastNotes = existingTask?.rejection_count
      ? `After ${existingTask.rejection_count} rejection(s).`
      : undefined;

    const coderPrompt = createPromptForConflictCoder({
      workstreamId,
      shortSha,
      branchName,
      commitMessage,
      conflictedFiles,
      conflictPatch,
      rejectionNotes: lastNotes,
    });

    await invokeModel('coder', projectPath, currentConflictTask.id, coderPrompt);

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

    const decisionText = await invokeModel('reviewer', projectPath, currentConflictTask.id, reviewerPrompt);
    const decision = parseReviewDecision(decisionText);

    if (decision.decision === 'reject') {
      rejectTask(db, currentConflictTask.id, 'merge-conflict-reviewer', decision.notes);
      if (cleanTreeHasConflicts(projectPath)) {
        continue;
      }

      // If no explicit conflict markers remain but reviewer still rejects, keep iterating.
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
      refreshMergeConflictLease(sessionId, workstreamId, projectPath);
      runGitCommand(projectPath, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
      approveTask(db, currentConflictTask.id, 'merge-conflict-reviewer', decision.notes);
      upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'applied', currentConflictTask.id);
      return 'continued';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to commit|previous cherry-pick is empty/i.test(message)) {
        refreshMergeConflictLease(sessionId, workstreamId, projectPath);
        runGitCommand(projectPath, ['cherry-pick', '--skip']);
        upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'skipped', currentConflictTask.id);
        updateTaskStatus(
          db,
          currentConflictTask.id,
          'completed',
          'merge-conflict-reviewer',
          'Cherry-pick is now empty after resolution; skipped this commit.'
        );
        return 'skipped';
      }

      throw error;
    }
  }
}
