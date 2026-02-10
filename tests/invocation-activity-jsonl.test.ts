import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, openDatabase } from '../src/database/connection.js';
import { logInvocation } from '../src/providers/invocation-logger.js';

function parseJsonl(filePath: string): any[] {
  const text = readFileSync(filePath, 'utf-8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

describe('Invocation activity logs (JSONL)', () => {
  let projectPath: string;
  const taskId = 'task-1';

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-proj-'));
    const { db, close } = initDatabase(projectPath);
    try {
      db.prepare(`INSERT INTO tasks (id, title) VALUES (?, ?)`).run(taskId, 'Test task');
    } finally {
      close();
    }
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('creates .steroids/invocations/<id>.log and updates DB on success', async () => {
    await logInvocation(
      'prompt',
      async () => ({
        success: true,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        duration: 12,
        timedOut: false,
      }),
      { role: 'coder', provider: 'codex', model: 'codex', taskId, projectPath }
    );

    const { db, close } = openDatabase(projectPath);
    try {
      const inv = db
        .prepare(
          `SELECT id, started_at_ms, completed_at_ms, status, response, error, success, timed_out
           FROM task_invocations
           WHERE task_id = ?
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(taskId) as any;

      expect(inv).toBeTruthy();
      expect(inv.status).toBe('completed');
      expect(typeof inv.started_at_ms).toBe('number');
      expect(typeof inv.completed_at_ms).toBe('number');
      expect(inv.completed_at_ms).toBeGreaterThanOrEqual(inv.started_at_ms);
      expect(inv.response).toBe('ok');
      expect(inv.error).toBeNull();
      expect(inv.success).toBe(1);
      expect(inv.timed_out).toBe(0);

      const invDir = join(projectPath, '.steroids', 'invocations');
      expect(existsSync(join(invDir, 'README.txt'))).toBe(true);

      const logFile = join(invDir, `${inv.id}.log`);
      expect(existsSync(logFile)).toBe(true);
      const entries = parseJsonl(logFile);
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries[0].type).toBe('start');
      expect(entries[entries.length - 1].type).toBe('complete');
    } finally {
      close();
    }
  });

  it('sets status=failed on unsuccessful invocation', async () => {
    await logInvocation(
      'prompt',
      async () => ({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'bad',
        duration: 5,
        timedOut: false,
      }),
      { role: 'reviewer', provider: 'claude', model: 'sonnet', taskId, projectPath }
    );

    const { db, close } = openDatabase(projectPath);
    try {
      const inv = db
        .prepare(`SELECT status, error, success, timed_out FROM task_invocations WHERE task_id = ? ORDER BY id DESC LIMIT 1`)
        .get(taskId) as any;
      expect(inv.status).toBe('failed');
      expect(inv.error).toBe('bad');
      expect(inv.success).toBe(0);
      expect(inv.timed_out).toBe(0);
    } finally {
      close();
    }
  });

  it('sets status=timeout on timed out invocation', async () => {
    await logInvocation(
      'prompt',
      async () => ({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'timeout',
        duration: 50,
        timedOut: true,
      }),
      { role: 'coder', provider: 'gemini', model: 'gemini', taskId, projectPath }
    );

    const { db, close } = openDatabase(projectPath);
    try {
      const inv = db
        .prepare(`SELECT status, timed_out FROM task_invocations WHERE task_id = ? ORDER BY id DESC LIMIT 1`)
        .get(taskId) as any;
      expect(inv.status).toBe('timeout');
      expect(inv.timed_out).toBe(1);
    } finally {
      close();
    }
  });
});

