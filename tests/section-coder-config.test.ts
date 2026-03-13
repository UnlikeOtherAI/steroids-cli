import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { initDatabase } from '../src/database/connection.js';
import { createSection, createTask } from '../src/database/queries.js';
import { readBundledManifest } from '../src/migrations/manifest.js';
import { applyMigration, readMigrationFile } from '../src/migrations/runner.js';
import { BaseRunner } from '../src/orchestrator/base-runner.js';
import { invokeCoder, resolveEffectiveCoderConfig } from '../src/orchestrator/coder.js';

describe('section coder configuration', () => {
  let projectPath: string;
  let db: Database.Database;
  let closeDb: (() => void) | null;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-section-coder-'));
    closeDb = null;
    mkdirSync(join(projectPath, '.steroids'), { recursive: true });

    writeFileSync(
      join(projectPath, 'package.json'),
      JSON.stringify({ name: 'tmp-project', version: '1.0.0' }),
      'utf-8'
    );
    writeFileSync(
      join(projectPath, 'AGENTS.md'),
      '# test instructions\n',
      'utf-8'
    );
    writeFileSync(
      join(projectPath, '.gitignore'),
      'node_modules\n',
      'utf-8'
    );
    writeFileSync(
      join(projectPath, '.steroids', 'config.yaml'),
      [
        'ai:',
        '  coder:',
        '    provider: claude',
        '    model: claude-sonnet-4-6',
      ].join('\n'),
      'utf-8'
    );

    const connection = initDatabase(projectPath);
    db = connection.db;
    closeDb = connection.close;

    const section = createSection(db, 'Section A');
    db.prepare(
      'UPDATE sections SET coder_provider = ?, coder_model = ? WHERE id = ?'
    ).run('codex', 'gpt-5-codex', section.id);
    createTask(db, 'Implement override', { sectionId: section.id });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    closeDb?.();
    if (existsSync(projectPath)) {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it('resolves section provider and model before falling back to project config', () => {
    const task = db.prepare('SELECT * FROM tasks LIMIT 1').get() as { section_id: string };
    const coderConfig = resolveEffectiveCoderConfig(task, projectPath);

    expect(coderConfig).toEqual(
      expect.objectContaining({
        provider: 'codex',
        model: 'gpt-5-codex',
      })
    );
  });

  it('invokes the coder with the section-specific provider and model', async () => {
    const task = db.prepare('SELECT * FROM tasks LIMIT 1').get() as any;

    const invokeProviderSpy = jest
      .spyOn(BaseRunner.prototype as any, 'invokeProvider')
      .mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        duration: 1,
        timedOut: false,
      });

    const result = await invokeCoder(task, projectPath, 'start');

    expect(result.success).toBe(true);
    expect(invokeProviderSpy).toHaveBeenCalledWith(
      expect.any(String),
      'coder',
      'codex',
      'gpt-5-codex',
      900000,
      task.id,
      projectPath,
      undefined,
      undefined
    );
  });
});

describe('section coder migration', () => {
  it('adds coder and PR metadata columns to legacy sections tables', () => {
    const db = new Database(':memory:');

    try {
      db.exec(`
        CREATE TABLE _schema (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE _migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE sections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          position INTEGER NOT NULL,
          priority INTEGER DEFAULT 50,
          skipped INTEGER DEFAULT 0,
          branch TEXT,
          auto_pr INTEGER NOT NULL DEFAULT 0,
          pr_number INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const manifest = readBundledManifest();
      const migration = manifest.migrations.find((entry) => entry.id === 26);
      if (!migration) {
        throw new Error('Expected migration 026 to exist');
      }

      applyMigration(db, migration, readMigrationFile(migration));

      const columns = db.prepare(`PRAGMA table_info(sections)`).all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const columnByName = new Map(columns.map((column) => [column.name, column]));

      expect(columnByName.has('coder_provider')).toBe(true);
      expect(columnByName.has('coder_model')).toBe(true);
      expect(columnByName.has('pr_labels')).toBe(true);
      expect(columnByName.get('pr_draft')).toEqual(
        expect.objectContaining({
          notnull: 1,
          dflt_value: '0',
        })
      );
    } finally {
      db.close();
    }
  });
});
