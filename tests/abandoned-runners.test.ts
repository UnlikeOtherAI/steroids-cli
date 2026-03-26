import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockIsProcessAlive = jest.fn<(pid: number) => boolean>();
const mockOpenDatabase = jest.fn();
const mockKillProcess = jest.fn();

jest.unstable_mockModule('../src/runners/lock.js', () => ({
  isProcessAlive: mockIsProcessAlive,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/runners/wakeup-runner.js', () => ({
  killProcess: mockKillProcess,
}));

const {
  findAbandonedRunners,
  cleanupAbandonedRunners,
} = await import('../src/runners/abandoned-runners.js');

function createGlobalDb(): Database.Database {
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
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE TABLE projects (
      path TEXT PRIMARY KEY,
      name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      runner_id TEXT,
      lease_expires_at TEXT
    );
  `);
  return db;
}

describe('abandoned runners', () => {
  let globalDb: Database.Database;

  beforeEach(() => {
    jest.clearAllMocks();
    globalDb = createGlobalDb();
    mockOpenDatabase.mockReturnValue({
      db: {
        prepare: () => ({ run: jest.fn() }),
      },
      close: jest.fn(),
    });
  });

  afterEach(() => {
    globalDb.close();
  });

  it('finds a dead idle runner with a broken parallel session mapping', () => {
    globalDb.prepare(
      `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at, parallel_session_id)
       VALUES (?, 'idle', ?, ?, NULL, datetime('now', '-1 day'), ?)`
    ).run('runner-1', 4321, '/tmp/parallel-project', 'session-1');
    mockIsProcessAlive.mockReturnValue(false);

    const abandoned = findAbandonedRunners(globalDb);

    expect(abandoned).toEqual([
      expect.objectContaining({
        id: 'runner-1',
        status: 'idle',
        pid: 4321,
        project_path: '/tmp/parallel-project',
        raw_project_path: '/tmp/parallel-project',
        parallel_session_id: 'session-1',
        project_resolved: false,
        process_alive: false,
        reason: 'dead_pid',
      }),
    ]);
  });

  it('marks a stale live process as stale_heartbeat instead of dead_pid', () => {
    globalDb.prepare(
      `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at, parallel_session_id)
       VALUES (?, 'running', ?, ?, NULL, datetime('now', '-10 minutes'), NULL)`
    ).run('runner-2', 9876, '/tmp/project-a');
    mockIsProcessAlive.mockReturnValue(true);

    const abandoned = findAbandonedRunners(globalDb);

    expect(abandoned).toEqual([
      expect.objectContaining({
        id: 'runner-2',
        reason: 'stale_heartbeat',
        process_alive: true,
        project_resolved: false,
      }),
    ]);
  });

  it('cleans abandoned rows and releases workstream ownership', () => {
    globalDb.prepare(
      `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at, parallel_session_id)
       VALUES (?, 'idle', ?, ?, NULL, datetime('now', '-2 hours'), NULL)`
    ).run('runner-3', 2468, '/tmp/project-a');
    globalDb.prepare(
      `INSERT INTO workstreams (id, runner_id, lease_expires_at) VALUES ('ws-1', ?, NULL)`
    ).run('runner-3');
    mockIsProcessAlive.mockReturnValue(true);

    const results = cleanupAbandonedRunners(globalDb, {
      dryRun: false,
      log: jest.fn(),
    });

    expect(results).toEqual([
      expect.objectContaining({
        action: 'cleaned',
        staleRunners: 1,
      }),
    ]);
    expect(mockKillProcess).toHaveBeenCalledWith(2468);
    expect(globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('runner-3')).toBeUndefined();

    const workstream = globalDb.prepare(
      'SELECT runner_id FROM workstreams WHERE id = ?',
    ).get('ws-1') as { runner_id: string | null };
    expect(workstream.runner_id).toBeNull();
  });
});
