import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

import { createApp } from '../API/src/index.js';

jest.setTimeout(20000);

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
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE task_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed'
      );
    `);
  } finally {
    db.close();
  }
}

function insertInvocation(args: {
  projectPath: string;
  taskId: string;
  startedAtMs: number;
  completedAtMs: number | null;
  status: 'running' | 'completed' | 'failed' | 'timeout';
}): number {
  const dbPath = join(args.projectPath, '.steroids', 'steroids.db');
  const db = new Database(dbPath);
  try {
    db.prepare(`INSERT OR IGNORE INTO tasks (id, title, status, updated_at) VALUES (?, ?, 'in_progress', datetime('now'))`).run(
      args.taskId,
      'Test task'
    );
    const info = db
      .prepare(
        `INSERT INTO task_invocations (task_id, role, provider, model, prompt, started_at_ms, completed_at_ms, status)
         VALUES (?, 'coder', 'codex', 'codex', 'prompt', ?, ?, ?)`
      )
      .run(args.taskId, args.startedAtMs, args.completedAtMs, args.status);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function httpGetJson(url: string): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const status = res.statusCode || 0;
      res.setEncoding('utf8');
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve({ status, body: raw ? JSON.parse(raw) : null, raw });
        } catch (e) {
          reject(new Error(`Failed to parse JSON (status ${status}): ${raw}`));
        }
      });
    });
    req.on('error', reject);
  });
}

describe('Tasks timeline endpoint', () => {
  it('returns a sampled timeline parsed from invocation JSONL logs', async () => {
    process.env.NODE_ENV = 'test';

    const projectPath = createTempDir('steroids-project');
    setupProjectDb(projectPath);
    const taskId = 't-timeline';

    const inv1 = insertInvocation({
      projectPath,
      taskId,
      startedAtMs: 1000,
      completedAtMs: 2000,
      status: 'completed',
    });

    const inv2 = insertInvocation({
      projectPath,
      taskId,
      startedAtMs: 3000,
      completedAtMs: null,
      status: 'running',
    });

    const invDir = join(projectPath, '.steroids', 'invocations');
    mkdirSync(invDir, { recursive: true });

    // Create enough entries to exercise the sampling rule:
    // keep all tools and every 10th entry (0, 10, 20, ...)
    const inv1Log: any[] = [];
    inv1Log.push({ ts: 1001, type: 'start', role: 'coder', provider: 'codex', model: 'codex' }); // index 0
    inv1Log.push({ ts: 1002, type: 'output', msg: 'a' }); // 1
    inv1Log.push({ ts: 1003, type: 'output', msg: 'b' }); // 2
    inv1Log.push({ ts: 1004, type: 'tool', cmd: "rg -n 'x' src/" }); // 3
    for (let i = 4; i < 10; i++) inv1Log.push({ ts: 1000 + i, type: 'output', msg: `o${i}` });
    inv1Log.push({ ts: 1010, type: 'output', msg: 'ten' }); // index 10
    inv1Log.push({ ts: 1011, type: 'tool', cmd: 'cat README.md' }); // 11

    writeFileSync(join(invDir, `${inv1}.log`), inv1Log.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    writeFileSync(
      join(invDir, `${inv2}.log`),
      `${JSON.stringify({ ts: 3001, type: 'start', role: 'coder', provider: 'codex', model: 'codex' })}\n`,
      'utf8'
    );

    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const url = `http://127.0.0.1:${port}/api/tasks/${taskId}/timeline?project=${encodeURIComponent(projectPath)}`;
      const resp = await httpGetJson(url);
      expect(resp.status).toBe(200);
      expect(resp.body.success).toBe(true);
      expect(Array.isArray(resp.body.timeline)).toBe(true);

      const timeline = resp.body.timeline as any[];

      // DB lifecycle events
      expect(timeline.some((e) => e.type === 'invocation.started' && e.invocationId === inv1 && e.ts === 1000)).toBe(true);
      expect(timeline.some((e) => e.type === 'invocation.completed' && e.invocationId === inv1 && e.ts === 2000 && e.success === true)).toBe(true);
      expect(timeline.some((e) => e.type === 'invocation.started' && e.invocationId === inv2 && e.ts === 3000)).toBe(true);
      expect(timeline.some((e) => e.type === 'invocation.completed' && e.invocationId === inv2)).toBe(false);

      // Sampled log entries (all tools, and every 10th entry)
      expect(timeline.some((e) => e.invocationId === inv1 && e.type === 'tool' && e.cmd?.includes('rg -n'))).toBe(true);
      expect(timeline.some((e) => e.invocationId === inv1 && e.type === 'output' && e.msg === 'ten')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

