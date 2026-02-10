import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { formatSqliteDateTimeUtc } from '../src/health/stuck-task-detector.js';
import { recoverStuckTasks } from '../src/health/stuck-task-recovery.js';

function dt(d: Date): string {
  return formatSqliteDateTimeUtc(d);
}

function setupProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      rejection_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT DEFAULT 'human',
      model TEXT,
      notes TEXT,
      commit_sha TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_locks (
      task_id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE incidents (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      runner_id TEXT,
      failure_mode TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function setupGlobalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pid INTEGER,
      project_path TEXT,
      current_task_id TEXT,
      heartbeat_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('recoverStuckTasks', () => {
  let projectDb: Database.Database;
  let globalDb: Database.Database;

  beforeEach(() => {
    projectDb = setupProjectDb();
    globalDb = setupGlobalDb();
  });

  afterEach(() => {
    projectDb.close();
    globalDb.close();
  });

  it('recovers orphaned_task by resetting to pending, releasing lock, incrementing failure_count, and logging incident', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)`)
      .run('t1', 'runner-x', new Date(now.getTime() + 60 * 60 * 1000).toISOString());

    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => true,
      killPid: async () => true,
      config: {
        health: { autoRecover: true, maxRecoveryAttempts: 3 },
      },
    });

    expect(result.actions.some((a) => a.failureMode === 'orphaned_task')).toBe(true);

    const task = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    expect(task.status).toBe('pending');
    expect(task.failure_count).toBe(1);

    const lock = projectDb.prepare('SELECT * FROM task_locks WHERE task_id = ?').get('t1');
    expect(lock).toBeUndefined();

    const incidents = projectDb.prepare('SELECT failure_mode FROM incidents WHERE task_id = ?').all('t1') as Array<{ failure_mode: string }>;
    expect(incidents.map((i) => i.failure_mode)).toContain('orphaned_task');
  });

  it('escalates (skips) orphaned_task after maxRecoveryAttempts', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, failure_count, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', 2, dt(new Date(now.getTime() - 700 * 1000)));

    await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => true,
      killPid: async () => true,
      config: {
        health: { autoRecover: true, maxRecoveryAttempts: 3 },
      },
    });

    const task = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    expect(task.status).toBe('skipped');
    expect(task.failure_count).toBe(3);
  });

  it('recovers hanging_invocation by killing runner, removing runner row, and resetting task', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 1900 * 1000)));

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 123, projectPath, 't1', dt(new Date(now.getTime() - 10 * 1000)));

    let killed: number | null = null;
    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => true,
      killPid: async (pid) => {
        killed = pid;
        return true;
      },
      config: {
        health: { autoRecover: true, maxRecoveryAttempts: 3 },
      },
    });

    expect(result.actions.some((a) => a.failureMode === 'hanging_invocation')).toBe(true);
    expect(killed).toBe(123);

    const runner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('r1');
    expect(runner).toBeUndefined();

    const task = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    expect(task.status).toBe('pending');
    expect(task.failure_count).toBe(1);
  });

  it('skips auto-recovery when safety limit (maxIncidentsPerHour) is hit', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    projectDb
      .prepare(
        `INSERT INTO incidents (id, task_id, failure_mode, detected_at, resolved_at, resolution)
         VALUES ('i1', 'x', 'orphaned_task', datetime('now'), datetime('now'), 'auto_restart')`
      )
      .run();

    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => true,
      killPid: async () => true,
      config: {
        health: { autoRecover: true, maxIncidentsPerHour: 1 },
      },
    });

    expect(result.skippedDueToSafetyLimit).toBe(true);
    expect(result.actions).toHaveLength(0);

    const task = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    expect(task.status).toBe('in_progress');
    expect(task.failure_count).toBe(0);
  });

  it('recovers zombie_runner by removing runner row, releasing lock, resetting task, incrementing failure_count, and logging incident', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    // Stale runner heartbeat (zombie) with a current task.
    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 555, projectPath, 't1', dt(new Date(now.getTime() - 600 * 1000)));

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)`)
      .run('t1', 'r1', new Date(now.getTime() + 60 * 60 * 1000).toISOString());

    let killedPid: number | null = null;
    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => true,
      killPid: async (pid) => {
        killedPid = pid;
        return true;
      },
      config: {
        health: { autoRecover: true },
      },
    });

    expect(result.actions.some((a) => a.failureMode === 'zombie_runner')).toBe(true);
    expect(killedPid).toBe(555);

    const runner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('r1');
    expect(runner).toBeUndefined();

    const task = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    expect(task.status).toBe('pending');
    expect(task.failure_count).toBe(1);

    const lock = projectDb.prepare('SELECT * FROM task_locks WHERE task_id = ?').get('t1');
    expect(lock).toBeUndefined();

    const incidents = projectDb.prepare('SELECT failure_mode FROM incidents WHERE runner_id = ?').all('r1') as Array<{ failure_mode: string }>;
    expect(incidents.map((i) => i.failure_mode)).toContain('zombie_runner');
  });

  it('recovers dead_runner by removing runner row, releasing lock, resetting task, incrementing failure_count, and logging incident', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 999, projectPath, 't1', dt(new Date(now.getTime() - 10 * 1000)));

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)`)
      .run('t1', 'r1', new Date(now.getTime() + 60 * 60 * 1000).toISOString());

    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => false,
      killPid: async () => true,
      config: {
        health: { autoRecover: true },
      },
    });

    expect(result.actions.some((a) => a.failureMode === 'dead_runner')).toBe(true);

    const runner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('r1');
    expect(runner).toBeUndefined();

    const task = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    expect(task.status).toBe('pending');
    expect(task.failure_count).toBe(1);

    const lock = projectDb.prepare('SELECT * FROM task_locks WHERE task_id = ?').get('t1');
    expect(lock).toBeUndefined();

    const incidents = projectDb.prepare('SELECT failure_mode FROM incidents WHERE runner_id = ?').all('r1') as Array<{ failure_mode: string }>;
    expect(incidents.map((i) => i.failure_mode)).toContain('dead_runner');
  });

  it('returns early (no actions, no DB mutations) when autoRecover is false', async () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    // Include both a stuck task and a zombie runner to ensure nothing is mutated in either DB.
    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)`)
      .run('t1', 'r1', new Date(now.getTime() + 60 * 60 * 1000).toISOString());

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 555, projectPath, 't1', dt(new Date(now.getTime() - 600 * 1000)));

    const beforeTask = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    const beforeLock = projectDb.prepare('SELECT * FROM task_locks WHERE task_id = ?').get('t1');
    const beforeRunner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('r1');
    const beforeIncidents = projectDb.prepare('SELECT COUNT(*) as c FROM incidents').get() as { c: number };

    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      dryRun: false,
      isPidAlive: () => true,
      killPid: async () => true,
      config: {
        health: { autoRecover: false },
      },
    });

    expect(result.actions).toHaveLength(0);

    const afterTask = projectDb.prepare('SELECT status, failure_count FROM tasks WHERE id = ?').get('t1') as { status: string; failure_count: number };
    const afterLock = projectDb.prepare('SELECT * FROM task_locks WHERE task_id = ?').get('t1');
    const afterRunner = globalDb.prepare('SELECT * FROM runners WHERE id = ?').get('r1');
    const afterIncidents = projectDb.prepare('SELECT COUNT(*) as c FROM incidents').get() as { c: number };

    expect(afterTask).toEqual(beforeTask);
    expect(afterLock).toEqual(beforeLock);
    expect(afterRunner).toEqual(beforeRunner);
    expect(afterIncidents.c).toBe(beforeIncidents.c);
  });
});
