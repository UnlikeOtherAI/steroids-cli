import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { execFileSync } from 'node:child_process';

const mockStatfsSync = jest.fn() as unknown as jest.MockedFunction<typeof fs.statfsSync>;
const mockSymlinkSync = jest.fn();
const mockAccessSync = jest.fn();

jest.unstable_mockModule('node:fs', () => {
  const actualFs = jest.requireActual<typeof fs>('node:fs');
  return {
    ...actualFs,
    statfsSync: mockStatfsSync,
    symlinkSync: mockSymlinkSync,
    accessSync: mockAccessSync,
  };
});

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

type CloneModule = typeof import('./clone.js');
type ExecFileSync = jest.MockedFunction<typeof execFileSync>;
type StatFs = ReturnType<typeof fs.statfsSync>;

const mockExecFileSync = jest.fn() as unknown as ExecFileSync;

let workspaceRoot = '';
let forceCloneFailure = false;
let forceBranchFailure = false;

let createWorkspaceClone: CloneModule['createWorkspaceClone'];
let getProjectHash: CloneModule['getProjectHash'];
let getWorkspacePath: CloneModule['getWorkspacePath'];
let isSameFileSystem: CloneModule['isSameFileSystem'];

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const tempPath = mkdtempSync(join(tmpdir(), `${prefix}-XXXXXX`));
  tempPaths.push(tempPath);
  return tempPath;
}

function cleanupTempPaths(): void {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath) {
      rmSync(tempPath, { recursive: true, force: true });
    }
  }
}

function createProjectFixture(): string {
  const projectPath = makeTempDir('steroids-clone-project');
  const steroidsDirectory = join(projectPath, '.steroids');

  mkdirSync(steroidsDirectory, { recursive: true });
  writeFileSync(join(steroidsDirectory, 'steroids.db'), 'ok');

  return projectPath;
}

function makeStatFs(id: string): StatFs {
  return { type: id } as unknown as StatFs;
}

function setFileSystemIds(projectPath: string, rootPath: string, projectId: string, rootId: string): void {
  const resolvedProjectPath = resolve(projectPath);
  const resolvedRootPath = resolve(rootPath);

  (mockStatfsSync as jest.Mock).mockImplementation((targetPath: unknown) => {
    const resolvedTarget = resolve(String(targetPath));

    if (resolvedTarget === resolvedProjectPath) {
      return makeStatFs(projectId);
    }

    if (resolvedTarget === resolvedRootPath) {
      return makeStatFs(rootId);
    }

    return makeStatFs('other');
  });
}

function configureExecMock(): void {
  mockExecFileSync.mockImplementation(((command: string, args?: readonly string[]) => {
    if (command !== 'git' || !Array.isArray(args)) {
      return '';
    }

    if (args[0] === 'clone') {
      const workspacePath = args[2];
      if (typeof workspacePath === 'string') {
        const workspaceDirectory = resolve(workspacePath);
        mkdirSync(resolve(workspaceDirectory, '..'), { recursive: true });
        mkdirSync(workspacePath, { recursive: true });
        mkdirSync(join(workspacePath, '.git'), { recursive: true });
      }

      if (forceCloneFailure) {
        throw new Error('mocked clone failure');
      }

      return '';
    }

    if (args[2] === 'checkout' && forceBranchFailure) {
      throw new Error('mocked checkout failure');
    }

    return '';
  }) as ExecFileSync);
}

beforeEach(async () => {
  workspaceRoot = makeTempDir('steroids-workspace-root');
  forceCloneFailure = false;
  forceBranchFailure = false;

  (mockStatfsSync as jest.Mock).mockReset();
  configureExecMock();
  (mockStatfsSync as jest.Mock).mockImplementation(() => makeStatFs('same'));

  ({
    createWorkspaceClone,
    getProjectHash,
    getWorkspacePath,
    isSameFileSystem,
  } = await import('./clone.js'));
});

afterEach(() => {
  mockExecFileSync.mockClear();
  mockSymlinkSync.mockReset();
  mockAccessSync.mockReset();
  (mockStatfsSync as jest.Mock).mockReset();
  cleanupTempPaths();
});

describe('src/parallel/clone', () => {
  it('creates workspace clones on the same filesystem with git --local', () => {
    const projectPath = createProjectFixture();
    setFileSystemIds(projectPath, workspaceRoot, 'fs-a', 'fs-a');

    const result = createWorkspaceClone({
      projectPath,
      workstreamId: 'stream',
      branchName: 'steroids/ws-stream',
      workspaceRoot,
    });

    const [cloneCommand, cloneArgs] = mockExecFileSync.mock.calls[0] ?? [];
    const [checkoutCommand, checkoutArgs] = mockExecFileSync.mock.calls[1] ?? [];

    expect(cloneCommand).toBe('git');
    expect(cloneArgs).toEqual(['clone', '--local', projectPath, result.workspacePath]);
    expect(checkoutCommand).toBe('git');
    expect(checkoutArgs).toEqual(['-C', result.workspacePath, 'checkout', '-b', 'steroids/ws-stream']);
    expect(result.usedLocalClone).toBe(true);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      realpathSync(join(projectPath, '.steroids')),
      result.steroidsSymlinkPath
    );
    expect(mockAccessSync).toHaveBeenCalledWith(
      join(result.steroidsSymlinkPath, 'steroids.db'),
      expect.any(Number)
    );
    expect(mockAccessSync).toHaveBeenCalledTimes(1);
  });

  it('creates workspace clones on a different filesystem without git --local', () => {
    const projectPath = createProjectFixture();
    setFileSystemIds(projectPath, workspaceRoot, 'fs-a', 'fs-b');

    const result = createWorkspaceClone({
      projectPath,
      workstreamId: 'stream',
      branchName: 'steroids/ws-stream',
      workspaceRoot,
    });

    const [cloneCommand, cloneArgs] = mockExecFileSync.mock.calls[0] ?? [];

    expect(cloneCommand).toBe('git');
    expect(cloneArgs).toEqual(['clone', projectPath, result.workspacePath]);
    expect(result.usedLocalClone).toBe(false);
  });

  it('detects same and different filesystems', () => {
    const projectPath = createProjectFixture();

    setFileSystemIds(projectPath, workspaceRoot, 'fs-a', 'fs-a');
    expect(isSameFileSystem(projectPath, workspaceRoot)).toBe(true);

    setFileSystemIds(projectPath, workspaceRoot, 'fs-a', 'fs-b');
    expect(isSameFileSystem(projectPath, workspaceRoot)).toBe(false);
  });

  it('produces consistent project hashes', () => {
    const projectPath = createProjectFixture();
    const sameFirst = getProjectHash(projectPath);
    const sameSecond = getProjectHash(projectPath);
    const different = getProjectHash(`${projectPath}-other`);

    expect(sameFirst).toBe(sameSecond);
    expect(sameFirst).not.toBe(different);
    expect(sameFirst).toHaveLength(16);
  });

  it('resolves workspace paths with normalized workstream ids', () => {
    const projectPath = createProjectFixture();
    const hash = getWorkspacePath(projectPath, 'stream', workspaceRoot);
    const normalized = getWorkspacePath(projectPath, 'stream', workspaceRoot);
    const prefixed = getWorkspacePath(projectPath, 'ws-prefixed', workspaceRoot);
    const expected = join(workspaceRoot, getProjectHash(projectPath), 'ws-stream');
    const expectedPrefixed = join(workspaceRoot, getProjectHash(projectPath), 'ws-prefixed');

    expect(normalized).toBe(expected);
    expect(prefixed).toBe(expectedPrefixed);
    expect(hash).toBe(expected);
  });

  it('throws for missing project paths', () => {
    expect(() => {
      createWorkspaceClone({
        projectPath: join(workspaceRoot, 'does-not-exist'),
        workstreamId: 'stream',
        branchName: 'steroids/ws-stream',
        workspaceRoot,
      });
    }).toThrow('Project path does not exist');

    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('throws for project paths that are not directories', () => {
    const filePath = join(workspaceRoot, 'not-a-directory');
    writeFileSync(filePath, 'not a directory');

    expect(() => {
      createWorkspaceClone({
        projectPath: filePath,
        workstreamId: 'stream',
        branchName: 'steroids/ws-stream',
        workspaceRoot,
      });
    }).toThrow('Project path is not a directory');
  });

  it('throws when the workspace already exists and force is not set', () => {
    const projectPath = createProjectFixture();
    const workspacePath = getWorkspacePath(projectPath, 'stream', workspaceRoot);
    mkdirSync(workspacePath, { recursive: true });

    expect(() => {
      createWorkspaceClone({
        projectPath,
        workstreamId: 'stream',
        branchName: 'steroids/ws-stream',
        workspaceRoot,
      });
    }).toThrow('Workspace already exists');
  });

  it('creates and validates the .steroids symlink in the cloned workspace', () => {
    const projectPath = createProjectFixture();
    setFileSystemIds(projectPath, workspaceRoot, 'fs-a', 'fs-a');

    const result = createWorkspaceClone({
      projectPath,
      workstreamId: 'stream',
      branchName: 'steroids/ws-stream',
      workspaceRoot,
    });

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      realpathSync(join(projectPath, '.steroids')),
      result.steroidsSymlinkPath
    );
    expect(mockAccessSync).toHaveBeenCalledWith(
      join(result.steroidsSymlinkPath, 'steroids.db'),
      expect.any(Number)
    );
  });

  it('cleans workspace on clone command failure', () => {
    const projectPath = createProjectFixture();
    const workspacePath = getWorkspacePath(projectPath, 'stream', workspaceRoot);
    forceCloneFailure = true;

    expect(() => {
      createWorkspaceClone({
        projectPath,
        workstreamId: 'stream',
        branchName: 'steroids/ws-stream',
        workspaceRoot,
      });
    }).toThrow('Git clone failed');

    expect(existsSync(workspacePath)).toBe(false);
  });

  it('cleans workspace on branch creation failure', () => {
    const projectPath = createProjectFixture();
    const workspacePath = getWorkspacePath(projectPath, 'stream', workspaceRoot);
    forceBranchFailure = true;

    expect(() => {
      createWorkspaceClone({
        projectPath,
        workstreamId: 'stream',
        branchName: 'steroids/ws-stream',
        workspaceRoot,
      });
    }).toThrow('Failed to create branch in clone');

    expect(existsSync(workspacePath)).toBe(false);
  });
});
