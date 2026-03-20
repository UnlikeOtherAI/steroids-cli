// @ts-nocheck
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadConfig = jest.fn().mockReturnValue({ git: { branch: 'main' } });
const mockGetTask = jest.fn();
const mockOpenDatabase = jest.fn();
const mockGetRegisteredProjects = jest.fn();
const mockResolveRemoteUrl = jest.fn().mockReturnValue('git@github.com:org/repo.git');
const mockExecGit = jest.fn();
const mockIsAncestor = jest.fn();
const mockResolveBaseBranch = jest.fn().mockReturnValue('main');

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: mockGetTask,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProjects: mockGetRegisteredProjects,
}));

jest.unstable_mockModule('../src/workspace/pool.js', () => ({
  resolveRemoteUrl: mockResolveRemoteUrl,
}));

jest.unstable_mockModule('../src/workspace/git-helpers.js', () => ({
  execGit: mockExecGit,
  isAncestor: mockIsAncestor,
  resolveBaseBranch: mockResolveBaseBranch,
}));

let identifyStaleBranches: typeof import('../src/workspace/remote-branch-cleanup.js').identifyStaleBranches;
let cleanupStaleRemoteTaskBranches: typeof import('../src/workspace/remote-branch-cleanup.js').cleanupStaleRemoteTaskBranches;

describe('remote branch cleanup', () => {
  let projectPath: string;

  beforeAll(async () => {
    ({ identifyStaleBranches, cleanupStaleRemoteTaskBranches } = await import('../src/workspace/remote-branch-cleanup.js'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    projectPath = mkdtempSync(join(tmpdir(), 'remote-branch-cleanup-'));
    mockOpenDatabase.mockReturnValue({ db: {}, close: jest.fn() });
    mockExecGit.mockImplementation((cwd: string, args: string[]) => {
      if (args[0] === 'ls-remote') {
        return [
          'aaa refs/heads/steroids/task-task-1',
          'bbb refs/heads/steroids/task-task-2',
          'ccc refs/heads/steroids/task-task-3',
          'ddd refs/heads/steroids/task-task-4',
        ].join('\n');
      }
      if (args[0] === 'fetch') {
        return '';
      }
      if (args[0] === 'push' && args[1] === 'origin' && args[2] === '--delete') {
        return '';
      }
      return '';
    });
    mockGetTask.mockImplementation((_db: unknown, taskId: string) => {
      if (taskId === 'task-1') return { id: taskId, status: 'completed' };
      if (taskId === 'task-2') return { id: taskId, status: 'failed' };
      if (taskId === 'task-3') return { id: taskId, status: 'pending' };
      if (taskId === 'task-4') return { id: taskId, status: 'completed' };
      return null;
    });
    mockIsAncestor.mockImplementation((_cwd: string, ancestor: string) => ancestor === 'aaa' || ancestor === 'bbb');
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('identifies merged completed branches and non-completed terminal branches', () => {
    expect(identifyStaleBranches(projectPath)).toEqual([
      { branchName: 'steroids/task-task-1', taskId: 'task-1', reason: 'merged_completed' },
      { branchName: 'steroids/task-task-2', taskId: 'task-2', reason: 'terminal_not_completed' },
    ]);
  });

  it('deletes identified stale remote branches during wakeup cleanup', () => {
    mockGetRegisteredProjects.mockReturnValue([{ path: projectPath }]);
    const log = jest.fn();

    const deleted = cleanupStaleRemoteTaskBranches(false, log);

    expect(deleted).toBe(2);
    expect(mockExecGit).toHaveBeenCalledWith(
      projectPath,
      ['push', 'origin', '--delete', 'steroids/task-task-1'],
      expect.any(Object)
    );
    expect(mockExecGit).toHaveBeenCalledWith(
      projectPath,
      ['push', 'origin', '--delete', 'steroids/task-task-2'],
      expect.any(Object)
    );
    expect(log).toHaveBeenCalledWith('Deleted 2 stale remote task branch(es)');
  });
});
