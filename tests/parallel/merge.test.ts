/**
 * Tests for parallel merge orchestration and conflict recovery.
 */

import Database from 'better-sqlite3';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SCHEMA_SQL } from '../../src/database/schema.js';
import { getProjectHash } from '../../src/parallel/clone.js';

let db: Database.Database;

const mockLoadConfig = jest.fn();
jest.unstable_mockModule('../../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockCreateHash = jest.fn((algorithm: string) => {
  let input = '';
  const hash = {
    update: (chunk: string) => {
      input += chunk;
      return hash;
    },
    digest: (_encoding: string) => `${algorithm}-${input}`,
  };
  return hash;
});

jest.unstable_mockModule('node:crypto', () => ({
  createHash: mockCreateHash,
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

interface GitPlanStep {
  args: string[];
  output?: string;
  error?: string;
}

interface MockGitCommandOptions {
  allowFailure?: boolean;
}

let mergeModule: typeof import('../../src/parallel/merge.js');
let lockModule: typeof import('../../src/parallel/merge-lock.js');
let progressModule: typeof import('../../src/parallel/merge-progress.js');
let conflictModule: typeof import('../../src/parallel/merge-conflict.js');

let gitPlan: GitPlanStep[] = [];
let invocationOutputs: string[] = [];
const commandLog: string[][] = [];

const mockRunGitCommand = jest.fn<(
  projectPath: string,
  args: string[],
  options?: MockGitCommandOptions
) => string>();
const mockCleanTreeHasConflicts = jest.fn<(projectPath: string) => boolean>();
const mockHasUnmergedFiles = jest.fn<(projectPath: string) => boolean>();
const mockGitStatusLines = jest.fn<(projectPath: string) => string[]>();
const mockGetWorkstreamCommitList = jest.fn<(
  projectPath: string,
  remote: string,
  workstreamBranch: string,
  mainBranch: string
) => string[]>();
const mockGetCommitPatch = jest.fn<(projectPath: string, commitSha: string) => string>();
const mockGetCommitMessage = jest.fn<(projectPath: string, commitSha: string) => string>();
const mockGetCommitShortSha = jest.fn<(commitSha: string) => string>((commitSha: string) =>
  commitSha.length > 7 ? commitSha.slice(0, 7) : commitSha
);
const mockGetConflictedFiles = jest.fn<(projectPath: string) => string[]>();
const mockGetCachedDiff = jest.fn<(projectPath: string) => string>();
const mockGetCachedFiles = jest.fn<(projectPath: string) => string[]>();
const mockIsMissingRemoteBranchFailure = jest.fn<(output: string) => boolean>();
const mockIsNonFatalFetchResult = jest.fn<(output: string) => boolean>();
const mockSafeRunMergeCommand = jest.fn<(projectPath: string, remote: string, branchName: string) => void>();
const mockIsNoPushError = jest.fn<(output: string) => boolean>();
const mockHasCherryPickInProgress = jest.fn<(projectPath: string) => boolean>();

jest.unstable_mockModule('../../src/parallel/merge-git.js', () => ({
  runGitCommand: mockRunGitCommand,
  cleanTreeHasConflicts: mockCleanTreeHasConflicts,
  hasUnmergedFiles: mockHasUnmergedFiles,
  gitStatusLines: mockGitStatusLines,
  getWorkstreamCommitList: mockGetWorkstreamCommitList,
  getCommitPatch: mockGetCommitPatch,
  getCommitMessage: mockGetCommitMessage,
  getCommitShortSha: mockGetCommitShortSha,
  getConflictedFiles: mockGetConflictedFiles,
  getCachedDiff: mockGetCachedDiff,
  getCachedFiles: mockGetCachedFiles,
  isMissingRemoteBranchFailure: mockIsMissingRemoteBranchFailure,
  isNonFatalFetchResult: mockIsNonFatalFetchResult,
  safeRunMergeCommand: mockSafeRunMergeCommand,
  isNoPushError: mockIsNoPushError,
  hasCherryPickInProgress: mockHasCherryPickInProgress,
}));

function createDb(): Database.Database {
  const next = new Database(':memory:');
  next.exec(SCHEMA_SQL);
  return next;
}

function createProjectDb(projectPath: string): Database.Database {
  const next = new Database(resolve(projectPath, '.steroids', 'steroids.db'));
  next.exec(SCHEMA_SQL);
  return next;
}

function setGitPlan(steps: GitPlanStep[]): void {
  gitPlan = steps.map((step) => ({ ...step }));
}

function queueInvocationOutputs(outputs: string[]): void {
  invocationOutputs = [...outputs];
}

function takeGitOutput(args: readonly string[]): string {
  const step = gitPlan.shift();
  commandLog.push([...args]);
  if (!step) {
    throw new Error(`Unexpected git command #${commandLog.length}: git ${args.join(' ')}\nPlanned commands remaining: ${gitPlan.length}`);
  }

  expect(step.args).toEqual(expect.arrayContaining(args as string[]));

  if (step.error) {
    const error = new Error(step.error);
    Object.assign(error, { stderr: Buffer.from(step.error), stdout: '' });
    throw error;
  }

  return step.output ?? '';
}

function runMockGitCommand(
  _projectPath: string,
  args: string[],
  options: MockGitCommandOptions = {}
): string {
  try {
    return takeGitOutput(args);
  } catch (error) {
    if (options.allowFailure && error instanceof Error) {
      const mergeError = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
      return [mergeError.stdout, mergeError.stderr]
        .map((value) => (typeof value === 'string' ? value : value?.toString()))
        .filter(Boolean)
        .join('\n')
        .trim();
    }

    throw error;
  }
}

function configureMergeGitMocks(): void {
  const isMissingRemoteBranchFailure = (output: string): boolean => {
    const lower = output.toLowerCase();
    return (
      lower.includes('couldn\'t find remote ref') ||
      (lower.includes('remote branch') && lower.includes('not found')) ||
      lower.includes('unknown revision or path not in the working tree') ||
      lower.includes('does not exist') ||
      lower.includes('fatal: remote ref does not exist')
    );
  };

  const isNonFatalFetchResult = (output: string): boolean => {
    const lower = output.toLowerCase();
    return (
      lower.includes('couldn\'t find remote ref') ||
      lower.includes('does not exist') ||
      lower.includes('fatal: remote ref does not exist')
    );
  };

  const isNoPushError = (output: string): boolean => {
    const lower = output.toLowerCase();
    return lower.includes('error:') || lower.includes('fatal:');
  };

  const getConflictedFiles = (projectPath: string): string[] =>
    runMockGitCommand(projectPath, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n')
      .filter(Boolean);

  mockRunGitCommand.mockImplementation(runMockGitCommand);
  mockCleanTreeHasConflicts.mockImplementation((projectPath: string) => {
    return getConflictedFiles(projectPath).length > 0;
  });
  mockHasUnmergedFiles.mockImplementation((projectPath: string) => {
    return getConflictedFiles(projectPath).length > 0;
  });
  mockGitStatusLines.mockImplementation((projectPath: string) => {
    return runMockGitCommand(projectPath, ['status', '--porcelain'])
      .split('\n')
      .filter(Boolean);
  });
  mockGetWorkstreamCommitList.mockImplementation((
    projectPath: string,
    remote: string,
    workstreamBranch: string,
    mainBranch: string
  ) => {
    const arg = `${mainBranch}..${remote}/${workstreamBranch}`;
    const output = runMockGitCommand(projectPath, ['log', arg, '--format=%H', '--reverse'], { allowFailure: true });

    if (isMissingRemoteBranchFailure(output)) {
      return [];
    }

    if (/error:|fatal:|error /.test(output.toLowerCase())) {
      throw new Error(`Failed to list commits from ${remote}/${workstreamBranch}: ${output}`);
    }

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  });
  mockGetCommitPatch.mockImplementation((projectPath: string, commitSha: string) => {
    return runMockGitCommand(projectPath, ['show', commitSha, '--']);
  });
  mockGetCommitMessage.mockImplementation((projectPath: string, commitSha: string) => {
    return runMockGitCommand(projectPath, ['log', '-1', '--format=%s%n%b', commitSha]);
  });
  mockGetCachedDiff.mockImplementation((projectPath: string) => {
    return runMockGitCommand(projectPath, ['diff', '--cached']);
  });
  mockGetCachedFiles.mockImplementation((projectPath: string) => {
    return runMockGitCommand(projectPath, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  });
  mockGetConflictedFiles.mockImplementation(getConflictedFiles);
  mockSafeRunMergeCommand.mockImplementation((
    projectPath: string,
    remote: string,
    branchName: string
  ) => {
    const output = runMockGitCommand(projectPath, ['fetch', '--prune', remote, branchName], { allowFailure: true });
    const lower = output.toLowerCase();

    if (!/error:|fatal:/.test(lower)) {
      return;
    }

    if (isNonFatalFetchResult(lower)) {
      return;
    }

    throw new Error(`Failed to fetch ${branchName} from ${remote}: ${output}`);
  });

  mockIsNoPushError.mockImplementation(isNoPushError);

  // Keep helper checks aligned with production implementations.
  mockIsMissingRemoteBranchFailure.mockImplementation(isMissingRemoteBranchFailure);
  mockIsNonFatalFetchResult.mockImplementation(isNonFatalFetchResult);
  mockHasCherryPickInProgress.mockImplementation((projectPath: string) => {
    return existsSync(resolve(projectPath, '.git', 'CHERRY_PICK_HEAD'));
  });
}

[mergeModule, lockModule, progressModule, conflictModule] = await Promise.all([
  import('../../src/parallel/merge.js'),
  import('../../src/parallel/merge-lock.js'),
  import('../../src/parallel/merge-progress.js'),
  import('../../src/parallel/merge-conflict.js'),
]);

const registryModule = await import('../../src/providers/registry.js');

beforeEach(async () => {
  db = createDb();
  jest.clearAllMocks();
  gitPlan = [];
  invocationOutputs = [];
  commandLog.splice(0, commandLog.length);

  mockLoadConfig.mockReturnValue({
    ai: {
      coder: { provider: 'mock', model: 'mock-model' },
      reviewer: { provider: 'mock', model: 'mock-model' },
    },
  });

  (registryModule as unknown as { setProviderRegistry: (registry: unknown) => void }).setProviderRegistry({
    get: () => ({
      invoke: async () => {
        const response = invocationOutputs.shift() ?? 'APPROVE';
        return {
          success: true,
          exitCode: 0,
          stdout: response,
          stderr: '',
          duration: 1,
          timedOut: false,
        };
      },
    }),
  });

  configureMergeGitMocks();
});

afterEach(() => {
  if (db) {
    db.close();
  }
});

describe('parseReviewDecision', () => {
  it('parses explicit APPROVE', () => {
    const result = conflictModule.parseReviewDecision('APPROVE - looks good');
    expect(result.decision).toBe('approve');
  });

  it('parses explicit REJECT', () => {
    const result = conflictModule.parseReviewDecision('REJECT - this is incorrect');
    expect(result.decision).toBe('reject');
  });

  it('treats ambiguous responses as reject', () => {
    const result = conflictModule.parseReviewDecision('This is partly APPROVE, but also REJECT for conflicts');
    expect(result.decision).toBe('reject');
  });
});

describe('merge lock behavior', () => {
  it('acquires lock when none exists', () => {
    const result = lockModule.acquireMergeLock(db, {
      sessionId: 'session-1',
      runnerId: 'runner-a',
      timeoutMinutes: 120,
    });

    expect(result.acquired).toBe(true);
    expect(result.lock?.runner_id).toBe('runner-a');
  });

  it('rejects lock when held by another active runner', () => {
    const lockRow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO merge_locks (session_id, runner_id, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'session-2',
      'runner-current',
      new Date().toISOString(),
      lockRow,
      new Date().toISOString()
    );

    const result = lockModule.acquireMergeLock(db, {
      sessionId: 'session-2',
      runnerId: 'runner-other',
      timeoutMinutes: 120,
    });

    expect(result.acquired).toBe(false);
    expect(result.lock?.runner_id).toBe('runner-current');
  });

  it('replaces lock when expired', () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      'INSERT INTO merge_locks (session_id, runner_id, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)'
    ).run('session-3', 'runner-stale', new Date().toISOString(), stale, new Date().toISOString());

    const result = lockModule.acquireMergeLock(db, {
      sessionId: 'session-3',
      runnerId: 'runner-fresh',
      timeoutMinutes: 120,
    });

    expect(result.acquired).toBe(true);
    expect(result.lock?.runner_id).toBe('runner-fresh');
  });

  it('refreshes existing lock heartbeat', () => {
    lockModule.acquireMergeLock(db, {
      sessionId: 'session-4',
      runnerId: 'runner-refresh',
      timeoutMinutes: 120,
    });

    const before = lockModule.getLatestMergeLock(db, 'session-4');
    expect(before).toBeTruthy();

    const after = lockModule.refreshMergeLock(db, 'session-4', 'runner-refresh', 120);
    expect(after.id).toBe(before!.id);
    expect(new Date(after.heartbeat_at).getTime()).toBeGreaterThanOrEqual(new Date(before!.heartbeat_at).getTime());
  });
});

describe('merge progress tracking', () => {
  it('stores and clears progress entries', () => {
    progressModule.upsertProgressEntry(db, 'session-progress', 'ws-1', 0, 'abc123', 'applied');
    progressModule.upsertProgressEntry(db, 'session-progress', 'ws-1', 1, 'def456', 'conflict', 'task-1');

    const rows = progressModule.listMergeProgress(db, 'session-progress');
    expect(rows).toHaveLength(2);
    expect(progressModule.getMergeProgressForWorkstream(rows, 'ws-1').map((row) => row.position)).toEqual([0, 1]);

    progressModule.clearProgressEntry(db, 'session-progress', 'ws-1', 0);
    const remaining = progressModule.listMergeProgress(db, 'session-progress');
    expect(remaining.map((row) => row.position)).toEqual([1]);
  });
});

describe('runParallelMerge integration', () => {
  const createProjectAndWorkspace = () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'steroids-merge-XXXXXX'));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'steroids-merge-workspace-XXXXXX'));
    mkdirSync(resolve(projectPath, '.steroids'), { recursive: true });
    mkdirSync(resolve(projectPath, '.git'), { recursive: true });
    db = createProjectDb(projectPath);
    return { projectPath, workspaceRoot };
  };

  it('merges successfully with clean cherry-pick path', async () => {
    const { projectPath, workspaceRoot } = createProjectAndWorkspace();
    setGitPlan([
      { args: ['status', '--porcelain'], output: '' },
      { args: ['fetch', '--prune', 'origin', 'steroids/ws-alpha'], output: '' },
      { args: ['pull', '--ff-only', 'origin', 'main'], output: '' },
      { args: ['log', 'main..origin/steroids/ws-alpha', '--format=%H', '--reverse'], output: 'commit-a\ncommit-b' },
      { args: ['cherry-pick', 'commit-a'], output: '' },
      { args: ['cherry-pick', 'commit-b'], output: '' },
      { args: ['push', 'origin', 'main'], output: 'ok' },
      { args: ['push', 'origin', '--delete', 'steroids/ws-alpha'], output: '' },
      { args: ['remote', 'prune', 'origin'], output: '' },
    ]);

    const result = await mergeModule.runParallelMerge({
      projectPath,
      sessionId: 'merge-session',
      runnerId: 'runner-1',
      workstreams: [{ id: 'alpha', branchName: 'steroids/ws-alpha' }],
      remoteWorkspaceRoot: workspaceRoot,
    });

    expect(result.success).toBe(true);
    expect(result.completedCommits).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(resolve(projectPath, '.steroids', 'steroids.db'))).toBe(true);
  });

  it('resumes from prior progress rows', async () => {
    const { projectPath } = createProjectAndWorkspace();
    progressModule.upsertProgressEntry(db, 'resume-session', 'alpha', 0, 'commit-a', 'applied');

    setGitPlan([
      { args: ['status', '--porcelain'], output: '' },
      { args: ['fetch', '--prune', 'origin', 'steroids/ws-alpha'], output: '' },
      { args: ['pull', '--ff-only', 'origin', 'main'], output: '' },
      { args: ['log', 'main..origin/steroids/ws-alpha', '--format=%H', '--reverse'], output: 'commit-a\ncommit-b' },
      { args: ['cherry-pick', 'commit-b'], output: '' },
      { args: ['push', 'origin', 'main'], output: 'ok' },
      { args: ['push', 'origin', '--delete', 'steroids/ws-alpha'], output: '' },
      { args: ['remote', 'prune', 'origin'], output: '' },
    ]);

    const result = await mergeModule.runParallelMerge({
      projectPath,
      sessionId: 'resume-session',
      runnerId: 'runner-1',
      workstreams: [{ id: 'alpha', branchName: 'steroids/ws-alpha' }],
    });

    expect(result.success).toBe(true);
    expect(result.completedCommits).toBe(2);

    const rows = progressModule.listMergeProgress(db, 'resume-session');
    expect(rows).toHaveLength(2);
  });

  it('handles merge conflict with coder/reviewer loop', async () => {
    const { projectPath } = createProjectAndWorkspace();
    queueInvocationOutputs([
      'coder resolved',
      'APPROVE - conflict resolved',
    ]);

    mkdirSync(resolve(projectPath, '.git'), { recursive: true });
    writeFileSync(resolve(projectPath, '.git', 'CHERRY_PICK_HEAD'), '0000000000000000000000000000000000000000');

    setGitPlan([
      { args: ['status', '--porcelain'], output: '' },
      { args: ['fetch', '--prune', 'origin', 'steroids/ws-alpha'], output: '' },
      { args: ['log', 'main..origin/steroids/ws-alpha', '--format=%H', '--reverse'], output: 'commit-conflict' },
      { args: ['cherry-pick', 'commit-conflict'], error: 'CONFLICT: could not apply commit-conflict' },
      { args: ['diff', '--name-only', '--diff-filter=U'], output: 'src/file.ts' },
      { args: ['show', 'commit-conflict', '--'], output: 'patch' },
      { args: ['log', '-1', '--format=%s%n%b', 'commit-conflict'], output: 'Conflicting commit' },
      { args: ['diff', '--name-only', '--diff-filter=U'], output: 'src/file.ts' },
      { args: ['diff', '--name-only', '--diff-filter=U'], output: '' },
      { args: ['diff', '--cached', '--name-only'], output: 'src/file.ts' },
      { args: ['diff', '--cached'], output: 'staged diff' },
      { args: ['diff', '--name-only', '--diff-filter=U'], output: '' },
      { args: ['-c', 'core.editor=true', 'cherry-pick', '--continue'], output: '' },
      { args: ['push', 'origin', 'main'], output: 'ok' },
      { args: ['push', 'origin', '--delete', 'steroids/ws-alpha'], output: '' },
      { args: ['remote', 'prune', 'origin'], output: '' },
    ]);

    const result = await mergeModule.runParallelMerge({
      projectPath,
      sessionId: 'conflict-session',
      runnerId: 'runner-1',
      workstreams: [{ id: 'alpha', branchName: 'steroids/ws-alpha' }],
    });

    expect(result.success).toBe(true);
    expect(result.completedCommits).toBe(1);
    expect(result.conflicts).toBe(1);
  });

  it('cleans workspace directory after successful merge', async () => {
    const { projectPath, workspaceRoot } = createProjectAndWorkspace();
    const projectHash = getProjectHash(projectPath);
    const sessionPath = resolve(workspaceRoot, projectHash, 'ws-alpha');
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(resolve(sessionPath, '.keep'), 'cleanup target');

    setGitPlan([
      { args: ['status', '--porcelain'], output: '' },
      { args: ['fetch', '--prune', 'origin', 'steroids/ws-alpha'], output: '' },
      { args: ['pull', '--ff-only', 'origin', 'main'], output: '' },
      { args: ['log', 'main..origin/steroids/ws-alpha', '--format=%H', '--reverse'], output: 'commit-a' },
      { args: ['cherry-pick', 'commit-a'], output: '' },
      { args: ['push', 'origin', 'main'], output: 'ok' },
      { args: ['push', 'origin', '--delete', 'steroids/ws-alpha'], output: '' },
      { args: ['remote', 'prune', 'origin'], output: '' },
    ]);

    const result = await mergeModule.runParallelMerge({
      projectPath,
      sessionId: 'cleanup-session',
      runnerId: 'runner-1',
      workstreams: [{ id: 'alpha', branchName: 'steroids/ws-alpha' }],
      remoteWorkspaceRoot: workspaceRoot,
      cleanupOnSuccess: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(sessionPath)).toBe(false);
  });

  it('reports push failures as errors', async () => {
    const { projectPath } = createProjectAndWorkspace();
    setGitPlan([
      { args: ['status', '--porcelain'], output: '' },
      { args: ['fetch', '--prune', 'origin', 'steroids/ws-alpha'], output: '' },
      { args: ['pull', '--ff-only', 'origin', 'main'], output: '' },
      { args: ['log', 'main..origin/steroids/ws-alpha', '--format=%H', '--reverse'], output: 'commit-a' },
      { args: ['cherry-pick', 'commit-a'], output: '' },
      { args: ['push', 'origin', 'main'], output: 'error: failed to push' },
    ]);

    const result = await mergeModule.runParallelMerge({
      projectPath,
      sessionId: 'push-fail-session',
      runnerId: 'runner-1',
      workstreams: [{ id: 'alpha', branchName: 'steroids/ws-alpha' }],
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.includes('Push to main failed.'))).toBe(true);
  });
});
