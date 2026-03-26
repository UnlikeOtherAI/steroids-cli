import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { createApp } from '../API/src/index.js';
import { initDatabase, openDatabase } from '../dist/database/connection.js';
import { openGlobalDatabase } from '../dist/runners/global-db.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('bad addr'));
        return;
      }
      resolve(address.port);
    });
  });
}

function tmpDir(prefix: string): string {
  const dir = join('/tmp', `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function registerProject(projectPath: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      "INSERT OR REPLACE INTO projects (path, name, registered_at, last_seen_at, enabled) VALUES (?, ?, datetime('now'), datetime('now'), 1)"
    ).run(projectPath, 'test');
  } finally {
    close();
  }
}

function insertTask(db: Database.Database, id: string, title: string, status: string): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).run(id, title, status);
}

describe('Project recovery API', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let projectPath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = tmpDir('steroids-home');
    projectPath = tmpDir('steroids-project');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;
    registerProject(projectPath);
    initDatabase(projectPath).close();
    openDatabase(projectPath).close();
    const app = createApp();
    server = http.createServer(app);
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    delete process.env.STEROIDS_HOME;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  const recoveryUrl = () => `http://127.0.0.1:${port}/api/projects/recovery?path=${encodeURIComponent(projectPath)}`;

  it('returns reset counts and the last active running task with dependent count', async () => {
    const { db, close } = openDatabase(projectPath);
    try {
      insertTask(db, 'blocked-task', 'Blocked task', 'blocked_error');
      insertTask(db, 'failed-task', 'Failed task', 'failed');
      insertTask(db, 'orphaned-task', 'Orphaned task', 'in_progress');
      insertTask(db, 'active-task', 'Active reviewer task', 'review');
      insertTask(db, 'dependent-task', 'Dependent task', 'pending');

      db.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)'
      ).run('dependent-task', 'active-task');
      db.prepare(
        `INSERT INTO task_invocations
          (task_id, role, provider, model, prompt, started_at_ms, last_activity_at_ms, status, success, created_at)
         VALUES (?, 'reviewer', 'mock', 'mock-model', 'prompt', ?, ?, 'running', 0, datetime('now'))`
      ).run('active-task', 1000, 2000);
    } finally {
      close();
    }

    const response = await fetch(recoveryUrl());
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.recovery.can_reset_project).toBe(true);
    expect(body.recovery.reset_reason_counts).toEqual({
      failed: 1,
      disputed: 0,
      blocked_error: 1,
      blocked_conflict: 0,
      orphaned_in_progress: 1,
    });
    expect(body.recovery.last_active_task).toMatchObject({
      id: 'active-task',
      title: 'Active reviewer task',
      status: 'review',
      role: 'reviewer',
      dependent_task_count: 1,
    });
    expect(body.recovery.last_active_task.last_activity_at).toBeDefined();
  });

  it('falls back to the runner current task when there is no invocation history', async () => {
    const { db, close } = openDatabase(projectPath);
    try {
      insertTask(db, 'runner-task', 'Runner fallback task', 'review');
    } finally {
      close();
    }

    const { db: globalDb, close: closeGlobal } = openGlobalDatabase();
    try {
      globalDb.prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, started_at, heartbeat_at)
         VALUES (?, 'running', NULL, ?, ?, datetime('now'), datetime('now'))`
      ).run('runner-1', projectPath, 'runner-task');
    } finally {
      closeGlobal();
    }

    const response = await fetch(recoveryUrl());
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.recovery.last_active_task).toMatchObject({
      id: 'runner-task',
      title: 'Runner fallback task',
      status: 'review',
      role: null,
      dependent_task_count: 0,
    });
  });

  it('ignores stale running invocations with no live owner when calculating last active task', async () => {
    const { db, close } = openDatabase(projectPath);
    try {
      insertTask(db, 'stale-task', 'Stale invocation task', 'review');
      insertTask(db, 'finished-task', 'Finished task', 'completed');
      db.prepare(
        `INSERT INTO task_invocations
          (task_id, role, provider, model, prompt, started_at_ms, last_activity_at_ms, status, success, runner_id, created_at)
         VALUES (?, 'reviewer', 'mock', 'mock-model', 'prompt', ?, ?, 'running', 0, ?, datetime('now'))`,
      ).run('stale-task', 1000, 2000, 'runner-missing');
      db.prepare(
        `INSERT INTO task_invocations
          (task_id, role, provider, model, prompt, started_at_ms, completed_at_ms, status, success, created_at)
         VALUES (?, 'reviewer', 'mock', 'mock-model', 'prompt', ?, ?, 'completed', 1, datetime('now'))`,
      ).run('finished-task', 3000, 4000);
    } finally {
      close();
    }

    const response = await fetch(recoveryUrl());
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.recovery.last_active_task).toMatchObject({
      id: 'finished-task',
      title: 'Finished task',
      status: 'completed',
      role: 'reviewer',
    });
  });
});
