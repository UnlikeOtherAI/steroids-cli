/**
 * Unit tests for core stuck-task detection logic.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { detectStuckTasks, formatSqliteDateTimeUtc } from '../src/health/stuck-task-detector.js';

function setupProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT,
      created_at TEXT NOT NULL,
      started_at_ms INTEGER,
      last_activity_at_ms INTEGER
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

function dt(d: Date): string {
  return formatSqliteDateTimeUtc(d);
}

describe('detectStuckTasks', () => {
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

  it('detects orphaned tasks (stale in_progress, no coder invocations, no active runner executing task)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => true,
    });

    expect(report.orphanedTasks.map((t) => t.taskId)).toEqual(['t1']);
    expect(report.dbInconsistencies).toHaveLength(0);
  });

  it('does not flag orphaned when an active runner is executing the task', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 123, projectPath, 't1', dt(new Date(now.getTime() - 10 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => true,
    });

    expect(report.orphanedTasks).toHaveLength(0);
  });

  it('does not flag orphaned when a running coder invocation exists (even without an active runner)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 700 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_invocations (task_id, role, status, created_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'coder', 'running', dt(new Date(now.getTime() - 1900 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => false,
    });

    expect(report.orphanedTasks).toHaveLength(0);
  });

  it('detects hanging_invocation for coder (stale in_progress with active runner executing task)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'Task 1', 'in_progress', dt(new Date(now.getTime() - 1900 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_invocations (task_id, role, status, created_at) VALUES (?, ?, ?, ?)`)
      .run('t1', 'coder', 'running', dt(new Date(now.getTime() - 1900 * 1000)));

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 123, projectPath, 't1', dt(new Date(now.getTime() - 10 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => true,
    });

    expect(report.hangingInvocations).toHaveLength(1);
    expect(report.hangingInvocations[0]?.failureMode).toBe('hanging_invocation');
    expect(report.hangingInvocations[0]?.phase).toBe('coder');
    expect(report.hangingInvocations[0]?.taskId).toBe('t1');
  });

  it('detects hanging_invocation for reviewer (stale review with active runner executing task)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t2', 'Task 2', 'review', dt(new Date(now.getTime() - 1000 * 1000)));

    projectDb
      .prepare(`INSERT INTO task_invocations (task_id, role, status, created_at) VALUES (?, ?, ?, ?)`)
      .run('t2', 'reviewer', 'running', dt(new Date(now.getTime() - 1000 * 1000)));

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r2', 'running', 222, projectPath, 't2', dt(new Date(now.getTime() - 10 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => true,
    });

    expect(report.hangingInvocations).toHaveLength(1);
    expect(report.hangingInvocations[0]?.phase).toBe('reviewer');
    expect(report.hangingInvocations[0]?.taskId).toBe('t2');
  });

  it('detects db_inconsistency (recently updated in_progress with no coder invocations)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    projectDb
      .prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t3', 'Task 3', 'in_progress', dt(new Date(now.getTime() - 30 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => true,
    });

    expect(report.dbInconsistencies).toHaveLength(1);
    expect(report.dbInconsistencies[0]?.taskId).toBe('t3');
    expect(report.orphanedTasks).toHaveLength(0);
  });

  it('detects zombie_runner (stale heartbeat, pid alive)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 555, projectPath, null, dt(new Date(now.getTime() - 600 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => true,
    });

    expect(report.zombieRunners).toHaveLength(1);
    expect(report.zombieRunners[0]?.runnerId).toBe('r1');
  });

  it('detects dead_runner (pid not alive, even if heartbeat is fresh)', () => {
    const projectPath = '/tmp/project-a';
    const now = new Date('2026-02-10T00:00:00.000Z');

    globalDb
      .prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('r1', 'running', 999, projectPath, null, dt(new Date(now.getTime() - 10 * 1000)));

    const report = detectStuckTasks({
      projectPath,
      projectDb,
      globalDb,
      now,
      isPidAlive: () => false,
    });

    expect(report.deadRunners).toHaveLength(1);
    expect(report.deadRunners[0]?.runnerId).toBe('r1');
    expect(report.zombieRunners).toHaveLength(0);
  });
});
