import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { initDatabase, openDatabase } from '../src/database/connection.js';
import { resetOrphanedInProgressTasks } from '../API/src/utils/project-reset-runtime.js';

function tmpDir(prefix: string): string {
  const dir = join('/tmp', `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

describe('resetOrphanedInProgressTasks', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let homeDir: string;
  let projectPath: string;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    homeDir = tmpDir('steroids-home-project-reset');
    projectPath = tmpDir('steroids-project-reset');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;
    initDatabase(projectPath).close();
    openDatabase(projectPath).close();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.STEROIDS_HOME;
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('resets orphaned in-progress tasks and closes stale running invocations', () => {
    const { db, close } = openDatabase(projectPath);
    try {
      db.prepare(
        `INSERT INTO tasks (id, title, status, created_at, updated_at)
         VALUES (?, ?, 'in_progress', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
      ).run('task-1', 'Ghost runner task');
      db.prepare(
        `INSERT INTO task_invocations (
           task_id, role, provider, model, prompt, started_at_ms, last_activity_at_ms, status, runner_id, created_at
         ) VALUES (?, 'reviewer', 'mock', 'mock-model', 'prompt', ?, ?, 'running', ?, datetime('now'))`,
      ).run('task-1', Date.now() - 180_000, Date.now() - 180_000, 'runner-missing');
    } finally {
      close();
    }

    const resetCount = resetOrphanedInProgressTasks(projectPath);

    expect(resetCount).toBe(1);

    const { db: verifyDb, close: closeVerifyDb } = openDatabase(projectPath);
    try {
      const task = verifyDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      const invocation = verifyDb.prepare(
        'SELECT status FROM task_invocations WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      ).get('task-1') as { status: string };
      expect(task.status).toBe('pending');
      expect(invocation.status).toBe('failed');
    } finally {
      closeVerifyDb();
    }
  });
});
