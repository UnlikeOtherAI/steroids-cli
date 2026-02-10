import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { getDefaultFlags, type GlobalFlags } from '../src/cli/flags.js';
import { initDatabase, openDatabase } from '../src/database/connection.js';

describe('steroids health check|incidents (stuck-task health)', () => {
  let tmpDir: string;
  let originalCwd: string;
  let globalDb: Database.Database;

  // Dynamically imported after module mocks are set.
  let healthCommand: (args: string[], flags: GlobalFlags) => Promise<void>;

  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    originalCwd = process.cwd();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'steroids-health-stuck-cli-'));
    process.chdir(tmpDir);

    // Create an initialized project DB in the temp directory.
    initDatabase(tmpDir).close();

    // Create an in-memory global DB for runners.
    globalDb = new Database(':memory:');
    globalDb.exec(`
      CREATE TABLE runners (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        pid INTEGER,
        project_path TEXT,
        current_task_id TEXT,
        started_at TEXT,
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Ensure mocks apply to the dynamic import below.
    jest.resetModules();

    jest.unstable_mockModule('../src/runners/global-db.js', () => ({
      openGlobalDatabase: () => ({ db: globalDb, close: () => {} }),
    }));

    jest.unstable_mockModule('../src/config/loader.js', () => ({
      // Keep tests hermetic: don't read ~/.steroids/config.yaml.
      loadConfig: () => ({}),
    }));

    ({ healthCommand } = await import('../src/commands/health.js'));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    try {
      globalDb.close();
    } catch {
      // ignore
    }
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('health check outputs JSON envelope', async () => {
    const flags: GlobalFlags = { ...getDefaultFlags(), json: true };

    await healthCommand(['check'], flags);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string);
    expect(payload.success).toBe(true);
    expect(payload.command).toBe('health');
    expect(payload.subcommand).toBe('check');
    expect(payload.data.counts.orphanedTasks).toBe(0);
    expect(payload.data.counts.hangingInvocations).toBe(0);
  });

  it('health incidents lists and filters by --task', async () => {
    const { db, close } = openDatabase(tmpDir);
    try {
      db.prepare(`INSERT INTO tasks (id, title, status) VALUES ('t1', 'A', 'pending')`).run();
      db.prepare(`INSERT INTO tasks (id, title, status) VALUES ('t2', 'B', 'pending')`).run();

      db.prepare(
        `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
         VALUES ('i1', 't1', 'r1', 'orphaned_task', datetime('now'), datetime('now'), 'auto_restart', NULL, datetime('now'))`
      ).run();
      db.prepare(
        `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
         VALUES ('i2', 't2', 'r1', 'hanging_invocation', datetime('now'), datetime('now'), 'auto_restart', NULL, datetime('now'))`
      ).run();
    } finally {
      close();
    }

    const flags: GlobalFlags = { ...getDefaultFlags(), json: true };

    await healthCommand(['incidents', '--limit', '10'], flags);
    const first = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string);
    expect(first.success).toBe(true);
    expect(first.subcommand).toBe('incidents');
    expect(first.data.total).toBe(2);

    consoleLogSpy.mockClear();

    await healthCommand(['incidents', '--task', 't1'], flags);
    const filtered = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string);
    expect(filtered.data.total).toBe(1);
    expect(filtered.data.incidents[0].task_id).toBe('t1');
  });

  it('health incidents --clear respects --dry-run', async () => {
    const { db, close } = openDatabase(tmpDir);
    try {
      db.prepare(`INSERT INTO tasks (id, title, status) VALUES ('t9', 'X', 'pending')`).run();
      db.prepare(
        `INSERT INTO incidents (id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at)
         VALUES ('old1', 't9', 'r1', 'orphaned_task', datetime('now', '-8 days'), datetime('now', '-8 days'), 'auto_restart', NULL, datetime('now', '-8 days'))`
      ).run();
    } finally {
      close();
    }

    const flags: GlobalFlags = { ...getDefaultFlags(), json: true, dryRun: true };

    await healthCommand(['incidents', '--clear'], flags);

    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] as string);
    expect(payload.success).toBe(true);
    expect(payload.subcommand).toBe('incidents');
    expect(payload.data.wouldDelete).toBe(1);
    expect(payload.data.deleted).toBe(0);

    // Ensure row still exists.
    const verify = openDatabase(tmpDir);
    try {
      const row = verify.db.prepare(`SELECT COUNT(*) as c FROM incidents WHERE id = 'old1'`).get() as { c: number };
      expect(row.c).toBe(1);
    } finally {
      verify.close();
    }
  });
});
