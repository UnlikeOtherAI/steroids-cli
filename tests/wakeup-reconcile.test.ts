import { describe, it, expect } from '@jest/globals';
import Database from 'better-sqlite3';
import { reconcileParallelSessionRecovery } from '../src/runners/wakeup-reconcile.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parallel_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_expires_at TEXT,
      next_retry_at TEXT,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      clone_path TEXT NOT NULL,
      section_ids TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      last_reconcile_action TEXT,
      last_reconciled_at TEXT
    );

    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      parallel_session_id TEXT,
      project_path TEXT,
      status TEXT,
      heartbeat_at TEXT
    );
  `);
  return db;
}

describe('reconcileParallelSessionRecovery', () => {
  it('schedules restart for expired lease when no active runner is alive for the clone', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO parallel_sessions (id, project_path, status) VALUES (?, ?, ?)`
    ).run('sess-1', '/project', 'running');
    db.prepare(
      `INSERT INTO workstreams (
        id, session_id, status, lease_expires_at, next_retry_at, recovery_attempts, clone_path, section_ids, branch_name
      ) VALUES (?, ?, ?, datetime('now', '-1 minute'), NULL, 0, ?, ?, ?)`
    ).run('ws-1', 'sess-1', 'running', '/project/ws-1', '["section-a"]', 'steroids/ws-1');

    const result = reconcileParallelSessionRecovery(db as any, '/project');

    expect(result.scheduledRetries).toBe(1);
    expect(result.workstreamsToRestart).toHaveLength(1);
    expect(result.workstreamsToRestart[0]?.workstreamId).toBe('ws-1');

    const row = db
      .prepare('SELECT recovery_attempts, last_reconcile_action FROM workstreams WHERE id = ?')
      .get('ws-1') as { recovery_attempts: number; last_reconcile_action: string | null };
    expect(row.recovery_attempts).toBe(1);
    expect(row.last_reconcile_action).toBe('runner_restarted');
  });

  it('does not restart expired lease when active runner heartbeat exists for same session+clone', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO parallel_sessions (id, project_path, status) VALUES (?, ?, ?)`
    ).run('sess-1', '/project', 'running');
    db.prepare(
      `INSERT INTO workstreams (
        id, session_id, status, lease_expires_at, next_retry_at, recovery_attempts, clone_path, section_ids, branch_name
      ) VALUES (?, ?, ?, datetime('now', '-1 minute'), NULL, 0, ?, ?, ?)`
    ).run('ws-1', 'sess-1', 'running', '/project/ws-1', '["section-a"]', 'steroids/ws-1');
    db.prepare(
      `INSERT INTO runners (id, parallel_session_id, project_path, status, heartbeat_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run('runner-1', 'sess-1', '/project/ws-1', 'running');

    const result = reconcileParallelSessionRecovery(db as any, '/project');

    expect(result.scheduledRetries).toBe(0);
    expect(result.workstreamsToRestart).toHaveLength(0);

    const row = db
      .prepare('SELECT recovery_attempts, last_reconcile_action FROM workstreams WHERE id = ?')
      .get('ws-1') as { recovery_attempts: number; last_reconcile_action: string | null };
    expect(row.recovery_attempts).toBe(0);
    expect(row.last_reconcile_action).toBeNull();
  });
});
