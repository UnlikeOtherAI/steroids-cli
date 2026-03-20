// @ts-nocheck
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockWithGlobalDatabase = jest.fn();

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  withGlobalDatabase: mockWithGlobalDatabase,
}));

jest.unstable_mockModule('../src/parallel/clone.js', () => ({
  getProjectHash: jest.fn().mockImplementation((projectPath: string) => `hash:${projectPath}`),
}));

jest.unstable_mockModule('../src/git/status.js', () => ({
  isCommitReachable: jest.fn().mockReturnValue(false),
  isCommitReachableWithFetch: jest.fn().mockReturnValue(false),
}));

let getPoolSlotSources: typeof import('../src/git/submission-resolution.js').getPoolSlotSources;

describe('getPoolSlotSources', () => {
  beforeAll(async () => {
    ({ getPoolSlotSources } = await import('../src/git/submission-resolution.js'));
  });

  let rootDir: string;
  let projectPath: string;
  let siblingSlotPath: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pool-sources-'));
    projectPath = join(rootDir, 'project');
    siblingSlotPath = join(rootDir, 'pool-0');
    mkdirSync(projectPath);
    mkdirSync(siblingSlotPath);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('returns deduped sibling pool slots and skips the current project path', () => {
    mockWithGlobalDatabase.mockImplementation((callback: (db: any) => unknown) =>
      callback({
        prepare: () => ({
          all: () => [
            { slot_path: siblingSlotPath, task_branch: 'steroids/task-1' },
            { slot_path: siblingSlotPath, task_branch: 'steroids/task-1' },
            { slot_path: projectPath, task_branch: 'steroids/task-current' },
            { slot_path: join(rootDir, 'missing-slot'), task_branch: 'steroids/task-missing' },
          ],
        }),
      })
    );

    expect(getPoolSlotSources(projectPath)).toEqual([
      { clonePath: siblingSlotPath, branchName: 'steroids/task-1' },
    ]);
  });
});
