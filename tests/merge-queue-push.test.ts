/**
 * Phase 1 tests: Push restructuring
 *  1.1: pushTaskBranchForDurability
 *  1.2: cleanupPoolSlot no longer pushes
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { pushTaskBranchForDurability } from '../src/commands/push-task-branch.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mq-p1-${prefix}-`));
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

function makeProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'pending',
      section_id TEXT,
      rejection_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      description TEXT,
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

// ─── 1.1: pushTaskBranchForDurability ───────────────────────────────────────

describe('pushTaskBranchForDurability', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeProjectDb();
    db.prepare("INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)").run('task-1', 'Test task', 'in_progress');
  });

  afterEach(() => {
    db.close();
  });

  it('successful push returns ok and does NOT change task status', async () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

    // Create task branch
    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-task-1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'work'], { stdio: 'pipe' });

    const result = await pushTaskBranchForDurability(db, 'task-1', repo, 'steroids/task-task-1', true);
    expect(result.ok).toBe(true);

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get('task-1') as any;
    expect(task.status).toBe('in_progress');
  });

  it('failed push transitions task to blocked_error', async () => {
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', '/nonexistent/path'], { stdio: 'pipe' });

    const result = await pushTaskBranchForDurability(db, 'task-1', repo, 'steroids/task-task-1', true);
    expect(result.ok).toBe(false);

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get('task-1') as any;
    expect(task.status).toBe('blocked_error');
  }, 30_000);

  it('push failure NEVER produces pending or skipped status', async () => {
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', '/nonexistent/path'], { stdio: 'pipe' });

    await pushTaskBranchForDurability(db, 'task-1', repo, 'steroids/task-task-1', true);

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get('task-1') as any;
    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('skipped');
    expect(task.status).toBe('blocked_error');
  }, 30_000);

  it('does NOT set approved_sha (no audit metadata referencing it)', async () => {
    const bare = makeTempDir('bare');
    gitInitBare(bare);
    const repo = makeTempDir('repo');
    gitInitRepo(repo);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'checkout', '-b', 'steroids/task-task-1'], { stdio: 'pipe' });
    writeFileSync(join(repo, 'work.txt'), 'work');
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'work'], { stdio: 'pipe' });

    await pushTaskBranchForDurability(db, 'task-1', repo, 'steroids/task-task-1', true);

    // The function never touches approved_sha — verify no audit entries set it
    const audits = db.prepare("SELECT * FROM audit WHERE task_id = ?").all('task-1') as any[];
    for (const a of audits) {
      if (a.metadata) {
        const meta = JSON.parse(a.metadata);
        expect(meta.approved_sha).toBeUndefined();
      }
    }
  });
});
