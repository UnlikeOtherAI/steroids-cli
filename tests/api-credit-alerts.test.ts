import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createApp } from '../API/src/index.js';
import { openGlobalDatabase } from '../dist/runners/global-db.js';

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
    // Two unresolved credit_exhaustion incidents
    db.prepare(
      `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
       VALUES (?, ?, ?, 'credit_exhaustion', datetime('now'), NULL, NULL, ?, datetime('now'))`,
    ).run('ce-1', 't1', 'r1', JSON.stringify({ provider: 'claude', model: 'opus', role: 'coder', message: 'Insufficient credits' }));

    db.prepare(
      `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
       VALUES (?, ?, ?, 'credit_exhaustion', datetime('now', '-1 minute'), NULL, NULL, ?, datetime('now', '-1 minute'))`,
    ).run('ce-2', 't2', 'r2', JSON.stringify({ provider: 'codex', model: 'gpt4', role: 'reviewer', message: 'Rate limited' }));

    // One resolved credit_exhaustion (should NOT appear)
    db.prepare(
      `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
       VALUES (?, ?, ?, 'credit_exhaustion', datetime('now', '-2 minutes'), datetime('now'), 'dismissed', ?, datetime('now', '-2 minutes'))`,
    ).run('ce-3', 't3', null, '{}');

    // One non-credit incident (should NOT appear in credit-alerts)
    db.prepare(
      `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
       VALUES (?, ?, ?, 'orphaned_task', datetime('now'), NULL, NULL, NULL, datetime('now'))`,
    ).run('other-1', 't4', null);
  } finally {
    db.close();
  }
}

/** Set up global DB using the real openGlobalDatabase so schema matches exactly */
function setupGlobalDb(projectPath: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('INSERT INTO projects (path, name, enabled) VALUES (?, ?, 1)').run(projectPath, 'test-project');
  } finally {
    close();
  }
}

describe('API credit-alerts endpoints', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let server: http.Server;
  let port: number;
  let projectPath: string;
  let homeDir: string;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = createTempDir('steroids-home');
    process.env.HOME = homeDir;
    projectPath = createTempDir('steroids-project');
    setupProjectDb(projectPath);
    setupGlobalDb(projectPath);
    const app = createApp();
    server = http.createServer(app);
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  // --- GET /api/credit-alerts ---

  it('lists unresolved credit_exhaustion alerts filtered by project', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts?project=${encodeURIComponent(projectPath)}`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.alerts).toHaveLength(2);
    // Sorted by createdAt descending — ce-1 is newer
    expect(body.alerts[0].id).toBe('ce-1');
    expect(body.alerts[1].id).toBe('ce-2');
  });

  it('returns alerts sorted by createdAt descending', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts?project=${encodeURIComponent(projectPath)}`;
    const body = (await (await fetch(url)).json()) as any;
    expect(body.alerts[0].createdAt >= body.alerts[1].createdAt).toBe(true);
  });

  it('parses details JSON into provider/model/role/message', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts?project=${encodeURIComponent(projectPath)}`;
    const body = (await (await fetch(url)).json()) as any;
    const first = body.alerts[0];
    expect(first.provider).toBe('claude');
    expect(first.model).toBe('opus');
    expect(first.role).toBe('coder');
    expect(first.message).toBe('Insufficient credits');
    expect(first.runnerId).toBe('r1');
  });

  it('accepts omitted project filter (lists across all registered projects)', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    // Should still find alerts from the registered project
    expect(body.alerts).toHaveLength(2);
  });

  it('returns empty alerts for nonexistent project path', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts?project=/nonexistent/path`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.alerts).toEqual([]);
  });

  // --- POST /api/credit-alerts/:id/dismiss ---

  it('dismisses a credit alert with default resolution', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts/ce-1/dismiss`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()) as any).toEqual({ ok: true });

    // Verify it's no longer in the list
    const listBody = (await (await fetch(`http://127.0.0.1:${port}/api/credit-alerts?project=${encodeURIComponent(projectPath)}`)).json()) as any;
    expect(listBody.alerts).toHaveLength(1);
    expect(listBody.alerts[0].id).toBe('ce-2');
  });

  it('dismisses with custom resolution value', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts/ce-1/dismiss`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, resolution: 'user_acknowledged' }),
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()) as any).toEqual({ ok: true });

    // Verify resolution was stored
    const dbPath = join(projectPath, '.steroids', 'steroids.db');
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT resolution FROM incidents WHERE id = ?').get('ce-1') as any;
      expect(row.resolution).toBe('user_acknowledged');
    } finally {
      db.close();
    }
  });

  it('dismiss returns 400 if project is missing from body', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/ce-1/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it('dismiss returns 404 for nonexistent incident id', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/nonexistent/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(404);
  });

  it('dismiss returns 404 for non-credit incident', async () => {
    // other-1 is an orphaned_task incident — dismiss should not touch it
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/other-1/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(404);
  });

  it('dismiss returns 404 for nonexistent project database', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/ce-1/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '/nonexistent/path' }),
    });
    expect(resp.status).toBe(404);
  });

  // --- POST /api/credit-alerts/:id/retry ---

  it('retries a credit alert (resolves with retry)', async () => {
    const url = `http://127.0.0.1:${port}/api/credit-alerts/ce-2/retry`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()) as any).toEqual({ ok: true });

    // Verify resolution is 'retry'
    const dbPath = join(projectPath, '.steroids', 'steroids.db');
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT resolution, resolved_at FROM incidents WHERE id = ?').get('ce-2') as any;
      expect(row.resolution).toBe('retry');
      expect(row.resolved_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('retry accepts empty body (besides project)', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/ce-1/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()) as any).toEqual({ ok: true });
  });

  it('retry returns 400 if project is missing', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/ce-1/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it('retry returns 404 for nonexistent incident', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/nonexistent/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(404);
  });

  it('retry returns 404 for non-credit incident', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/other-1/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath }),
    });
    expect(resp.status).toBe(404);
  });

  it('retry returns 404 for DB-not-found', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/credit-alerts/ce-1/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '/nonexistent/path' }),
    });
    expect(resp.status).toBe(404);
  });
});
