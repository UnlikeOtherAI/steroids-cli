import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test the lock cleanup + status reset logic in isolation
// (mirrors what the reset endpoint does)
//
// NOTE: The active-runner guard (hasStandaloneRunner / hasActiveParallelSessionForProjectDb)
// is not covered here — it is a two-condition inline SQL check that requires a live
// globalDb with runners/parallel_sessions tables. Full endpoint integration testing
// is out of scope for this unit test.

function setupProjectDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'steroids.db'));
  const sql = [
    'CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
    'CREATE TABLE task_locks (task_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, acquired_at TEXT NOT NULL DEFAULT (datetime(\'now\')), expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
  ];
  for (const stmt of sql) {
    db.prepare(stmt).run();
  }
  return db;
}

describe('orphaned task reset logic', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steroids-test-'));
    db = setupProjectDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  it('resets in_progress tasks to pending and clears their locks', () => {
    db.prepare("INSERT INTO tasks (id, status) VALUES ('t1', 'in_progress'), ('t2', 'pending'), ('t3', 'failed')").run();
    db.prepare("INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES ('t1', 'r1', datetime('now', '+60 minutes'))").run();

    // Simulate the reset transaction
    db.transaction(() => {
      db.prepare("DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')").run();
      db.prepare("UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'").run();
    })();

    const t1 = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string };
    const t2 = db.prepare("SELECT status FROM tasks WHERE id = 't2'").get() as { status: string };
    const t3 = db.prepare("SELECT status FROM tasks WHERE id = 't3'").get() as { status: string };
    const lock = db.prepare("SELECT task_id FROM task_locks WHERE task_id = 't1'").get();

    expect(t1.status).toBe('pending');      // was in_progress → reset
    expect(t2.status).toBe('pending');      // already pending → unchanged
    expect(t3.status).toBe('failed');       // failed → not touched
    expect(lock).toBeUndefined();           // lock cleared
  });

  it('does not touch tasks with other statuses', () => {
    db.prepare("INSERT INTO tasks (id, status) VALUES ('t1', 'review'), ('t2', 'completed'), ('t3', 'disputed')").run();

    db.transaction(() => {
      db.prepare("DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')").run();
      db.prepare("UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'").run();
    })();

    const statuses = db.prepare('SELECT id, status FROM tasks ORDER BY id').all() as Array<{ id: string; status: string }>;
    expect(statuses.map(r => r.status)).toEqual(['review', 'completed', 'disputed']);
  });
});
