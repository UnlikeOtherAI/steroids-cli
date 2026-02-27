/**
 * Tests for the no-op coder submission fix.
 *
 * Covers:
 * 1. postCoderGate: `no_new_commits` reasonCode when no commits since startingSha
 * 2. postCoderGate: `git_error` reasonCode when git log fails (bad SHA range)
 * 3. postCoderGate: success path when commits exist
 * 4. getLogOneline: returns null on failure (not empty string)
 * 5. isNoOp flag: correctly set from submission notes prefix
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { postCoderGate } from '../src/workspace/git-lifecycle.js';
import { getLogOneline } from '../src/workspace/git-helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): string {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-m', 'initial');
  return git(dir, 'rev-parse', 'HEAD');
}

function addCommit(dir: string, filename: string): string {
  writeFileSync(join(dir, filename), '');
  git(dir, 'add', filename);
  git(dir, 'commit', '-m', `add ${filename}`);
  return git(dir, 'rev-parse', 'HEAD');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'steroids-no-op-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLogOneline
// ─────────────────────────────────────────────────────────────────────────────

describe('getLogOneline', () => {
  it('returns null when git log fails (bad SHA)', () => {
    initRepo(tmpDir);
    // A fake SHA that does not exist in the repo
    const badSha = 'deadbeef00000000000000000000000000000000';
    const result = getLogOneline(tmpDir, `${badSha}..HEAD`);
    expect(result).toBeNull();
  });

  it('returns empty string when range has no commits', () => {
    const headSha = initRepo(tmpDir);
    // HEAD..HEAD is always empty
    const result = getLogOneline(tmpDir, `${headSha}..HEAD`);
    expect(result).toBe('');
  });

  it('returns log lines when commits exist in range', () => {
    const startingSha = initRepo(tmpDir);
    addCommit(tmpDir, 'file.txt');
    const result = getLogOneline(tmpDir, `${startingSha}..HEAD`);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// postCoderGate
// ─────────────────────────────────────────────────────────────────────────────

describe('postCoderGate', () => {
  it('returns { ok: false, reasonCode: "no_new_commits" } when no commits since startingSha', () => {
    const headSha = initRepo(tmpDir);
    // No new commits — worktree is clean
    const result = postCoderGate(tmpDir, headSha, 'test task');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('no_new_commits');
      expect(result.reason).toContain('No changes detected');
    }
  });

  it('returns { ok: false, reasonCode: "git_error" } when git log fails (unresolvable SHA)', () => {
    initRepo(tmpDir);
    // Pass a fake SHA that does not exist — git log returns non-zero
    const badSha = 'deadbeef00000000000000000000000000000000';
    const result = postCoderGate(tmpDir, badSha, 'test task');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('git_error');
      expect(result.reason).toContain('git log failed');
    }
  });

  it('returns { ok: true } when new commits exist since startingSha', () => {
    const startingSha = initRepo(tmpDir);
    addCommit(tmpDir, 'feature.ts');
    const result = postCoderGate(tmpDir, startingSha, 'test task');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.autoCommitted).toBe(false);
    }
  });

  it('auto-commits uncommitted changes and returns ok: true', () => {
    const startingSha = initRepo(tmpDir);
    // Create an uncommitted file
    writeFileSync(join(tmpDir, 'uncommitted.ts'), '');
    const result = postCoderGate(tmpDir, startingSha, 'test task');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.autoCommitted).toBe(true);
    }
  });

  it('discriminated union: no_new_commits and git_error are distinguishable at type level', () => {
    const headSha = initRepo(tmpDir);
    const noNewCommitsResult = postCoderGate(tmpDir, headSha, 'test task');
    const badSha = 'deadbeef00000000000000000000000000000000';
    const gitErrorResult = postCoderGate(tmpDir, badSha, 'test task');

    // Both are failures but with distinct reasonCodes
    expect(noNewCommitsResult.ok).toBe(false);
    expect(gitErrorResult.ok).toBe(false);
    if (!noNewCommitsResult.ok && !gitErrorResult.ok) {
      expect(noNewCommitsResult.reasonCode).toBe('no_new_commits');
      expect(gitErrorResult.reasonCode).toBe('git_error');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isNoOp flag logic (mirrors ReviewerRunner.runTask() return expression)
// ─────────────────────────────────────────────────────────────────────────────

describe('isNoOp flag (NO_OP_SUBMISSION marker detection)', () => {
  // Tests the same expression used in ReviewerRunner.runTask():
  //   Boolean((submissionNotes as string | null)?.startsWith('[NO_OP_SUBMISSION]'))

  function computeIsNoOp(submissionNotes: string | null): boolean {
    return Boolean((submissionNotes as string | null)?.startsWith('[NO_OP_SUBMISSION]'));
  }

  it('returns true when notes start with [NO_OP_SUBMISSION]', () => {
    expect(computeIsNoOp('[NO_OP_SUBMISSION] No new commits in pool workspace — reviewer to verify pre-existing work')).toBe(true);
  });

  it('returns false when notes are null', () => {
    expect(computeIsNoOp(null)).toBe(false);
  });

  it('returns false when notes are a normal submission note', () => {
    expect(computeIsNoOp('Implemented the feature as described')).toBe(false);
  });

  it('returns false when notes are empty string', () => {
    expect(computeIsNoOp('')).toBe(false);
  });

  it('returns false when [NO_OP_SUBMISSION] appears mid-string (not prefix)', () => {
    expect(computeIsNoOp('Some prefix [NO_OP_SUBMISSION] here')).toBe(false);
  });
});
