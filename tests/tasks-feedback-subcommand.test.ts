import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDefaultFlags, type GlobalFlags } from '../src/cli/flags.js';
import { initDatabase, openDatabase } from '../src/database/connection.js';
import { tasksCommand } from '../src/commands/tasks.js';

describe('tasks feedback subcommand', () => {
  let tmpDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof jest.spyOn>;
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'steroids-tasks-feedback-'));
    process.chdir(tmpDir);
    initDatabase(tmpDir).close();

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a feedback task in Needs User Input with feedback subcommand output', async () => {
    const flags: GlobalFlags = { ...getDefaultFlags(), json: true, noHooks: true };

    await tasksCommand(['feedback', 'Need human decision on Redis adoption'], flags);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(payload.success).toBe(true);
    expect(payload.command).toBe('tasks');
    expect(payload.subcommand).toBe('feedback');
    expect(payload.data.feedback).toBe(true);
    expect(payload.data.task.title).toBe('Need human decision on Redis adoption');

    const { db, close } = openDatabase(tmpDir);
    try {
      const row = db
        .prepare(
          `SELECT t.title, s.name AS section_name
           FROM tasks t
           LEFT JOIN sections s ON s.id = t.section_id
           WHERE t.id = ?`
        )
        .get(payload.data.task.id) as { title: string; section_name: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.title).toBe('Need human decision on Redis adoption');
      expect(row?.section_name).toBe('Needs User Input');
    } finally {
      close();
    }
  });

  it('shows dedicated help text for feedback subcommand', async () => {
    const flags: GlobalFlags = { ...getDefaultFlags(), noHooks: true };

    await tasksCommand(['feedback', '--help'], flags);

    const helpText = (logSpy.mock.calls.map((call: unknown[]) => call[0]).find((line: unknown) =>
      typeof line === 'string' && line.includes('steroids tasks feedback <title>')
    ) ?? '') as string;

    expect(helpText).toContain('steroids tasks feedback <title> - Add a feedback task');
    expect(helpText).toContain('steroids tasks feedback "Pre-existing execSync in queries.ts needs review"');
  });
});
