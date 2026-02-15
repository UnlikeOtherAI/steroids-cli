/**
 * Parallel merge orchestration
 * Cherry-picks completed workstream branches into main with crash-safe progress tracking.
 */

import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getProjectHash } from './clone.js';
import { getDefaultWorkspaceRoot } from './clone.js';
import { openDatabase } from '../database/connection.js';
import { createTask, getTask, updateTaskStatus, rejectTask, approveTask, addAuditEntry } from '../database/queries.js';
import { getProviderRegistry } from '../providers/registry.js';
import { loadConfig } from '../config/loader.js';
import { logInvocation } from '../providers/invocation-logger.js';

interface MergeLockRecord {
  id: number;
  session_id: string;
  runner_id: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

interface MergeProgressRow {
  id: number;
  session_id: string;
  workstream_id: string;
  position: number;
  commit_sha: string;
  status: 'applied' | 'conflict' | 'skipped';
  conflict_task_id: string | null;
  created_at: string;
  applied_at: string | null;
}

export interface MergeWorkstreamSpec {
  id: string;
  branchName: string;
}

export interface MergeOptions {
  projectPath: string;
  sessionId: string;
  runnerId: string;
  workstreams: MergeWorkstreamSpec[];
  remote?: string;
  mainBranch?: string;
  lockTimeoutMinutes?: number;
  heartbeatIntervalMs?: number;
  remoteWorkspaceRoot?: string;
  cleanupOnSuccess?: boolean;
}

export interface MergeResult {
  success: boolean;
  completedCommits: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

interface MergeLockOptions {
  sessionId: string;
  runnerId: string;
  timeoutMinutes: number;
}

const DEFAULT_REMOTE = 'origin';
const DEFAULT_MAIN_BRANCH = 'main';
const DEFAULT_LOCK_TIMEOUT_MINUTES = 120;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export class ParallelMergeError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'PARALLEL_MERGE_ERROR', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParallelMergeError';
    this.code = code;
  }
}

function runGitCommand(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; maxBuffer?: number; timeoutMs?: number } = {}
): string {
  const { allowFailure = false, timeoutMs = 120_000 } = options;

  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: options.maxBuffer,
    }).trim();
  } catch (error: unknown) {
    if (allowFailure) {
      if (error instanceof Error) {
        const err = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
        return [err.stdout, err.stderr]
          .map((value) => (typeof value === 'string' ? value : value?.toString()))
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      return '';
    }

    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    const details = [stderr, stdout].filter(Boolean).join('\n') || err.message || 'Unknown git error';
    throw new ParallelMergeError(`Git command failed: git ${args.join(' ')}\n${details}`, 'GIT_ERROR');
  }
}

function getNowISOString(): string {
  return new Date().toISOString();
}

function utcExpiresAt(timeoutMinutes: number): string {
  return new Date(Date.now() + timeoutMinutes * 60_000).toISOString();
}

function isLockExpired(lock: MergeLockRecord): boolean {
  return new Date(lock.expires_at).getTime() < Date.now();
}

function getLatestMergeLock(db: Database.Database, sessionId: string): MergeLockRecord | null {
  return db
    .prepare(
      `SELECT * FROM merge_locks
       WHERE session_id = ?
       ORDER BY acquired_at DESC
       LIMIT 1`
    )
    .get(sessionId) as MergeLockRecord | null;
}

function acquireMergeLock(db: Database.Database, options: MergeLockOptions): { acquired: boolean; lock?: MergeLockRecord } {
  const lock = getLatestMergeLock(db, options.sessionId);

  if (lock && !isLockExpired(lock)) {
    if (lock.runner_id === options.runnerId) {
      const refreshed = runMergeLockQuery(db, lock.session_id, options.runnerId, options.timeoutMinutes);
      return { acquired: true, lock: refreshed };
    }

    return { acquired: false, lock };
  }

  db.prepare('DELETE FROM merge_locks WHERE session_id = ?').run(options.sessionId);

  const inserted = db.prepare(
    'INSERT INTO merge_locks (session_id, runner_id, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    options.sessionId,
    options.runnerId,
    getNowISOString(),
    utcExpiresAt(options.timeoutMinutes),
    getNowISOString()
  );

  if (inserted.changes !== 1) {
    return { acquired: false };
  }

  return { acquired: true, lock: getLatestMergeLock(db, options.sessionId) ?? undefined };
}

function runMergeLockQuery(
  db: Database.Database,
  sessionId: string,
  runnerId: string,
  timeoutMinutes: number
): MergeLockRecord {
  db.prepare(
    `UPDATE merge_locks
     SET heartbeat_at = datetime('now'), expires_at = ?, acquired_at = datetime('now')
     WHERE session_id = ? AND runner_id = ?`
  ).run(utcExpiresAt(timeoutMinutes), sessionId, runnerId);

  const lock = getLatestMergeLock(db, sessionId);
  if (!lock) {
    throw new ParallelMergeError('Lost merge lock unexpectedly', 'MERGE_LOCK_NOT_FOUND');
  }
  return lock;
}

function refreshMergeLock(
  db: Database.Database,
  sessionId: string,
  runnerId: string,
  timeoutMinutes: number
): void {
  runMergeLockQuery(db, sessionId, runnerId, timeoutMinutes);
}

function releaseMergeLock(db: Database.Database, sessionId: string, runnerId: string): void {
  db.prepare('DELETE FROM merge_locks WHERE session_id = ? AND runner_id = ?').run(sessionId, runnerId);
}

function listMergeProgress(db: Database.Database, sessionId: string): MergeProgressRow[] {
  return db
    .prepare(
      `SELECT id, session_id, workstream_id, position, commit_sha, status, conflict_task_id, created_at, applied_at
       FROM merge_progress
       WHERE session_id = ?
       ORDER BY workstream_id, position ASC`
    )
    .all(sessionId) as MergeProgressRow[];
}

function clearProgressEntry(
  db: Database.Database,
  sessionId: string,
  workstreamId: string,
  position: number
): void {
  db.prepare(
    'DELETE FROM merge_progress WHERE session_id = ? AND workstream_id = ? AND position = ?'
  ).run(sessionId, workstreamId, position);
}

function isNonFatalFetchResult(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('couldn\\'t find remote ref') ||
    lower.includes('does not exist') ||
    lower.includes('fatal: remote ref does not exist')
  );
}

function isMissingRemoteBranchFailure(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('couldn\\'t find remote ref') ||
    lower.includes('remote branch') && lower.includes('not found') ||
    lower.includes('unknown revision or path not in the working tree') ||
    lower.includes('does not exist') ||
    lower.includes('fatal: remote ref does not exist')
  );
}

function upsertProgressEntry(
  db: Database.Database,
  sessionId: string,
  workstreamId: string,
  position: number,
  commitSha: string,
  status: MergeProgressRow['status'],
  conflictTaskId: string | null = null
): void {
  const payloadApplied = status === 'applied' ? getNowISOString() : null;

  clearProgressEntry(db, sessionId, workstreamId, position);
  db.prepare(
    `INSERT INTO merge_progress
      (session_id, workstream_id, position, commit_sha, status, conflict_task_id, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, workstreamId, position, commitSha, status, conflictTaskId, payloadApplied);
}

function getMergeProgressForWorkstream(
  rows: MergeProgressRow[],
  workstreamId: string
): MergeProgressRow[] {
  return rows
    .filter((row) => row.workstream_id === workstreamId)
    .sort((left, right) => left.position - right.position);
}

function cleanTreeHasConflicts(projectPath: string): boolean {
  const status = runGitCommand(projectPath, ['status', '--porcelain']);
  return status.split('\n').some((line) => line.startsWith('UU') || line.includes('U'));
}

function hasUnmergedFiles(projectPath: string): boolean {
  const unmerged = runGitCommand(projectPath, ['diff', '--name-only', '--diff-filter=U']);
  return unmerged.trim().length > 0;
}

function gitStatusLines(projectPath: string): string[] {
  const status = runGitCommand(projectPath, ['status', '--porcelain']);
  return status.split('\n').filter(Boolean);
}

function hasCherryPickInProgress(projectPath: string): boolean {
  return existsSync(resolve(projectPath, '.git', 'CHERRY_PICK_HEAD'));
}

function getWorkstreamCommitList(
  projectPath: string,
  remote: string,
  workstreamBranch: string,
  mainBranch: string
): string[] {
  const arg = `${mainBranch}..${remote}/${workstreamBranch}`;
  const output = runGitCommand(
    projectPath,
    ['log', arg, '--format=%H', '--reverse'],
    { allowFailure: true }
  );
  if (/error:|fatal:|error /.test(output.toLowerCase()) && !isMissingRemoteBranchFailure(output)) {
    throw new ParallelMergeError(`Failed to list commits from ${remote}/${workstreamBranch}: ${output}`, 'COMMIT_LIST_FAILED');
  }

  if (isMissingRemoteBranchFailure(output)) {
    return [];
  }

  const commits = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return commits;
}

function getCommitPatch(projectPath: string, commitSha: string): string {
  return runGitCommand(projectPath, ['show', commitSha, '--']);
}

function getCommitMessage(projectPath: string, commitSha: string): string {
  return runGitCommand(projectPath, ['log', '-1', '--format=%s%n%b', commitSha]);
}

function getCommitShortSha(commitSha: string): string {
  return commitSha.length > 7 ? commitSha.slice(0, 7) : commitSha;
}

function getConflictedFiles(projectPath: string): string[] {
  const output = runGitCommand(
    projectPath,
    ['diff', '--name-only', '--diff-filter=U']
  );
  return output.split('\n').filter(Boolean);
}

function getCachedDiff(projectPath: string): string {
  return runGitCommand(projectPath, ['diff', '--cached']);
}

function getCachedFiles(projectPath: string): string[] {
  const output = runGitCommand(projectPath, ['diff', '--cached', '--name-only']);
  return output.split('\n').filter(Boolean);
}

function buildMergeConflictSectionName(): string {
  return 'merge-conflicts';
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

  return `You are resolving a merge conflict for a cherry-pick during parallel merge.

## Conflict context
Workstream: ${options.workstreamId}
Branch: ${options.branchName}
Commit: ${options.shortSha}
Commit Message:
${options.commitMessage}

Conflicted files:
${options.conflictedFiles.map((file) => `- ${file}`).join('\n')}

Intended patch:
${options.conflictPatch}

Rules:
1) Edit conflicted files to a correct resolution.
2) Remove ALL conflict markers (<<<<<<, =======, >>>>>>) in resolved files.
3) Stage only the resolved files using git add.
4) Do NOT commit.
5) Be surgical; change only files required for this commit.

${notesSection}

Respond with a short confirmation when done.`;
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

  return `You are reviewing a staged resolution for a cherry-pick conflict in parallel merge.

Workstream: ${options.workstreamId}
Branch: ${options.branchName}
Commit: ${options.shortSha}
Original message: ${options.commitMessage}

Current staged diff to be committed by cherry-pick --continue:
${options.stagedDiff || '(empty diff)'}

Files staged:
${files}

Decision rules:
- Reply with APPROVE if the resolution is correct.
- Reply with REJECT and actionable notes if any conflict marker remains or logic is incorrect.

Format:
APPROVE - <optional note> or
REJECT - <checklist itemized note>`;
}

function parseReviewDecision(raw: string): { decision: 'approve' | 'reject'; notes: string } {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();

  const approval = upper.includes('APPROVE');
  const rejection = upper.includes('REJECT');

  if (approval && !rejection) {
    return {
      decision: 'approve',
      notes: trimmed || 'APPROVED by merge-conflict reviewer',
    };
  }

  if (rejection) {
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

  const registry = getProviderRegistry();
  const provider = registry.get(modelConfig.provider);
  const result = await logInvocation(
    prompt,
    (ctx) =>
      provider.invoke(prompt, {
        model: modelConfig.model,
        timeout: 60 * 60 * 1000,
        cwd: projectPath,
        role,
        streamOutput: false,
        onActivity: ctx?.onActivity,
      }),
    {
      role,
      provider: modelConfig.provider,
      model: modelConfig.model,
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

async function runConflictResolutionCycle(
  db: Database.Database,
  projectPath: string,
  sessionId: string,
  workstreamId: string,
  branchName: string,
  position: number,
  commitSha: string,
  conflictPatch: string,
  commitMessage: string,
  existingTaskId?: string
): Promise<'continued' | 'skipped'> {
  const shortSha = getCommitShortSha(commitSha);
  const conflictedFiles = getConflictedFiles(projectPath);
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

  let currentTaskId = existingTaskId ?? taskId;

  if (currentTaskId !== taskId) {
    currentTaskId = taskId;
  }

  upsertProgressEntry(
    db,
    sessionId,
    workstreamId,
    position,
    commitSha,
    'conflict',
    currentTaskId
  );

  let conflictTask = getTask(db, currentTaskId);
  if (!conflictTask) {
    throw new ParallelMergeError('Created merge-conflict task not found', 'TASK_MISSING');
  }

  if (conflictTask.status === 'completed') {
    upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'applied', currentTaskId);
    return 'continued';
  }

  updateTaskStatus(db, conflictTask.id, 'in_progress', 'merge-conflict-orchestrator');

  while (true) {
    const existingTask = getTask(db, conflictTask.id);
    const lastNotes = existingTask?.rejection_count ? `After ${existingTask.rejection_count} rejection(s).` : undefined;

    const coderPrompt = createPromptForConflictCoder({
      workstreamId,
      shortSha,
      branchName,
      commitMessage,
      conflictedFiles,
      conflictPatch,
      rejectionNotes: lastNotes,
    });

    await invokeModel('coder', projectPath, conflictTask.id, coderPrompt);

    const remaining = getConflictedFiles(projectPath);
    if (remaining.length > 0) {
      updateTaskStatus(
        db,
        conflictTask.id,
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
        conflictTask.id,
        'in_progress',
        'merge-conflict-orchestrator',
        'No staged diff found. Stage resolved files before requesting review.'
      );
      continue;
    }

    updateTaskStatus(db, conflictTask.id, 'review', 'merge-conflict-orchestrator');

    const reviewerPrompt = createPromptForConflictReviewer({
      workstreamId,
      shortSha,
      branchName,
      commitMessage,
      stagedDiff,
      stagedFiles,
    });

    const decisionText = await invokeModel('reviewer', projectPath, conflictTask.id, reviewerPrompt);
    const decision = parseReviewDecision(decisionText);

    if (decision.decision === 'reject') {
      rejectTask(db, conflictTask.id, 'merge-conflict-reviewer', decision.notes);
      if (cleanTreeHasConflicts(projectPath)) {
        continue;
      }
      // If no conflict files remain but reviewer still rejected, keep iterating after a short wait.
      continue;
    }

    if (hasUnmergedFiles(projectPath)) {
      rejectTask(db, conflictTask.id, 'merge-conflict-reviewer', 'Conflict markers still present. Please fix.');
      continue;
    }

    if (!hasCherryPickInProgress(projectPath)) {
      throw new ParallelMergeError(
        'Cherry-pick no longer in progress while resolving conflict',
        'CHERRY_PICK_CONTEXT_LOST'
      );
    }

    try {
      runGitCommand(projectPath, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
      approveTask(db, conflictTask.id, 'merge-conflict-reviewer', decision.notes);
      upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'applied', conflictTask.id);
      return 'continued';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to commit|previous cherry-pick is empty/i.test(message)) {
        runGitCommand(projectPath, ['cherry-pick', '--skip']);
        upsertProgressEntry(db, sessionId, workstreamId, position, commitSha, 'skipped', conflictTask.id);
        updateTaskStatus(
          db,
          conflictTask.id,
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

async function processWorkstream(
  db: Database.Database,
  projectPath: string,
  sessionId: string,
  workstream: MergeWorkstreamSpec,
  mainBranch: string,
  remote: string,
  progressRows: MergeProgressRow[],
  heartbeat: { sessionId: string; runnerId: string; timeoutMinutes: number }
): Promise<{ applied: number; skipped: number; conflicts: number }> {
  const summary = { applied: 0, skipped: 0, conflicts: 0 };
  const commits = getWorkstreamCommitList(projectPath, remote, workstream.branchName, mainBranch);

  if (commits.length === 0) {
    return summary;
  }

  const workstreamProgress = getMergeProgressForWorkstream(progressRows, workstream.id);
  const workstreamLookup = new Map<number, MergeProgressRow>();
  for (const row of workstreamProgress) {
    workstreamLookup.set(row.position, row);
  }

  for (let position = 0; position < commits.length; position += 1) {
    const commitSha = commits[position];
    const shortSha = getCommitShortSha(commitSha);
    const prior = workstreamLookup.get(position);

    if (prior?.status === 'applied' && prior.commit_sha === commitSha) {
      summary.applied += 1;
      continue;
    }

    if (prior?.status === 'skipped' && prior.commit_sha === commitSha) {
      summary.skipped += 1;
      continue;
    }

    if (prior?.status === 'conflict' && prior.commit_sha === commitSha) {
      if (hasCherryPickInProgress(projectPath)) {
        const conflictPatch = getCommitPatch(projectPath, commitSha);
        const commitMessage = getCommitMessage(projectPath, commitSha);
        const outcome = await runConflictResolutionCycle(
          db,
          projectPath,
          sessionId,
          workstream.id,
          workstream.branchName,
          position,
          commitSha,
          conflictPatch,
          commitMessage,
          prior.conflict_task_id ?? undefined
        );
        if (outcome === 'skipped') summary.skipped += 1;
        else summary.applied += 1;
        summary.conflicts += 1;
        continue;
      }

      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    if (prior && prior.commit_sha !== commitSha) {
      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    try {
      runGitCommand(projectPath, ['cherry-pick', commitSha]);
      upsertProgressEntry(db, sessionId, workstream.id, position, commitSha, 'applied');
      summary.applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CONFLICT|merge conflict|could not apply|needs merge/i.test(message)) {
        throw error;
      }

      summary.conflicts += 1;
      const commitPatch = getCommitPatch(projectPath, commitSha);
      const commitMessage = getCommitMessage(projectPath, commitSha);
      const outcome = await runConflictResolutionCycle(
        db,
        projectPath,
        sessionId,
        workstream.id,
        workstream.branchName,
        position,
        commitSha,
        commitPatch,
        commitMessage
      );

      if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.applied += 1;
      }
    }

    // Refresh heartbeat on every commit for long conflict loops.
    refreshMergeLock(db, heartbeat.sessionId, heartbeat.runnerId, heartbeat.timeoutMinutes);
  }

  return summary;
}

function ensureMergeWorkingTree(projectPath: string): void {
  const lines = gitStatusLines(projectPath);
  if (lines.length === 0) return;

  if (!hasCherryPickInProgress(projectPath)) {
    throw new ParallelMergeError(
      'Working tree is dirty. Commit or stash changes before merging.',
      'DIRTY_WORKTREE'
    );
  }
}

function cleanupWorkspaceState(
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

    if (existsSync(folder)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

function safeRunMergeCommand(projectPath: string, remote: string, branchName: string): void {
  const output = runGitCommand(projectPath, ['fetch', '--prune', remote, branchName], { allowFailure: true });
  const lower = output.toLowerCase();
  if (!/error:|fatal:/.test(lower)) {
    return;
  }

  if (isNonFatalFetchResult(lower)) {
    return;
  }

  throw new ParallelMergeError(`Failed to fetch ${branchName} from ${remote}: ${output}`, 'FETCH_FAILED');
}

export async function runParallelMerge(options: MergeOptions): Promise<MergeResult> {
  const projectPath = resolve(options.projectPath);
  const sessionId = options.sessionId;
  const runnerId = options.runnerId;
  const workstreams = options.workstreams;
  const remote = options.remote ?? DEFAULT_REMOTE;
  const mainBranch = options.mainBranch ?? DEFAULT_MAIN_BRANCH;
  const lockTimeoutMinutes = options.lockTimeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const workspaceRoot = options.remoteWorkspaceRoot ?? getDefaultWorkspaceRoot();
  const cleanupOnSuccess = options.cleanupOnSuccess ?? true;

  const { db, close } = openDatabase(projectPath);
  const summary: MergeResult = {
    success: false,
    completedCommits: 0,
    conflicts: 0,
    skipped: 0,
    errors: [],
  };

  let heartbeatTimer: NodeJS.Timeout | null = null;

  try {
    const lock = acquireMergeLock(db, {
      sessionId,
      runnerId,
      timeoutMinutes: lockTimeoutMinutes,
    });

    if (!lock.acquired) {
      summary.success = false;
      summary.errors.push(`Could not acquire merge lock (held by ${lock.lock?.runner_id ?? 'another process'})`);
      return summary;
    }

    const recoveringFromCherryPick = hasCherryPickInProgress(projectPath);

    heartbeatTimer = setInterval(() => {
      try {
        refreshMergeLock(db, sessionId, runnerId, lockTimeoutMinutes);
      } catch {
        // If heartbeat fails, allow the merge loop to handle lock loss/expiry normally.
      }
    }, heartbeatIntervalMs);

    ensureMergeWorkingTree(projectPath);

    for (const stream of workstreams) {
      safeRunMergeCommand(projectPath, remote, stream.branchName);
    }

    if (!recoveringFromCherryPick) {
      const pullOutput = runGitCommand(projectPath, ['pull', '--ff-only', remote, mainBranch], { allowFailure: true });
      const pullOutputLower = pullOutput.toLowerCase();
      if (pullOutputLower.includes('fatal:') || pullOutputLower.includes('error:') || pullOutputLower.includes('error ')) {
        if (pullOutputLower.includes('could not apply') || pullOutputLower.includes('not possible to fast-forward')) {
          throw new ParallelMergeError(
            'main is behind; local commits detected. Run "git pull --rebase" before merge.',
            'NON_FAST_FORWARD'
          );
        }

        throw new ParallelMergeError(`Failed to refresh main from ${remote}/${mainBranch}: ${pullOutput}`, 'PULL_FAILED');
      }
    }

    const progressRows = listMergeProgress(db, sessionId);
    for (const workstream of workstreams) {
      const stats = await processWorkstream(
        db,
        projectPath,
        sessionId,
        workstream,
        mainBranch,
        remote,
        progressRows,
        { sessionId, runnerId, timeoutMinutes: lockTimeoutMinutes }
      );

      summary.completedCommits += stats.applied;
      summary.skipped += stats.skipped;
      summary.conflicts += stats.conflicts;
    }

    const pushResult = runGitCommand(projectPath, ['push', remote, mainBranch], { allowFailure: true });
    if (pushResult.toLowerCase().includes('error:') || pushResult.toLowerCase().includes('fatal:')) {
      summary.errors.push('Push to main failed.');
      throw new ParallelMergeError(pushResult, 'PUSH_FAILED');
    }

    for (const stream of workstreams) {
      try {
        runGitCommand(projectPath, ['push', remote, '--delete', stream.branchName]);
      } catch {
        // ignore cleanup failures; branch may already be deleted
      }
    }

    runGitCommand(projectPath, ['remote', 'prune', remote]);
    cleanupWorkspaceState(projectPath, workspaceRoot, workstreams.map((stream) => stream.id), {
      cleanupOnSuccess,
    });

    summary.success = true;
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!summary.errors.includes(message)) {
      summary.errors.push(message);
    }
    return summary;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    releaseMergeLock(db, sessionId, runnerId);
    close();
  }
}
