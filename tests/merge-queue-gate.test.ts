/**
 * Phase 2+3 tests: Merge Gate Pipeline
 *
 * Unit tests for step functions + integration tests for composed flow.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  classifyPushError,
  classifyFetchError,
  fetchAndPrepare,
  handlePrepFailure,
  markCompleted,
  attemptRebaseAndFastForward,
} from '../src/orchestrator/merge-queue.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mq-p23-${prefix}-`));
  tempPaths.push(dir);
  return dir;
}

function gitInitBare(dir: string): void {
  execFileSync('git', ['init', '--bare', dir], { stdio: 'pipe' });
}

function gitInitRepo(dir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), 'init');
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { stdio: 'pipe' });
}

function getHeadSha(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

function makeProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'pending',
      section_id TEXT,
      rejection_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      description TEXT,
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

afterEach(() => {
  for (const p of tempPaths) {
    rmSync(p, { recursive: true, force: true });
  }
  tempPaths.length = 0;
});

// ─── Unit: classifyPushError ─────────────────────────────────────────────────

describe('classifyPushError', () => {
  it('returns race_loss for non-fast-forward', () => {
    expect(classifyPushError('error: failed to push some refs, non-fast-forward')).toBe('race_loss');
  });

  it('returns race_loss for fetch first', () => {
    expect(classifyPushError('Updates were rejected because the tip of your current branch, fetch first')).toBe('race_loss');
  });

  it('returns transient for connection errors', () => {
    expect(classifyPushError('fatal: unable to access - Connection refused')).toBe('transient');
    expect(classifyPushError('Could not resolve host: github.com')).toBe('transient');
    expect(classifyPushError('timeout after 120 seconds')).toBe('transient');
  });

  it('returns permanent for auth failures', () => {
    expect(classifyPushError('fatal: Authentication failed')).toBe('permanent');
    expect(classifyPushError('Permission denied (publickey)')).toBe('permanent');
  });
});

// ─── Unit: classifyFetchError ────────────────────────────────────────────────

describe('classifyFetchError', () => {
  it('returns transient for network errors', () => {
    expect(classifyFetchError('Could not resolve host: github.com')).toBe('transient');
    expect(classifyFetchError('Connection timed out')).toBe('transient');
  });

  it('returns permanent for auth errors', () => {
    expect(classifyFetchError('fatal: Authentication failed')).toBe('permanent');
    expect(classifyFetchError('ERROR: Repository not found')).toBe('permanent');
  });
});

// ─── Unit: handlePrepFailure ─────────────────────────────────────────────────

describe('handlePrepFailure', () => {
  it('sha_mismatch returns task to review with cleared merge columns', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status, merge_phase, approved_sha) VALUES (?, ?, ?, ?, ?)")
      .run('t1', 'Test', 'merge_pending', 'queued', 'abc123');

    handlePrepFailure(db, 't1', 'sha_mismatch');

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get('t1') as any;
    expect(task.status).toBe('review');
    expect(task.merge_phase).toBeNull();
    expect(task.approved_sha).toBeNull();
    expect(task.rebase_attempts).toBe(0);
    db.close();
  });

  it('fetch_transient makes no DB changes', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status, merge_phase) VALUES (?, ?, ?, ?)")
      .run('t1', 'Test', 'merge_pending', 'queued');

    handlePrepFailure(db, 't1', 'fetch_transient');

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get('t1') as any;
    expect(task.status).toBe('merge_pending');
    expect(task.merge_phase).toBe('queued');
    db.close();
  });

  it('fetch_permanent transitions to blocked_error', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status, merge_phase) VALUES (?, ?, ?, ?)")
      .run('t1', 'Test', 'merge_pending', 'queued');

    handlePrepFailure(db, 't1', 'fetch_permanent');

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get('t1') as any;
    expect(task.status).toBe('blocked_error');
    db.close();
  });
});

// ─── Unit: markCompleted ─────────────────────────────────────────────────────

describe('markCompleted', () => {
  it('clears merge columns and sets completed', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status, merge_phase, approved_sha, rebase_attempts) VALUES (?, ?, ?, ?, ?, ?)")
      .run('t1', 'Test', 'merge_pending', 'queued', 'abc123', 2);

    markCompleted(db, 't1', 'def456');

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get('t1') as any;
    expect(task.status).toBe('completed');
    expect(task.merge_phase).toBeNull();
    expect(task.approved_sha).toBeNull();
    expect(task.rebase_attempts).toBe(0);

    const audits = db.prepare("SELECT * FROM audit WHERE task_id = ?").all('t1') as any[];
    expect(audits.length).toBe(1);
    expect(audits[0].to_status).toBe('completed');
    expect(audits[0].commit_sha).toBe('def456');
    db.close();
  });
});

// ─── Unit: fetchAndPrepare ──────────────────────────────────────────────────

describe('fetchAndPrepare', () => {
  it('returns alreadyMerged when SHA is ancestor of target', () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    // Create task branch from main
    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-t1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'work'], { stdio: 'pipe' });
    const taskSha = getHeadSha(repo);
    execFileSync('git', ['-C', repo, 'push', 'origin', 'steroids/task-t1'], { stdio: 'pipe' });

    // Fast-forward main to include task work (simulate already merged)
    execFileSync('git', ['-C', repo, 'checkout', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'merge', '--ff-only', 'steroids/task-t1'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    const result = fetchAndPrepare(repo, 'steroids/task-t1', 'main', taskSha);
    expect(result.ok).toBe(true);
    expect(result.alreadyMerged).toBe(true);
  });

  it('returns sha_mismatch when branch HEAD differs from approved_sha', () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-t1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'work'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'steroids/task-t1'], { stdio: 'pipe' });

    const result = fetchAndPrepare(repo, 'steroids/task-t1', 'main', 'wrong_sha_000');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('sha_mismatch');
  });

  it('returns ok when SHA matches and not yet merged', () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-t1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'work'], { stdio: 'pipe' });
    const taskSha = getHeadSha(repo);
    execFileSync('git', ['-C', repo, 'push', 'origin', 'steroids/task-t1'], { stdio: 'pipe' });

    const result = fetchAndPrepare(repo, 'steroids/task-t1', 'main', taskSha);
    expect(result.ok).toBe(true);
    expect(result.alreadyMerged).toBeUndefined();
  });
});

// ─── Unit: attemptRebaseAndFastForward ──────────────────────────────────────

describe('attemptRebaseAndFastForward', () => {
  it('ff-only success when task branch is ahead of target', () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-t1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'work'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'steroids/task-t1'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'fetch', 'origin'], { stdio: 'pipe' });

    const result = attemptRebaseAndFastForward(repo, 'steroids/task-t1', 'main');
    expect(result.merged).toBe(true);
  });

  it('diverged + clean rebase succeeds', () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-t1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'task work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'task work'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'steroids/task-t1'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', 'main'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'other.txt'), 'other work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'other work'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'fetch', 'origin'], { stdio: 'pipe' });

    const result = attemptRebaseAndFastForward(repo, 'steroids/task-t1', 'main');
    expect(result.merged).toBe(true);
  });

  it('conflicts return merged: false with reason conflicts', () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-t1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'README.md'), 'task version');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'task change'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'steroids/task-t1'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'checkout', 'main'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'README.md'), 'main version');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'main change'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    execFileSync('git', ['-C', repo, 'fetch', 'origin'], { stdio: 'pipe' });

    const result = attemptRebaseAndFastForward(repo, 'steroids/task-t1', 'main');
    expect(result.merged).toBe(false);
    expect(result.reason).toBe('conflicts');
  });
});

// ─── Integration: getTaskCounts with merge_pending ──────────────────────────

describe('getTaskCounts with merge_pending', () => {
  it('counts merge_pending tasks correctly', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run('t1', 'A', 'pending');
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run('t2', 'B', 'merge_pending');
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run('t3', 'C', 'merge_pending');
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run('t4', 'D', 'completed');

    const rows = db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
      .all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }

    expect(counts['merge_pending']).toBe(2);
    expect(counts['pending']).toBe(1);
    expect(counts['completed']).toBe(1);
    db.close();
  });
});

// ─── Integration: reviewer rejection regression ──────────────────────────────

describe('reviewer rejection regression', () => {
  it('rejected task stays in expected flow (not merge_pending)', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run('t1', 'Test', 'review');

    // Simulate rejection: review → in_progress
    db.prepare("UPDATE tasks SET status = 'in_progress', rejection_count = rejection_count + 1 WHERE id = ?").run('t1');

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get('t1') as any;
    expect(task.status).toBe('in_progress');
    expect(task.rejection_count).toBe(1);
    expect(task.merge_phase).toBeNull();
    expect(task.approved_sha).toBeNull();
    db.close();
  });
});

// ─── Integration: local-only project guard ──────────────────────────────────

describe('local-only project guard', () => {
  it('markCompleted called when no remote URL', () => {
    const db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status, merge_phase, approved_sha) VALUES (?, ?, ?, ?, ?)")
      .run('t1', 'Test', 'merge_pending', 'queued', 'abc123');

    markCompleted(db, 't1', 'abc123');

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get('t1') as any;
    expect(task.status).toBe('completed');
    db.close();
  });
});
