import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { createApp } from '../API/src/index.js';
import { initDatabase, openDatabase } from '../dist/database/connection.js';

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

function insertTask(db: Database.Database, id: string, title: string, status: string): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(id, title, status);
}

function insertRunningInvocation(
  db: Database.Database,
  taskId: string,
  runnerId: string,
  role: 'coder' | 'reviewer' = 'coder',
): void {
  db.prepare(
    `INSERT INTO task_invocations (
       task_id, role, provider, model, prompt, started_at_ms, last_activity_at_ms, status, runner_id, created_at
     ) VALUES (?, ?, 'mock', 'mock-model', 'prompt', ?, ?, 'running', ?, datetime('now'))`,
  ).run(taskId, role, Date.now() - 180_000, Date.now() - 180_000, runnerId);
}

describe('task runtime liveness API', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let homeDir: string;
  let projectPath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = tmpDir('steroids-home-runtime');
    projectPath = tmpDir('steroids-project-runtime');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;
    initDatabase(projectPath).close();
    openDatabase(projectPath).close();
    server = http.createServer(createApp());
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.STEROIDS_HOME;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('marks dead-owner running invocations as not live in task details', async () => {
    const { db, close } = openDatabase(projectPath);
    try {
      insertTask(db, 'task-1', 'Ghost invocation task', 'review');
      insertRunningInvocation(db, 'task-1', 'runner-missing', 'reviewer');
    } finally {
      close();
    }

    const response = await fetch(
      `http://127.0.0.1:${port}/api/tasks/task-1?project=${encodeURIComponent(projectPath)}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.task.invocations).toHaveLength(1);
    expect(body.task.invocations[0].status).toBe('running');
    expect(body.task.invocations[0].is_live).toBe(false);
  });

  it('ignores dead-owner running invocations for SSE live-stream lookup', async () => {
    const { db, close } = openDatabase(projectPath);
    try {
      insertTask(db, 'task-2', 'Ghost stream task', 'in_progress');
      insertRunningInvocation(db, 'task-2', 'runner-missing', 'coder');
    } finally {
      close();
    }

    const response = await fetch(
      `http://127.0.0.1:${port}/api/tasks/task-2/stream?project=${encodeURIComponent(projectPath)}`,
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"no_active_invocation"');
  });

  it('closes stale running invocations when restarting a task', async () => {
    const { db, close } = openDatabase(projectPath);
    try {
      insertTask(db, 'task-3', 'Restart task', 'blocked_error');
      insertRunningInvocation(db, 'task-3', 'runner-missing', 'reviewer');
    } finally {
      close();
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/task-3/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });

    expect(response.status).toBe(200);

    const { db: verifyDb, close: closeDb } = openDatabase(projectPath);
    try {
      const task = verifyDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-3') as { status: string };
      const invocation = verifyDb.prepare(
        'SELECT status FROM task_invocations WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      ).get('task-3') as { status: string };
      expect(task.status).toBe('pending');
      expect(invocation.status).toBe('failed');
    } finally {
      closeDb();
    }
  });
});
