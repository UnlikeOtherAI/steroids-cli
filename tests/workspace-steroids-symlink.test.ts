import { afterEach, describe, expect, it } from '@jest/globals';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorkspaceSteroidsSymlink } from '../src/parallel/clone.js';

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe('parallel workspace .steroids symlink resilience', () => {
  it('repairs a broken .steroids directory into a symlink and validates db access', () => {
    const sourceProject = makeTempDir('steroids-source');
    const sourceSteroidsDir = join(sourceProject, '.steroids');
    mkdirSync(sourceSteroidsDir, { recursive: true });
    writeFileSync(join(sourceSteroidsDir, 'steroids.db'), 'ok');

    const workspace = makeTempDir('steroids-workspace');
    mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
    mkdirSync(join(workspace, '.steroids', 'logs'), { recursive: true });

    const steroidsPath = ensureWorkspaceSteroidsSymlink(workspace, sourceProject);

    expect(lstatSync(steroidsPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(steroidsPath)).toBe(realpathSync(sourceSteroidsDir));
    expect(() => lstatSync(join(steroidsPath, 'steroids.db'))).not.toThrow();
  });

  it('writes local git exclude entries for .steroids once and without duplicates', () => {
    const sourceProject = makeTempDir('steroids-source');
    mkdirSync(join(sourceProject, '.steroids'), { recursive: true });
    writeFileSync(join(sourceProject, '.steroids', 'steroids.db'), 'ok');

    const workspace = makeTempDir('steroids-workspace');
    mkdirSync(join(workspace, '.git', 'info'), { recursive: true });

    ensureWorkspaceSteroidsSymlink(workspace, sourceProject);
    ensureWorkspaceSteroidsSymlink(workspace, sourceProject);

    const excludePath = join(workspace, '.git', 'info', 'exclude');
    const lines = readFileSync(excludePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const steroidsEntries = lines.filter((line) => line === '.steroids' || line === '/.steroids');
    expect(steroidsEntries).toEqual(['.steroids', '/.steroids']);
  });
});
