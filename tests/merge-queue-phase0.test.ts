/**
 * Phase 0 prerequisite tests:
 *  0.1: pushWithRetriesAsync — async push with setTimeout backoff
 *  0.2: acquireWorkspaceMergeLock — tryOnce mode + 90s stale TTL
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { pushWithRetriesAsync } from '../src/workspace/git-helpers.js';
import {
  acquireWorkspaceMergeLock,
  releaseWorkspaceMergeLock,
} from '../src/workspace/merge-lock.js';
import { GLOBAL_SCHEMA_V19_SQL } from '../src/runners/global-db-schema.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mq-p0-${prefix}-`));
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

function makeGlobalDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF'); // tests don't need FK enforcement for lock table
  db.exec(GLOBAL_SCHEMA_V19_SQL);
  return db;
}

afterEach(() => {
  for (const p of tempPaths) {
    rmSync(p, { recursive: true, force: true });
  }
  tempPaths.length = 0;
});

// ─── 0.1: pushWithRetriesAsync ──────────────────────────────────────────────

describe('pushWithRetriesAsync', () => {
  it('succeeds on first attempt when remote is reachable', async () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });

    const result = await pushWithRetriesAsync(repo, 'origin', 'main', 1);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('fails after exhausting retries against bad remote', async () => {
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', '/nonexistent/path'], { stdio: 'pipe' });

    const result = await pushWithRetriesAsync(repo, 'origin', 'main', 2, [10, 10]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Push failed after 2 attempts');
  });

  it('does not block event loop during backoff', async () => {
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', '/nonexistent/path'], { stdio: 'pipe' });

    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 5);

    // Use short backoff so test is fast, but long enough for timer to fire
    await pushWithRetriesAsync(repo, 'origin', 'main', 2, [50]);

    clearTimeout(timer);
    expect(timerFired).toBe(true);
  });

  it('supports --force-with-lease', async () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    // Push once to set upstream tracking
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    // Make a new commit and force-with-lease push
    writeFileSync(join(repo, 'file.txt'), 'change');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'change'], { stdio: 'pipe' });

    const result = await pushWithRetriesAsync(repo, 'origin', 'main', 1, [], true);
    expect(result.success).toBe(true);
  });
});

// ─── 0.2: acquireWorkspaceMergeLock ─────────────────────────────────────────

describe('acquireWorkspaceMergeLock', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeGlobalDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('tryOnce mode', () => {
    it('acquires lock when none exists', () => {
      const acquired = acquireWorkspaceMergeLock(db, 'proj-1', 'runner-1', 1, 0, 0, true);
      expect(acquired).toBe(true);

      const row = db.prepare('SELECT * FROM workspace_merge_locks WHERE project_id = ?').get('proj-1') as any;
      expect(row).toBeTruthy();
      expect(row.runner_id).toBe('runner-1');
    });

    it('returns false immediately when lock is held', () => {
      acquireWorkspaceMergeLock(db, 'proj-1', 'runner-1', 1, 0, 0, true);

      const start = Date.now();
      const acquired = acquireWorkspaceMergeLock(db, 'proj-1', 'runner-2', 2, 0, 0, true);
      const elapsed = Date.now() - start;

      expect(acquired).toBe(false);
      expect(elapsed).toBeLessThan(50); // should be near-instant
    });
  });

  describe('stale lock reclamation at 90s', () => {
    it('reclaims lock older than 90s', () => {
      // Insert a stale lock (100s old)
      const staleTime = Date.now() - 100_000;
      db.prepare(
        `INSERT INTO workspace_merge_locks (project_id, runner_id, slot_id, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('proj-1', 'runner-old', 1, staleTime, staleTime);

      const acquired = acquireWorkspaceMergeLock(db, 'proj-1', 'runner-new', 2, 0, 0, true);
      expect(acquired).toBe(true);

      const row = db.prepare('SELECT * FROM workspace_merge_locks WHERE project_id = ?').get('proj-1') as any;
      expect(row.runner_id).toBe('runner-new');
    });

    it('does NOT reclaim lock younger than 90s', () => {
      // Insert a fresh lock (60s old)
      const freshTime = Date.now() - 60_000;
      db.prepare(
        `INSERT INTO workspace_merge_locks (project_id, runner_id, slot_id, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('proj-1', 'runner-fresh', 1, freshTime, freshTime);

      const acquired = acquireWorkspaceMergeLock(db, 'proj-1', 'runner-new', 2, 0, 0, true);
      expect(acquired).toBe(false);
    });
  });

  describe('default polling mode (backward compat)', () => {
    it('acquires lock without tryOnce parameter', () => {
      const acquired = acquireWorkspaceMergeLock(db, 'proj-1', 'runner-1', 1);
      expect(acquired).toBe(true);
    });

    it('release clears lock', () => {
      acquireWorkspaceMergeLock(db, 'proj-1', 'runner-1', 1, 0, 0, true);
      releaseWorkspaceMergeLock(db, 'proj-1');

      const row = db.prepare('SELECT * FROM workspace_merge_locks WHERE project_id = ?').get('proj-1');
      expect(row).toBeUndefined();
    });
  });
});
