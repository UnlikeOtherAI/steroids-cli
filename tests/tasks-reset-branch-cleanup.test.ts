import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteTaskBranchFromSlot } from '../src/workspace/git-lifecycle.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('tasks reset branch cleanup integration', () => {
  it('deleteTaskBranchFromSlot cleans up branches from pool-like repos', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'reset-branch-test-'));
    try {
      git(repoDir, ['init']);
      git(repoDir, ['config', 'user.email', 'test@test.com']);
      git(repoDir, ['config', 'user.name', 'Test']);
      git(repoDir, ['commit', '--allow-empty', '-m', 'init']);
      git(repoDir, ['checkout', '-b', 'steroids/task-deadbeef']);
      git(repoDir, ['commit', '--allow-empty', '-m', 'work']);

      // Verify branch exists before cleanup
      expect(git(repoDir, ['branch', '--list', 'steroids/task-deadbeef'])).toContain('steroids/task-deadbeef');

      deleteTaskBranchFromSlot(repoDir, 'steroids/task-deadbeef');

      const branches = git(repoDir, ['branch', '--list', 'steroids/task-deadbeef']);
      expect(branches).toBe('');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns true on successful deletion and false on missing branch', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'reset-branch-test-'));
    try {
      git(repoDir, ['init']);
      git(repoDir, ['config', 'user.email', 'test@test.com']);
      git(repoDir, ['config', 'user.name', 'Test']);
      git(repoDir, ['commit', '--allow-empty', '-m', 'init']);
      git(repoDir, ['checkout', '-b', 'steroids/task-exists']);
      git(repoDir, ['commit', '--allow-empty', '-m', 'work']);

      expect(deleteTaskBranchFromSlot(repoDir, 'steroids/task-exists')).toBe(true);
      expect(deleteTaskBranchFromSlot(repoDir, 'steroids/task-missing')).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
