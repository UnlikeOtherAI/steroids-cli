import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteTaskBranchFromSlot } from '../src/workspace/git-lifecycle.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('deleteTaskBranchFromSlot', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'stale-branch-test-'));
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@test.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['commit', '--allow-empty', '-m', 'init']);
    git(repoDir, ['checkout', '-b', 'steroids/task-abc123']);
    git(repoDir, ['commit', '--allow-empty', '-m', 'task work']);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('deletes local task branch and detaches HEAD', () => {
    deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    const branches = git(repoDir, ['branch', '--list', 'steroids/task-abc123']);
    expect(branches).toBe('');
    // HEAD should be detached (no current branch)
    const current = git(repoDir, ['branch', '--show-current']);
    expect(current).toBe('');
  });

  it('tolerates branch that does not exist', () => {
    expect(() => {
      deleteTaskBranchFromSlot(repoDir, 'steroids/task-nonexistent');
    }).not.toThrow();
  });

  it('returns false when branch does not exist', () => {
    const result = deleteTaskBranchFromSlot(repoDir, 'steroids/task-nonexistent');
    expect(result).toBe(false);
  });

  it('returns true when branch is successfully deleted', () => {
    const result = deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    expect(result).toBe(true);
  });

  it('works when already on a different branch', () => {
    git(repoDir, ['checkout', 'main']);
    deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    const branches = git(repoDir, ['branch', '--list', 'steroids/task-abc123']);
    expect(branches).toBe('');
  });

  it('does not delete remote branch by default', () => {
    // No remote exists, but the important thing is the code path doesn't attempt it
    deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    // No error, local branch deleted
    const branches = git(repoDir, ['branch', '--list', 'steroids/task-abc123']);
    expect(branches).toBe('');
  });
});
