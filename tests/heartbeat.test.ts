import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { findStaleRunners } from '../src/runners/heartbeat.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pid INTEGER,
      project_path TEXT,
      current_task_id TEXT,
      heartbeat_at TEXT NOT NULL,
      parallel_session_id TEXT
    );

    CREATE TABLE parallel_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL
    );
  `);
  return db;
}

describe('findStaleRunners', () => {
  const db = setupDb();

  afterEach(() => {
    db.prepare('DELETE FROM runners').run();
    db.prepare('DELETE FROM parallel_sessions').run();
  });

  it('includes stale idle runners and excludes fresh runners', () => {
    db.prepare(
      `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at, parallel_session_id)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-6 minutes'), NULL),
              (?, ?, ?, ?, ?, datetime('now', '-6 minutes'), NULL),
              (?, ?, ?, ?, ?, datetime('now', '-1 minutes'), NULL)`
    ).run(
      'idle-stale', 'idle', 111, '/tmp/idle-stale', null,
      'running-stale', 'running', 222, '/tmp/running-stale', 'task-1',
      'idle-fresh', 'idle', 333, '/tmp/idle-fresh', null,
    );

    const stale = findStaleRunners(db);

    expect(stale.map((runner) => runner.id).sort()).toEqual(['idle-stale', 'running-stale']);
    expect(stale.find((runner) => runner.id === 'idle-stale')?.project_path).toBe('/tmp/idle-stale');
  });
});
