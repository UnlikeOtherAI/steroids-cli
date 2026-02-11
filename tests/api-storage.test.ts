import http from 'node:http';
import { mkdirSync, writeFileSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openGlobalDatabase } from '../dist/runners/global-db.js';
import { createApp } from '../API/src/index.js';

function listen(srv: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      if (!a || typeof a === 'string') return reject(new Error('bad addr'));
      resolve(a.port);
    });
  });
}

function tmpDir(prefix: string): string {
  const d = join('/tmp', `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return realpathSync(d);
}

/** Register a project in the isolated global DB (uses current HOME) */
function registerProject(path: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      "INSERT OR REPLACE INTO projects (path,name,registered_at,last_seen_at,enabled) VALUES (?,?,datetime('now'),datetime('now'),1)",
    ).run(path, 'test');
  } finally { close(); }
}

function populateProject(projectPath: string): void {
  const sd = join(projectPath, '.steroids');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'steroids.db'), 'x'.repeat(500));
  mkdirSync(join(sd, 'invocations'));
  const old = new Date('2020-01-01T00:00:00Z');
  for (const [name, data] of [['old1.log', 'a'.repeat(100)], ['old2.log', 'b'.repeat(200)]] as const) {
    const p = join(sd, 'invocations', name);
    writeFileSync(p, data);
    utimesSync(p, old, old);
  }
  const dateDir = join(sd, 'logs', '2020-01-01');
  mkdirSync(dateDir, { recursive: true });
  const f = join(dateDir, 'run.log');
  writeFileSync(f, 'c'.repeat(150));
  utimesSync(f, old, old);
}

describe('Storage API endpoints', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let projectPath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = tmpDir('steroids-home');
    process.env.HOME = homeDir;
    projectPath = tmpDir('storage-proj');
    registerProject(projectPath);
    populateProject(projectPath);
    const app = createApp();
    server = http.createServer(app);
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  const storageUrl = () => `http://127.0.0.1:${port}/api/projects/storage?path=${encodeURIComponent(projectPath)}`;
  const clearLogs = (body: object) => fetch(`http://127.0.0.1:${port}/api/projects/clear-logs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('GET /api/projects/storage returns correct shape', async () => {
    const resp = await fetch(storageUrl());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.total_bytes).toBeGreaterThan(0);
    expect(body.total_human).toBeDefined();
    expect(body.breakdown.database.bytes).toBe(500);
    expect(body.breakdown.invocations.file_count).toBe(2);
    expect(body.breakdown.logs.file_count).toBe(1);
    expect(body.clearable_bytes).toBe(450);
    expect(body.threshold_warning).toBeNull();
  });

  it('GET /api/projects/storage with missing path returns 400', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/projects/storage`);
    expect(resp.status).toBe(400);
  });

  it('GET /api/projects/storage with invalid path returns 404', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/projects/storage?path=/nonexistent/xyz`);
    expect(resp.status).toBe(404);
  });

  it('GET /api/projects/storage with unregistered path returns 403', async () => {
    const unreg = tmpDir('storage-unreg');
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/projects/storage?path=${encodeURIComponent(unreg)}`);
      expect(resp.status).toBe(403);
    } finally { await rm(unreg, { recursive: true, force: true }); }
  });

  it('GET /api/projects/storage with database-only returns clearable_bytes=0', async () => {
    const dbOnlyProject = tmpDir('storage-dbonly');
    registerProject(dbOnlyProject);
    const sd = join(dbOnlyProject, '.steroids');
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, 'steroids.db'), 'x'.repeat(800));

    try {
      const resp = await fetch(
        `http://127.0.0.1:${port}/api/projects/storage?path=${encodeURIComponent(dbOnlyProject)}`,
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as any;
      expect(body.breakdown.database.bytes).toBe(800);
      expect(body.clearable_bytes).toBe(0);
      expect(body.threshold_warning).toBeNull();
    } finally { await rm(dbOnlyProject, { recursive: true, force: true }); }
  });

  it('POST /api/projects/clear-logs deletes old logs and returns freed bytes', async () => {
    const resp = await clearLogs({ path: projectPath, retention_days: 1 });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.deleted_files).toBeGreaterThanOrEqual(1);
    expect(body.freed_bytes).toBeGreaterThan(0);
    expect(body.freed_human).toBeDefined();
  });

  it('POST /api/projects/clear-logs preserves recent files', async () => {
    const recentLog = join(projectPath, '.steroids', 'invocations', 'recent.log');
    writeFileSync(recentLog, 'r'.repeat(50));
    const resp = await clearLogs({ path: projectPath, retention_days: 1 });
    expect(resp.status).toBe(200);
    expect(existsSync(recentLog)).toBe(true);
  });

  it('POST /api/projects/clear-logs preserves database', async () => {
    await clearLogs({ path: projectPath, retention_days: 1 });
    expect(existsSync(join(projectPath, '.steroids', 'steroids.db'))).toBe(true);
  });

  it('POST /api/projects/clear-logs with invalid retention returns 400', async () => {
    const resp = await clearLogs({ path: projectPath, retention_days: -5 });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as any).ok).toBe(false);
  });

  it('cache invalidation: GET storage returns reduced clearable_bytes after clear-logs', async () => {
    const before = await fetch(storageUrl()).then((r) => r.json()) as any;
    expect(before.clearable_bytes).toBe(450); // 100 + 200 + 150
    await clearLogs({ path: projectPath, retention_days: 1 });
    const after = await fetch(storageUrl()).then((r) => r.json()) as any;
    expect(after.clearable_bytes).toBe(0);
  });
});
