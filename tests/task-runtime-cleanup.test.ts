import Database from 'better-sqlite3';
import { cleanupTaskRuntimeState } from '../src/commands/task-runtime-cleanup.js';
import { getProjectHash } from '../src/parallel/clone.js';

function createGlobalDb(projectPath: string): Database.Database {
  const db = new Database(':memory:');
  const projectId = getProjectHash(projectPath);
  db.exec(`
    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      pid INTEGER,
      project_path TEXT,
      parallel_session_id TEXT,
      current_task_id TEXT
    );
    CREATE TABLE parallel_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      runner_id TEXT,
      lease_expires_at TEXT
    );
    CREATE TABLE workspace_pool_slots (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      runner_id TEXT,
      task_id TEXT,
      task_branch TEXT,
      starting_sha TEXT,
      claimed_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE TABLE workspace_merge_locks (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      runner_id TEXT NOT NULL,
      slot_id INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
  `);

  db.prepare(
    `INSERT INTO runners (id, pid, project_path, parallel_session_id, current_task_id)
     VALUES ('runner-1', NULL, ?, 'session-1', 'task-1')`
  ).run(projectPath);
  db.prepare(
    `INSERT INTO parallel_sessions (id, project_path, status)
     VALUES ('session-1', ?, 'blocked_recovery')`
  ).run(projectPath);
  db.prepare(
    `INSERT INTO workstreams (id, session_id, runner_id, lease_expires_at)
     VALUES ('ws-1', 'session-1', 'runner-1', '2026-03-25T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO workspace_pool_slots (
      id, project_id, status, runner_id, task_id, task_branch, starting_sha, claimed_at, heartbeat_at
    ) VALUES (1, ?, 'coder_active', 'runner-1', 'task-1', 'steroids/task-task-1', 'abc123', 1, 1)`
  ).run(projectId);
  db.prepare(
    `INSERT INTO workspace_merge_locks (id, project_id, runner_id, slot_id, acquired_at, heartbeat_at)
     VALUES (1, ?, 'runner-1', 1, 1, 1)`
  ).run(projectId);

  return db;
}

function createProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      runner_id TEXT,
      status TEXT
    );
  `);
  db.prepare(`INSERT INTO task_invocations (task_id, runner_id, status) VALUES ('task-1', 'runner-1', 'running')`).run();
  return db;
}

function createProjectDbWithCompletedInvocation(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      runner_id TEXT,
      status TEXT
    );
  `);
  db.prepare(`INSERT INTO task_invocations (task_id, runner_id, status) VALUES ('task-1', 'runner-1', 'completed')`).run();
  return db;
}

function createIdleGlobalDb(projectPath: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      pid INTEGER,
      project_path TEXT,
      parallel_session_id TEXT,
      current_task_id TEXT
    );
    CREATE TABLE parallel_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      runner_id TEXT,
      lease_expires_at TEXT
    );
    CREATE TABLE workspace_pool_slots (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      runner_id TEXT,
      task_id TEXT,
      task_branch TEXT,
      starting_sha TEXT,
      claimed_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE TABLE workspace_merge_locks (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      runner_id TEXT NOT NULL,
      slot_id INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO runners (id, pid, project_path, parallel_session_id, current_task_id)
     VALUES ('runner-1', NULL, ?, 'session-1', NULL)`
  ).run(projectPath);
  return db;
}

function createLiveRunnerBetweenTasksDb(projectPath: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      pid INTEGER,
      project_path TEXT,
      parallel_session_id TEXT,
      current_task_id TEXT
    );
    CREATE TABLE parallel_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      runner_id TEXT,
      lease_expires_at TEXT
    );
    CREATE TABLE workspace_pool_slots (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      runner_id TEXT,
      task_id TEXT,
      task_branch TEXT,
      starting_sha TEXT,
      claimed_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE TABLE workspace_merge_locks (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      runner_id TEXT NOT NULL,
      slot_id INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO runners (id, pid, project_path, parallel_session_id, current_task_id)
     VALUES ('runner-1', NULL, ?, 'session-1', NULL)`
  ).run(projectPath);
  db.prepare(
    `INSERT INTO parallel_sessions (id, project_path, status)
     VALUES ('session-1', ?, 'running')`
  ).run(projectPath);
  db.prepare(
    `INSERT INTO workstreams (id, session_id, runner_id, lease_expires_at)
     VALUES ('ws-1', 'session-1', 'runner-1', '2026-03-25T00:00:00Z')`
  ).run();
  return db;
}

describe('cleanupTaskRuntimeState', () => {
  it('releases workstream, slot, and merge lock ownership for a deleted task', () => {
    const projectPath = '/tmp/project-cleanup';
    const globalDb = createGlobalDb(projectPath);
    const projectDb = createProjectDb();

    const summary = cleanupTaskRuntimeState(globalDb, 'task-1', projectPath, undefined, projectDb);

    const runner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('runner-1');
    expect(runner).toBeUndefined();

    const workstream = globalDb.prepare('SELECT runner_id, lease_expires_at FROM workstreams WHERE id = ?').get('ws-1') as any;
    expect(workstream.runner_id).toBeNull();
    expect(workstream.lease_expires_at).toBeNull();

    const session = globalDb.prepare('SELECT status FROM parallel_sessions WHERE id = ?').get('session-1') as any;
    expect(session.status).toBe('running');

    const slot = globalDb.prepare('SELECT status, runner_id, task_id, task_branch, starting_sha FROM workspace_pool_slots WHERE id = 1').get() as any;
    expect(slot.status).toBe('idle');
    expect(slot.runner_id).toBeNull();
    expect(slot.task_id).toBeNull();
    expect(slot.task_branch).toBeNull();
    expect(slot.starting_sha).toBeNull();

    const mergeLock = globalDb.prepare('SELECT * FROM workspace_merge_locks WHERE id = 1').get();
    expect(mergeLock).toBeUndefined();

    expect(summary.runnerIds).toEqual(['runner-1']);
    expect(summary.releasedSlotIds).toEqual([1]);
    expect(summary.unblockedSessionIds).toEqual(['session-1']);
    expect(summary.releasedMergeLocks).toBe(1);

    projectDb.close();
    globalDb.close();
  });

  it('ignores historical completed invocations when the runner no longer owns task runtime state', () => {
    const projectPath = '/tmp/project-cleanup-idle';
    const globalDb = createIdleGlobalDb(projectPath);
    const projectDb = createProjectDbWithCompletedInvocation();

    const summary = cleanupTaskRuntimeState(globalDb, 'task-1', projectPath, undefined, projectDb);

    const runner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('runner-1') as any;
    expect(runner).toBeDefined();
    expect(summary.runnerIds).toEqual([]);
    expect(summary.releasedSlotIds).toEqual([]);
    expect(summary.unblockedSessionIds).toEqual([]);
    expect(summary.releasedMergeLocks).toBe(0);

    projectDb.close();
    globalDb.close();
  });

  it('does not revoke a live runner between tasks just because a stale running invocation points at it', () => {
    const projectPath = '/tmp/project-cleanup-live-runner';
    const globalDb = createLiveRunnerBetweenTasksDb(projectPath);
    const projectDb = createProjectDb();

    const summary = cleanupTaskRuntimeState(globalDb, 'task-1', projectPath, undefined, projectDb);

    const runner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('runner-1') as any;
    const workstream = globalDb.prepare('SELECT runner_id FROM workstreams WHERE id = ?').get('ws-1') as any;
    const session = globalDb.prepare('SELECT status FROM parallel_sessions WHERE id = ?').get('session-1') as any;

    expect(runner).toBeDefined();
    expect(workstream.runner_id).toBe('runner-1');
    expect(session.status).toBe('running');
    expect(summary.runnerIds).toEqual([]);
    expect(summary.releasedSlotIds).toEqual([]);
    expect(summary.unblockedSessionIds).toEqual([]);
    expect(summary.releasedMergeLocks).toBe(0);

    projectDb.close();
    globalDb.close();
  });
});
