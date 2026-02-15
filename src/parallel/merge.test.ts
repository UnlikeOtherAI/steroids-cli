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
import type { execFileSync } from 'node:child_process';
import { SCHEMA_SQL } from '../database/schema.js';
import { getProjectHash } from './clone.js';

type ExecFileSync = jest.MockedFunction<typeof execFileSync>;
const mockExecFileSync = jest.fn() as unknown as ExecFileSync;

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

const mockOpenDatabase = jest.fn() as unknown as jest.MockedFunction<
  typeof import('../database/connection.js').openDatabase
>;
const mockClose = jest.fn();
let db: Database.Database;

jest.unstable_mockModule('../database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
  getDbPath: jest.fn().mockReturnValue('/tmp/steroids.db'),
}));

const mockLoadConfig = jest.fn();
jest.unstable_mockModule('../config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockProviderInvoke = jest.fn();
jest.unstable_mockModule('../providers/registry.js', () => ({
  getProviderRegistry: () => ({
    get: () => ({ invoke: mockProviderInvoke }),
  }),
}));

const mockLogInvocation = jest.fn();
jest.unstable_mockModule('../providers/invocation-logger.js', () => ({
  logInvocation: mockLogInvocation,
}));

interface GitPlanStep {
  args: string[];
  output?: string;
  error?: string;
}

let mergeModule: typeof import('./merge.js');
let lockModule: typeof import('./merge-lock.js');
let progressModule: typeof import('./merge-progress.js');
let conflictModule: typeof import('./merge-conflict.js');

let gitPlan: GitPlanStep[] = [];
let invocationOutputs: string[] = [];

function createDb(): Database.Database {
  const next = new Database(':memory:');
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
  if (!step) {
    throw new Error(`Unexpected git command: git ${args.join(' ')}`);
  }

  expect(step.args).toEqual(expect.arrayContaining(args as string[]));

  if (step.error) {
    throw new Error(step.error);
  }

  return step.output ?? '';
}

beforeEach(async () => {
  db = createDb();
  mockOpenDatabase.mockReturnValue({ db, close: mockClose });
  jest.clearAllMocks();
  mockClose.mockClear();
  gitPlan = [];
  invocationOutputs = [];

  mockExecFileSync.mockImplementation(((command: string, args?: readonly string[]) => {
    if (command !== 'git') {
      throw new Error(`Unexpected command ${command}`);
    }
    if (!Array.isArray(args)) {
      throw new Error('Invalid git args');
    }
    return takeGitOutput(args);
  }) as ExecFileSync);

  mockLoadConfig.mockReturnValue({
    ai: {
      coder: { provider: 'mock', model: 'mock-model' },
      reviewer: { provider: 'mock', model: 'mock-model' },
    },
  });

  mockLogInvocation.mockImplementation(async () => ({
    success: true,
    exitCode: 0,
    stdout: invocationOutputs.shift() ?? 'APPROVE',
    stderr: '',
    duration: 1,
    timedOut: false,
  }));

  [mergeModule, lockModule, progressModule, conflictModule] = await Promise.all([
    import('./merge.js'),
    import('./merge-lock.js'),
    import('./merge-progress.js'),
    import('./merge-conflict.js'),
  ]);
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
      'INSERT INTO merge_locks (session_id, runner_id, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, datetime("now"), ?, datetime("now"))'
    ).run('session-2', 'runner-current', lockRow);

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
      'INSERT INTO merge_locks (session_id, runner_id, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, datetime("now"), ?, datetime("now"))'
    ).run('session-3', 'runner-stale', stale);

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
    mkdirSync(resolve(projectPath, '.git'), { recursive: true });
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
    expect(mockOpenDatabase).toHaveBeenCalledWith(projectPath);
  });

  it('resumes from prior progress rows', async () => {
    progressModule.upsertProgressEntry(db, 'resume-session', 'alpha', 0, 'commit-a', 'applied');

    const { projectPath } = createProjectAndWorkspace();
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
      { args: ['pull', '--ff-only', 'origin', 'main'], output: '' },
      { args: ['log', 'main..origin/steroids/ws-alpha', '--format=%H', '--reverse'], output: 'commit-conflict' },
      { args: ['cherry-pick', 'commit-conflict'], error: 'CONFLICT: could not apply commit-conflict' },
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
