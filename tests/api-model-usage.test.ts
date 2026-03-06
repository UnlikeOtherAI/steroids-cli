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
      CREATE TABLE task_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        token_usage_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } finally {
    db.close();
  }
}

function addInvocation(
  projectPath: string,
  provider: string,
  model: string,
  usage: Record<string, unknown> | null,
  createdAtExpr = "datetime('now')"
): void {
  const db = new Database(join(projectPath, '.steroids', 'steroids.db'));
  try {
    db.prepare(
      `INSERT INTO task_invocations (provider, model, token_usage_json, created_at)
       VALUES (?, ?, ?, ${createdAtExpr})`
    ).run(provider, model, usage ? JSON.stringify(usage) : null);
  } finally {
    db.close();
  }
}

function setupGlobalDb(projects: Array<{ path: string; name: string }>): void {
  const { db, close } = openGlobalDatabase();
  try {
    for (const project of projects) {
      db.prepare('INSERT INTO projects (path, name, enabled) VALUES (?, ?, 1)').run(project.path, project.name);
    }
  } finally {
    close();
  }
}

describe('API model-usage endpoint', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let server: http.Server;
  let port: number;
  let projectOnePath: string;
  let projectTwoPath: string;
  let homeDir: string;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = createTempDir('steroids-home-model-usage');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;

    projectOnePath = createTempDir('steroids-project-one');
    projectTwoPath = createTempDir('steroids-project-two');
    setupProjectDb(projectOnePath);
    setupProjectDb(projectTwoPath);

    setupGlobalDb([
      { path: projectOnePath, name: 'Project One' },
      { path: projectTwoPath, name: 'Project Two' },
    ]);

    addInvocation(projectOnePath, 'claude', 'claude-3-7-sonnet', {
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
      totalCostUsd: 0.2,
    });
    addInvocation(projectOnePath, 'codex', 'gpt-5-codex', {
      inputTokens: 60,
      outputTokens: 30,
      cachedInputTokens: 20,
      totalCostUsd: 0.1,
    });
    addInvocation(projectOnePath, 'claude', 'claude-3-7-sonnet', null);
    addInvocation(projectOnePath, 'claude', 'claude-3-7-sonnet', { bad: 'payload' });
    addInvocation(projectTwoPath, 'claude', 'claude-3-7-sonnet', {
      inputTokens: 50,
      outputTokens: 20,
      totalCostUsd: 0.05,
    });
    addInvocation(projectTwoPath, 'codex', 'gpt-5-codex', {
      inputTokens: 30,
      outputTokens: 10,
      cachedInputTokens: 5,
      totalCostUsd: 0.03,
    });
    addInvocation(projectTwoPath, 'codex', 'gpt-5-codex', {
      inputTokens: 999,
      outputTokens: 1,
      totalCostUsd: 9.99,
    }, "datetime('now', '-30 hours')");

    const app = createApp();
    server = http.createServer(app);
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.STEROIDS_HOME;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(projectOnePath, { recursive: true, force: true });
    await rm(projectTwoPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('aggregates usage across registered projects by default', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/model-usage`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;

    expect(body.success).toBe(true);
    expect(body.hours).toBe(24);
    expect(body.stats.invocations).toBe(4);
    expect(body.stats.inputTokens).toBe(240);
    expect(body.stats.outputTokens).toBe(100);
    expect(body.stats.totalTokens).toBe(340);
    expect(body.stats.cachedInputTokens).toBe(35);
    expect(body.stats.totalCostUsd).toBeCloseTo(0.38, 8);

    expect(body.by_model).toHaveLength(2);
    expect(body.by_model[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      invocations: 2,
      totalTokens: 210,
    });
    expect(body.by_model[1]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-codex',
      invocations: 2,
      totalTokens: 130,
    });

    expect(body.by_project).toHaveLength(2);
    expect(body.by_project[0]).toMatchObject({
      project_path: projectOnePath,
      project_name: 'Project One',
      invocations: 2,
      totalTokens: 230,
    });
    expect(body.by_project[1]).toMatchObject({
      project_path: projectTwoPath,
      project_name: 'Project Two',
      invocations: 2,
      totalTokens: 110,
    });
  });

  it('supports single-project aggregation via project query parameter', async () => {
    const url = `http://127.0.0.1:${port}/api/model-usage?project=${encodeURIComponent(projectTwoPath)}`;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;

    expect(body.success).toBe(true);
    expect(body.by_project).toHaveLength(1);
    expect(body.by_project[0]).toMatchObject({
      project_path: projectTwoPath,
      project_name: null,
      invocations: 2,
      inputTokens: 80,
      outputTokens: 30,
      totalTokens: 110,
    });
    expect(body.by_model).toHaveLength(2);
  });

  it('filters by hours lookback window', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/model-usage?hours=1`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.success).toBe(true);

    // Excludes the old +1000-token invocation from project two.
    expect(body.stats.invocations).toBe(4);
    expect(body.stats.totalTokens).toBe(340);
    expect(body.stats.totalCostUsd).toBeCloseTo(0.38, 8);
  });

  it('returns 400 for invalid hours values', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/model-usage?hours=0`);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid hours parameter');
  });
});
