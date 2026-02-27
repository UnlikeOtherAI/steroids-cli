import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureSlotClone } from '../src/workspace/pool.js';
import type { PoolSlot } from '../src/workspace/types.js';

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempPaths.push(dir);
  return dir;
}

function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initGitRepo(path: string): void {
  gitRun(path, ['init']);
  gitRun(path, ['config', 'user.email', 'pool@example.com']);
  gitRun(path, ['config', 'user.name', 'Pool Test']);
  writeFileSync(join(path, 'README.md'), '# test\n');
  gitRun(path, ['add', 'README.md']);
  gitRun(path, ['commit', '-m', 'init']);
}

function makeSlot(slotPath: string): PoolSlot {
  return {
    id: 1,
    project_id: 'proj',
    slot_index: 0,
    slot_path: slotPath,
    remote_url: null,
    runner_id: null,
    task_id: null,
    base_branch: null,
    task_branch: null,
    starting_sha: null,
    status: 'idle',
    claimed_at: null,
    heartbeat_at: null,
  };
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe('workspace pool .steroids symlink', () => {
  it('links slot .steroids directly to sourceProjectPath instead of cloneSourcePath', () => {
    const sourceProjectPath = makeTempDir('source-project');
    initGitRepo(sourceProjectPath);
    const sourceSteroids = join(sourceProjectPath, '.steroids');
    mkdirSync(sourceSteroids, { recursive: true });
    writeFileSync(join(sourceSteroids, 'steroids.db'), 'source');

    const cloneSourcePath = makeTempDir('clone-source');
    execFileSync('git', ['clone', '--no-tags', sourceProjectPath, cloneSourcePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const cloneSteroids = join(cloneSourcePath, '.steroids');
    mkdirSync(cloneSteroids, { recursive: true });
    writeFileSync(join(cloneSteroids, 'steroids.db'), 'clone');

    const slotRoot = makeTempDir('slot-root');
    const slotPath = join(slotRoot, 'pool-0');

    ensureSlotClone(makeSlot(slotPath), null, cloneSourcePath, sourceProjectPath);

    const slotSteroids = join(slotPath, '.steroids');
    expect(existsSync(slotSteroids)).toBe(true);
    expect(lstatSync(slotSteroids).isSymbolicLink()).toBe(true);
    expect(realpathSync(slotSteroids)).toBe(realpathSync(sourceSteroids));
    expect(realpathSync(slotSteroids)).not.toBe(realpathSync(cloneSteroids));
  });
});
