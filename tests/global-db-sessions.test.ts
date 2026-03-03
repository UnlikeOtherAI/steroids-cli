import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';

let globalDb: Database.Database;
let projectDb: Database.Database;

const mockWithGlobalDatabase = jest.fn((callback: (db: Database.Database) => void) => callback(globalDb));
const mockOpenDatabase = jest.fn(() => ({ db: projectDb, close: jest.fn() }));

jest.unstable_mockModule('../src/runners/global-db-connection.js', () => ({
  withGlobalDatabase: mockWithGlobalDatabase,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

const { updateParallelSessionStatus } = await import('../src/runners/global-db-sessions.js');

describe('updateParallelSessionStatus', () => {
  beforeEach(() => {
    globalDb = new Database(':memory:');
    projectDb = new Database(':memory:');

    globalDb.exec(`
      CREATE TABLE parallel_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE runners (
        id TEXT PRIMARY KEY,
        pid INTEGER,
        current_task_id TEXT,
        project_path TEXT,
        parallel_session_id TEXT,
        status TEXT
      );
    `);

    projectDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE task_invocations (
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        success INTEGER,
        timed_out INTEGER,
        exit_code INTEGER,
        completed_at_ms INTEGER,
        duration_ms INTEGER,
        error TEXT
      );
      CREATE TABLE task_locks (
        task_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);

    globalDb
      .prepare('INSERT INTO parallel_sessions (id, status) VALUES (?, ?)')
      .run('sess-1', 'running');
    globalDb
      .prepare(
        `INSERT INTO runners (id, pid, current_task_id, project_path, parallel_session_id, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('runner-1', 999_999, 'task-1', '/tmp/project', 'sess-1', 'running');

    projectDb
      .prepare('INSERT INTO tasks (id, status) VALUES (?, ?)')
      .run('task-1', 'in_progress');
    projectDb
      .prepare('INSERT INTO task_invocations (task_id, status) VALUES (?, ?)')
      .run('task-1', 'running');
    projectDb
      .prepare('INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)')
      .run('task-1', 'runner-1', '2099-01-01T00:00:00.000Z');
    projectDb
      .prepare('INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)')
      .run('task-2', 'runner-1', '2099-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    globalDb.close();
    projectDb.close();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('releases orphan locks when forcing terminal session status', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as never);

    updateParallelSessionStatus('sess-1', 'failed', true);

    const task = projectDb
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get('task-1') as { status: string } | undefined;
    expect(task?.status).toBe('pending');

    const lockCount = projectDb
      .prepare('SELECT COUNT(*) AS count FROM task_locks WHERE runner_id = ?')
      .get('runner-1') as { count: number };
    expect(lockCount.count).toBe(0);

    const session = globalDb
      .prepare('SELECT status, completed_at FROM parallel_sessions WHERE id = ?')
      .get('sess-1') as { status: string; completed_at: string | null } | undefined;
    expect(session?.status).toBe('failed');
    expect(session?.completed_at).toBeTruthy();

    const runnerCount = globalDb
      .prepare('SELECT COUNT(*) AS count FROM runners WHERE parallel_session_id = ?')
      .get('sess-1') as { count: number };
    expect(runnerCount.count).toBe(0);

    expect(killSpy).toHaveBeenCalledWith(999_999, 'SIGTERM');
  });
});
