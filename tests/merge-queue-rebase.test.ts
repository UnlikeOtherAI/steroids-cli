/**
 * Tests for merge queue rebase cycle — Phase 4 functions.
 *
 * Covers: transitionToRebasing, captureConflictFiles, validateDiffFence,
 * resetBranchToSha, parseRebaseReviewDecision.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { transitionToRebasing } from '../src/orchestrator/merge-queue.js';
import {
  captureConflictFiles,
  validateDiffFence,
  resetBranchToSha,
  parseRebaseReviewDecision,
} from '../src/orchestrator/merge-queue-rebase.js';

// ─── DB helpers ─────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'merge_pending',
      merge_phase TEXT,
      approved_sha TEXT,
      rebase_attempts INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT DEFAULT 'human',
      model TEXT,
      category TEXT,
      error_code TEXT,
      metadata TEXT,
      notes TEXT,
      commit_sha TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertTask(db: Database.Database, id: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    title: `Task ${id}`,
    status: 'merge_pending',
    merge_phase: 'queued',
    approved_sha: 'abc123',
    rebase_attempts: 0,
  };
  const data = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO tasks (id, title, status, merge_phase, approved_sha, rebase_attempts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, data.title, data.status, data.merge_phase, data.approved_sha, data.rebase_attempts);
}

// ─── Git test repo helpers ──────────────────────────────────────────────────

function createBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mq-p4-bare-'));
  execFileSync('git', ['init', '--bare'], { cwd: dir });
  return dir;
}

function createClone(bareDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mq-p4-clone-'));
  execFileSync('git', ['clone', bareDir, '.'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function commitFile(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content);
  execFileSync('git', ['add', filename], { cwd: dir });
  execFileSync('git', ['commit', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

// ─── transitionToRebasing ───────────────────────────────────────────────────

describe('transitionToRebasing', () => {
  test('increments rebase_attempts and sets merge_phase to rebasing', () => {
    const db = createTestDb();
    insertTask(db, 't1', { rebase_attempts: 0 });

    transitionToRebasing(db, 't1', 'test conflicts');

    const task = db.prepare('SELECT merge_phase, rebase_attempts FROM tasks WHERE id = ?').get('t1') as any;
    expect(task.merge_phase).toBe('rebasing');
    expect(task.rebase_attempts).toBe(1);
  });

  test('escalates to disputed when cap reached', () => {
    const db = createTestDb();
    insertTask(db, 't1', { rebase_attempts: 3 }); // next would be 4, exceeds MAX_REBASE_ATTEMPTS=3

    transitionToRebasing(db, 't1', 'cap test');

    const task = db.prepare('SELECT status, merge_phase FROM tasks WHERE id = ?').get('t1') as any;
    expect(task.status).toBe('disputed');
    expect(task.merge_phase).toBeNull();
  });

  test('records audit entry with attempt number', () => {
    const db = createTestDb();
    insertTask(db, 't1', { rebase_attempts: 1 });

    transitionToRebasing(db, 't1', 'conflict reason');

    const audit = db.prepare('SELECT notes FROM audit WHERE task_id = ?').get('t1') as any;
    expect(audit.notes).toContain('attempt 2/3');
    expect(audit.notes).toContain('conflict reason');
  });

  test('cap escalation records audit entry', () => {
    const db = createTestDb();
    insertTask(db, 't1', { rebase_attempts: 3 });

    transitionToRebasing(db, 't1', 'cap exceeded');

    const audit = db.prepare('SELECT to_status, notes FROM audit WHERE task_id = ?').get('t1') as any;
    expect(audit.to_status).toBe('disputed');
    expect(audit.notes).toContain('Rebase cap reached');
  });
});

// ─── resetBranchToSha ───────────────────────────────────────────────────────

describe('resetBranchToSha', () => {
  test('sets HEAD to specified SHA', () => {
    const bare = createBareRepo();
    const clone = createClone(bare);
    const sha1 = commitFile(clone, 'a.txt', 'v1', 'initial');
    commitFile(clone, 'a.txt', 'v2', 'second');
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone });

    resetBranchToSha(clone, 'test-branch', sha1);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf-8' }).trim();
    expect(head).toBe(sha1);
  });
});

// ─── captureConflictFiles ───────────────────────────────────────────────────

describe('captureConflictFiles', () => {
  test('returns conflict file list for conflicting rebase', () => {
    const bare = createBareRepo();
    const clone = createClone(bare);

    // Create initial commit on main
    commitFile(clone, 'shared.txt', 'original', 'initial');
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone });

    // Create task branch with conflicting change
    execFileSync('git', ['checkout', '-b', 'task-branch'], { cwd: clone });
    commitFile(clone, 'shared.txt', 'task version', 'task change');
    execFileSync('git', ['push', 'origin', 'task-branch'], { cwd: clone });

    // Create conflicting change on main
    execFileSync('git', ['checkout', 'main'], { cwd: clone });
    commitFile(clone, 'shared.txt', 'main version', 'main change');
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone });

    // Fetch and checkout task branch
    execFileSync('git', ['fetch', 'origin'], { cwd: clone });
    execFileSync('git', ['checkout', '-B', 'task-branch', 'origin/task-branch'], { cwd: clone });

    const result = captureConflictFiles(clone, 'task-branch', 'main');

    expect(result.ok).toBe(true);
    expect(result.conflictFiles).toContain('shared.txt');
  });

  test('returns ok=true with empty files for clean rebase', () => {
    const bare = createBareRepo();
    const clone = createClone(bare);

    commitFile(clone, 'a.txt', 'v1', 'initial');
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone });

    execFileSync('git', ['checkout', '-b', 'task-branch'], { cwd: clone });
    commitFile(clone, 'b.txt', 'task file', 'task change');
    execFileSync('git', ['push', 'origin', 'task-branch'], { cwd: clone });

    execFileSync('git', ['checkout', 'main'], { cwd: clone });
    commitFile(clone, 'c.txt', 'main file', 'main change');
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone });

    execFileSync('git', ['fetch', 'origin'], { cwd: clone });
    execFileSync('git', ['checkout', '-B', 'task-branch', 'origin/task-branch'], { cwd: clone });

    const result = captureConflictFiles(clone, 'task-branch', 'main');

    expect(result.ok).toBe(true);
    expect(result.conflictFiles).toEqual([]);
  });
});

// ─── validateDiffFence ──────────────────────────────────────────────────────

describe('validateDiffFence', () => {
  test('passes when only allowed files are modified', () => {
    const bare = createBareRepo();
    const clone = createClone(bare);
    const baseSha = commitFile(clone, 'a.txt', 'v1', 'initial');
    commitFile(clone, 'a.txt', 'v2', 'modify allowed');

    const result = validateDiffFence(clone, ['a.txt'], baseSha);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('fails when unrelated files are modified', () => {
    const bare = createBareRepo();
    const clone = createClone(bare);
    const baseSha = commitFile(clone, 'a.txt', 'v1', 'initial');
    commitFile(clone, 'a.txt', 'v2', 'modify allowed');
    commitFile(clone, 'rogue.txt', 'sneaky', 'modify disallowed');

    const result = validateDiffFence(clone, ['a.txt'], baseSha);

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('rogue.txt');
  });

  test('passes with empty diff', () => {
    const bare = createBareRepo();
    const clone = createClone(bare);
    const baseSha = commitFile(clone, 'a.txt', 'v1', 'initial');

    const result = validateDiffFence(clone, ['a.txt'], baseSha);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

// ─── parseRebaseReviewDecision ──────────────────────────────────────────────

describe('parseRebaseReviewDecision', () => {
  test('recognizes DECISION: APPROVE', () => {
    expect(parseRebaseReviewDecision('Looks good.\nDECISION: APPROVE')).toBe('approve');
  });

  test('recognizes DECISION:APPROVE without space', () => {
    expect(parseRebaseReviewDecision('DECISION:APPROVE')).toBe('approve');
  });

  test('defaults to reject without approval token', () => {
    expect(parseRebaseReviewDecision('This needs work.')).toBe('reject');
  });

  test('recognizes DECISION: REJECT explicitly', () => {
    expect(parseRebaseReviewDecision('DECISION: REJECT\nConflicts not resolved properly.')).toBe('reject');
  });

  test('is case-insensitive', () => {
    expect(parseRebaseReviewDecision('decision: approve')).toBe('approve');
  });
});
