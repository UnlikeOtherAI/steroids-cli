import http from 'node:http';
import { mkdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createApp } from '../API/src/index.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected address'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function tmpDir(prefix: string): string {
  const dir = join('/tmp', `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function setupTaskDb(projectPath: string): void {
  const steroidsDir = join(projectPath, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });
  const dbPath = join(steroidsDir, 'steroids.db');

  const db = new Database(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE task_feedback (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        feedback TEXT NOT NULL CHECK(length(feedback) <= 8000),
        source TEXT NOT NULL DEFAULT 'user',
        created_by TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.prepare(`INSERT INTO tasks (id, title, status) VALUES ('task-1', 'Task One', 'pending')`).run();
  } finally {
    db.close();
  }
}

describe('Task feedback API routes + reviewer config save endpoint', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let projectPath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = tmpDir('steroids-home-feedback-api');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;

    projectPath = tmpDir('steroids-project-feedback-api');
    setupTaskDb(projectPath);

    server = http.createServer(createApp());
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    delete process.env.STEROIDS_HOME;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('creates, lists, and deletes task feedback', async () => {
    const createResp = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: projectPath,
        feedback: 'Please add edge case tests for empty input.',
      }),
    });

    expect(createResp.status).toBe(201);
    const createdBody = (await createResp.json()) as any;
    expect(createdBody.success).toBe(true);
    expect(createdBody.feedback.feedback).toBe('Please add edge case tests for empty input.');
    expect(createdBody.feedback.source).toBe('user');

    const feedbackId = createdBody.feedback.id as string;

    const listResp = await fetch(
      `http://127.0.0.1:${port}/api/tasks/task-1/feedback?project=${encodeURIComponent(projectPath)}`
    );
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as any;
    expect(listBody.success).toBe(true);
    expect(listBody.feedback).toHaveLength(1);
    expect(listBody.feedback[0].id).toBe(feedbackId);

    const deleteResp = await fetch(
      `http://127.0.0.1:${port}/api/tasks/task-1/feedback/${encodeURIComponent(feedbackId)}?project=${encodeURIComponent(projectPath)}`,
      { method: 'DELETE' }
    );
    expect(deleteResp.status).toBe(200);

    const afterDelete = await fetch(
      `http://127.0.0.1:${port}/api/tasks/task-1/feedback?project=${encodeURIComponent(projectPath)}`
    );
    const afterDeleteBody = (await afterDelete.json()) as any;
    expect(afterDeleteBody.feedback).toHaveLength(0);
  });

  it('returns 400 when creating feedback with empty text', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, feedback: '   ' }),
    });

    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('non-empty');
  });

  it('saves and retrieves reviewer customInstructions using config endpoint', async () => {
    const saveResp = await fetch(`http://127.0.0.1:${port}/api/config/reviewer-custom-instructions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        project: projectPath,
        customInstructions: 'Prioritize backward compatibility and migration safety.',
      }),
    });

    expect(saveResp.status).toBe(200);
    const saveBody = (await saveResp.json()) as any;
    expect(saveBody.success).toBe(true);
    expect(saveBody.data.scope).toBe('project');
    expect(saveBody.data.customInstructions).toBe('Prioritize backward compatibility and migration safety.');

    const getResp = await fetch(
      `http://127.0.0.1:${port}/api/config?scope=project&project=${encodeURIComponent(projectPath)}`
    );
    expect(getResp.status).toBe(200);
    const getBody = (await getResp.json()) as any;

    expect(getBody.success).toBe(true);
    expect(getBody.data.config.ai.reviewer.customInstructions).toBe(
      'Prioritize backward compatibility and migration safety.'
    );
  });

  it('returns 400 for reviewer customInstructions save when project scope is missing project', async () => {
    const saveResp = await fetch(`http://127.0.0.1:${port}/api/config/reviewer-custom-instructions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        customInstructions: 'Instruction text',
      }),
    });

    expect(saveResp.status).toBe(400);
    const body = (await saveResp.json()) as any;
    expect(body.error).toContain('Project path required');
  });
});
