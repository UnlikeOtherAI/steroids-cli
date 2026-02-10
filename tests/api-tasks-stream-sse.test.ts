import http from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
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

function insertRunningInvocation(args: {
  projectPath: string;
  taskId: string;
  startedAtMs: number;
}): number {
  const dbPath = join(args.projectPath, '.steroids', 'steroids.db');
  const db = new Database(dbPath);
  try {
    db.prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, 'in_progress', datetime('now'))`).run(
      args.taskId,
      'Test task'
    );
    const info = db
      .prepare(
        `INSERT INTO task_invocations (task_id, role, provider, model, prompt, started_at_ms, status)
         VALUES (?, 'coder', 'codex', 'codex', 'prompt', ?, 'running')`
      )
      .run(args.taskId, args.startedAtMs);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function readSseEvents(url: string, opts: { expected: number; timeoutMs: number; onEvent?: (e: any) => void }): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    let buffer = '';

    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        buffer = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buffer += c));
        res.on('end', () => reject(new Error(`Expected 200, got ${res.statusCode}: ${buffer}`)));
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');

          const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
          const dataLines = lines.filter((l) => l.startsWith('data:'));
          if (dataLines.length === 0) continue;

          const data = dataLines.map((l) => l.slice('data:'.length).trim()).join('\n');
          try {
            const parsed = JSON.parse(data);
            events.push(parsed);
            opts.onEvent?.(parsed);
            if (events.length >= opts.expected) {
              req.destroy();
              resolve(events);
              return;
            }
          } catch {
            // ignore malformed data blocks
          }
        }
      });

      res.on('end', () => resolve(events));
    });

    req.on('error', reject);
    const t = setTimeout(() => {
      try {
        req.destroy(new Error('timeout'));
      } catch {}
      resolve(events);
    }, opts.timeoutMs);
    req.on('close', () => clearTimeout(t));
  });
}

describe('Tasks SSE stream endpoint', () => {
  it('streams existing JSONL and tails new entries for a running invocation', async () => {
    process.env.NODE_ENV = 'test';

    const projectPath = createTempDir('steroids-project');
    setupProjectDb(projectPath);
    const taskId = 't-stream';
    const invocationId = insertRunningInvocation({ projectPath, taskId, startedAtMs: Date.now() });

    const invDir = join(projectPath, '.steroids', 'invocations');
    mkdirSync(invDir, { recursive: true });
    const logFile = join(invDir, `${invocationId}.log`);
    writeFileSync(logFile, `${JSON.stringify({ ts: 1, type: 'start', role: 'coder', provider: 'codex', model: 'codex' })}\n`, 'utf8');

    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const url = `http://127.0.0.1:${port}/api/tasks/${taskId}/stream?project=${encodeURIComponent(projectPath)}`;

      let sawStart = false;
      const eventsP = readSseEvents(url, {
        expected: 3,
        // When the server uses fs.watchFile (Tail option: useWatchFile=true), the default polling interval
        // can be ~5s, so give this test enough time for the change to be detected.
        timeoutMs: 9000,
        onEvent: (e) => {
          if (e.type === 'start' && !sawStart) {
            sawStart = true;
            // Give the server a moment to switch from "read existing" to tail mode.
            setTimeout(() => {
              appendFileSync(logFile, `${JSON.stringify({ ts: 2, type: 'tool', cmd: 'echo hi' })}\n`, 'utf8');
              appendFileSync(logFile, `${JSON.stringify({ ts: 3, type: 'complete', success: true, duration: 1 })}\n`, 'utf8');
            }, 200);
          }
        },
      });

      const events = await eventsP;
      expect(events.map((e) => e.type)).toEqual(['start', 'tool', 'complete']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('emits an SSE error event and closes when the project database is missing', async () => {
    process.env.NODE_ENV = 'test';

    const projectPath = createTempDir('steroids-project');
    const taskId = 't-missing-db';

    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const url = `http://127.0.0.1:${port}/api/tasks/${taskId}/stream?project=${encodeURIComponent(projectPath)}`;
      const events = await readSseEvents(url, { expected: 1, timeoutMs: 1500 });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].error).toBe('Project database not found');
      expect(events[0].project).toBe(projectPath);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns no_active_invocation when there is no running invocation', async () => {
    process.env.NODE_ENV = 'test';

    const projectPath = createTempDir('steroids-project');
    setupProjectDb(projectPath);
    const taskId = 't-none';

    const dbPath = join(projectPath, '.steroids', 'steroids.db');
    const db = new Database(dbPath);
    try {
      db.prepare(`INSERT INTO tasks (id, title, status, updated_at) VALUES (?, ?, 'pending', datetime('now'))`).run(
        taskId,
        'No invocation'
      );
    } finally {
      db.close();
    }

    const app = createApp();
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const url = `http://127.0.0.1:${port}/api/tasks/${taskId}/stream?project=${encodeURIComponent(projectPath)}`;
      const events = await readSseEvents(url, { expected: 1, timeoutMs: 1500 });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('no_active_invocation');
      expect(events[0].taskId).toBe(taskId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
