import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createApp } from '../API/src/index.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Unexpected address'));
      resolve(addr.port);
    });
  });
}

function createTempDir(prefix: string): string {
  // Keep paths out of /var on macOS; API path validation forbids /var.
  const base = '/tmp';
  const dir = join(base, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProjectDb(projectPath: string): void {
  const steroidsDir = join(projectPath, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });
  const dbPath = join(steroidsDir, 'steroids.db');

  const db = new Database(dbPath);
  try {
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
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT,
        created_at TEXT NOT NULL,
        last_activity_at_ms INTEGER
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
        created_at TEXT NOT NULL
      );
    `);

    // t1: orphaned (in_progress, old updated_at, no runner, no invocations)
    db.prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, datetime('now', '-2 hours'))`)
      .run('t1', 'Orphaned task', 'in_progress');

    // t2: hanging (in_progress, old updated_at, active runner will be inserted in global DB)
    db.prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, ?, datetime('now', '-2 hours'))`)
      .run('t2', 'Hanging task', 'in_progress');

    // running invocation for t2
    db.prepare(`INSERT INTO task_invocations (task_id, role, provider, model, status, created_at) VALUES (?, ?, ?, ?, 'running', datetime('now', '-2 hours'))`)
      .run('t2', 'coder', 'claude', 'sonnet');

    // Incidents: one unresolved, one resolved
    db.prepare(
      `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
       VALUES (?, ?, ?, ?, datetime('now'), NULL, NULL, NULL, datetime('now'))`
    ).run('i1', 't1', null, 'orphaned_task');

    db.prepare(
      `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, datetime('now'))`
    ).run('i2', 't2', 'r1', 'hanging_invocation', 'auto_restart', '{"note":"test"}');
  } finally {
    db.close();
  }
}

function setupGlobalDb(homeDir: string, projectPath: string): void {
  const steroidsDir = join(homeDir, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });
  const dbPath = join(steroidsDir, 'steroids.db');

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runners (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        pid INTEGER,
        project_path TEXT,
        current_task_id TEXT,
        started_at TEXT,
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Runner actively working on t2 with a fresh heartbeat.
    db.prepare(
      `INSERT INTO runners (id, status, pid, project_path, current_task_id, started_at, heartbeat_at)
       VALUES (?, 'running', NULL, ?, ?, datetime('now', '-10 minutes'), datetime('now'))`
    ).run('r1', projectPath, 't2');
  } finally {
    db.close();
  }
}

describe('API health + incidents endpoints', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('GET /api/health returns summary and supports incident counts', async () => {
    process.env.NODE_ENV = 'test';
    const homeDir = createTempDir('steroids-home');
    process.env.HOME = homeDir;

    const projectPath = createTempDir('steroids-project');
    setupProjectDb(projectPath);
    setupGlobalDb(homeDir, projectPath);

    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const url = `http://127.0.0.1:${port}/api/health?project=${encodeURIComponent(projectPath)}`;
      const resp = await fetch(url);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as any;

      expect(body.success).toBe(true);
      expect(body.project).toBe(projectPath);
      expect(body.health).toBeDefined();
      expect(body.health.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'orphaned_tasks' }),
          expect.objectContaining({ type: 'hanging_invocations' }),
          expect.objectContaining({ type: 'zombie_runners' }),
          expect.objectContaining({ type: 'dead_runners' }),
        ])
      );
      expect(body.health.activeIncidents).toBe(1);
      expect(body.health.recentIncidents).toBeGreaterThanOrEqual(2);
      // With an orphaned task and a hanging task, status should be at least degraded.
      expect(['degraded', 'unhealthy']).toContain(body.health.status);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/incidents lists incidents and filters by task prefix + unresolved flag', async () => {
    process.env.NODE_ENV = 'test';
    const homeDir = createTempDir('steroids-home');
    process.env.HOME = homeDir;

    const projectPath = createTempDir('steroids-project');
    setupProjectDb(projectPath);
    setupGlobalDb(homeDir, projectPath);

    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const allUrl = `http://127.0.0.1:${port}/api/incidents?project=${encodeURIComponent(projectPath)}&limit=10`;
      const allResp = await fetch(allUrl);
      expect(allResp.status).toBe(200);
      const allBody = (await allResp.json()) as any;
      expect(allBody.success).toBe(true);
      expect(allBody.total).toBe(2);
      expect(allBody.incidents).toHaveLength(2);

      const taskUrl = `http://127.0.0.1:${port}/api/incidents?project=${encodeURIComponent(projectPath)}&task=t1`;
      const taskResp = await fetch(taskUrl);
      const taskBody = (await taskResp.json()) as any;
      expect(taskBody.total).toBe(1);
      expect(taskBody.incidents[0].task_id).toBe('t1');

      const unresolvedUrl = `http://127.0.0.1:${port}/api/incidents?project=${encodeURIComponent(projectPath)}&unresolved=true`;
      const unresolvedResp = await fetch(unresolvedUrl);
      const unresolvedBody = (await unresolvedResp.json()) as any;
      expect(unresolvedBody.total).toBe(1);
      expect(unresolvedBody.incidents[0].resolved_at).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
