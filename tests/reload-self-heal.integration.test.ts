import http from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../API/src/index.js';
import { initDatabase } from '../src/database/connection.js';
import { openGlobalDatabase } from '../src/runners/global-db-connection.js';

const { resetReloadSelfHealStateForTests } = await import('../dist/self-heal/reload-sweep.js');

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unexpected address'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for assertion');
}

function createProjectDb(projectPath: string, taskId: string): void {
  const { db, close } = initDatabase(projectPath);
  try {
    db.prepare(
      `INSERT INTO tasks (id, title, status, updated_at, failure_count)
       VALUES (?, ?, 'in_progress', datetime('now', '-2 hours'), 0)`
    ).run(taskId, `Task ${taskId}`);
  } finally {
    close();
  }
}

function registerProject(projectPath: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO projects (path, name, registered_at, last_seen_at, enabled)
       VALUES (?, NULL, datetime('now'), datetime('now'), 1)`
    ).run(projectPath);
  } finally {
    close();
  }
}

function insertStaleRunner(runnerId: string, projectPath: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at, parallel_session_id)
       VALUES (?, 'idle', ?, ?, NULL, datetime('now', '-1 day'), NULL)`
    ).run(runnerId, 555555, projectPath);
  } finally {
    close();
  }
}

describe('reload self-heal integration', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let homeDir: string;
  let server: http.Server;
  let port: number;
  let createdDirs: string[];

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = createTempDir('steroids-self-heal-home');
    createdDirs = [homeDir];
    process.env.STEROIDS_HOME = homeDir;
    process.env.HOME = homeDir;
    resetReloadSelfHealStateForTests();

    server = http.createServer(createApp());
    port = await listen(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.STEROIDS_HOME;
    resetReloadSelfHealStateForTests();
    createdDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('cleans a stale global runner row through the HTTP trigger path', async () => {
    const staleProjectPath = '/tmp/parallel-project';
    insertStaleRunner('runner-stale', staleProjectPath);

    const response = await fetch(`http://127.0.0.1:${port}/api/self-heal/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'runners_page' }),
    });

    expect(response.status).toBe(202);

    await waitFor(() => {
      const { db, close } = openGlobalDatabase();
      try {
        expect(db.prepare('SELECT * FROM runners WHERE id = ?').get('runner-stale')).toBeUndefined();
      } finally {
        close();
      }
    });
  });

  it('recovers an orphaned task for a project-scoped reload trigger', async () => {
    const projectPath = createTempDir('steroids-project');
    createdDirs.push(projectPath);
    createProjectDb(projectPath, 'task-1');
    registerProject(projectPath);

    const response = await fetch(`http://127.0.0.1:${port}/api/self-heal/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'task_page', projectPath }),
    });

    expect(response.status).toBe(202);

    await waitFor(() => {
      const { db, close } = initDatabase(projectPath);
      try {
        const task = db.prepare(
          'SELECT status, failure_count FROM tasks WHERE id = ?',
        ).get('task-1') as { status: string; failure_count: number };
        expect(task.status).toBe('pending');
        expect(task.failure_count).toBe(1);
      } finally {
        close();
      }
    });
  });

  it('can clean a stale runner and recover a project task in the same scheduled sweep', async () => {
    const projectPath = createTempDir('steroids-project-combined');
    createdDirs.push(projectPath);
    createProjectDb(projectPath, 'task-combined');
    registerProject(projectPath);
    insertStaleRunner('runner-combined', '/tmp/parallel-project');

    const response = await fetch(`http://127.0.0.1:${port}/api/self-heal/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'project_tasks_page', projectPath }),
    });

    expect(response.status).toBe(202);

    await waitFor(() => {
      const { db, close } = openGlobalDatabase();
      try {
        expect(db.prepare('SELECT * FROM runners WHERE id = ?').get('runner-combined')).toBeUndefined();
      } finally {
        close();
      }
    });

    await waitFor(() => {
      const { db, close } = initDatabase(projectPath);
      try {
        const task = db.prepare(
          'SELECT status FROM tasks WHERE id = ?',
        ).get('task-combined') as { status: string };
        expect(task.status).toBe('pending');
      } finally {
        close();
      }
    });
  });

  it('isolates a corrupt project and still repairs healthy projects', async () => {
    const healthyProjectPath = createTempDir('steroids-project-healthy');
    createdDirs.push(healthyProjectPath);
    createProjectDb(healthyProjectPath, 'task-healthy');
    registerProject(healthyProjectPath);

    const corruptProjectPath = createTempDir('steroids-project-corrupt');
    createdDirs.push(corruptProjectPath);
    mkdirSync(join(corruptProjectPath, '.steroids'), { recursive: true });
    writeFileSync(join(corruptProjectPath, '.steroids', 'steroids.db'), 'not-a-sqlite-db');
    registerProject(corruptProjectPath);

    insertStaleRunner('runner-isolated', '/tmp/parallel-project');

    const response = await fetch(`http://127.0.0.1:${port}/api/self-heal/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'runners_page' }),
    });

    expect(response.status).toBe(202);

    await waitFor(() => {
      const { db, close } = initDatabase(healthyProjectPath);
      try {
        const task = db.prepare(
          'SELECT status FROM tasks WHERE id = ?',
        ).get('task-healthy') as { status: string };
        expect(task.status).toBe('pending');
      } finally {
        close();
      }
    });

    await waitFor(() => {
      const { db, close } = openGlobalDatabase();
      try {
        expect(db.prepare('SELECT * FROM runners WHERE id = ?').get('runner-isolated')).toBeUndefined();
      } finally {
        close();
      }
    });
  });
});
