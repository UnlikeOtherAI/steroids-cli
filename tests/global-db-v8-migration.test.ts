import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { getGlobalSchemaVersion, openGlobalDatabase } from '../src/runners/global-db.js';

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

type LegacyGlobalSchemaVersion = 6 | 7;

function createTempHome(): string {
  return mkdtempSync(join('/tmp', 'steroids-globaldb-v8-'));
}

function removePath(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

function createLegacyGlobalDb(homeDir: string, version: LegacyGlobalSchemaVersion): string {
  const dbPath = join(homeDir, '.steroids', 'steroids.db');
  mkdirSync(join(homeDir, '.steroids'), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE runners (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        pid INTEGER,
        project_path TEXT,
        current_task_id TEXT,
        started_at TEXT,
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE runner_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        runner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE _global_schema (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    if (version >= 2) {
      db.exec(`
        CREATE TABLE projects (
          path TEXT PRIMARY KEY,
          name TEXT,
          registered_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          enabled INTEGER NOT NULL DEFAULT 1
        );
      `);
    }

    if (version >= 3) {
      db.exec(`
        ALTER TABLE projects ADD COLUMN pending_count INTEGER DEFAULT 0;
        ALTER TABLE projects ADD COLUMN in_progress_count INTEGER DEFAULT 0;
        ALTER TABLE projects ADD COLUMN review_count INTEGER DEFAULT 0;
        ALTER TABLE projects ADD COLUMN completed_count INTEGER DEFAULT 0;
        ALTER TABLE projects ADD COLUMN stats_updated_at TEXT;
      `);
    }

    if (version >= 4) {
      db.exec(`ALTER TABLE runners ADD COLUMN section_id TEXT;`);
    }

    if (version >= 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_title TEXT NOT NULL,
          section_name TEXT,
          final_status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_activity_log_project ON activity_log(project_path);
      `);
    }

    if (version >= 6) {
      db.exec(`ALTER TABLE activity_log ADD COLUMN commit_message TEXT;`);
    }

    if (version >= 7) {
      db.exec(`ALTER TABLE activity_log ADD COLUMN commit_sha TEXT;`);
    }

    db.prepare(`INSERT INTO _global_schema (key, value) VALUES ('version', ?)`).run(String(version));
    db.prepare(`INSERT INTO _global_schema (key, value) VALUES ('created_at', ?)`).run(new Date().toISOString());
    return dbPath;
  } finally {
    db.close();
  }
}

function getColumns(db: Database.Database, tableName: string): TableColumn[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumn[];
}

function getColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): TableColumn {
  const column = getColumns(db, tableName).find((c) => c.name === columnName);
  if (!column) {
    throw new Error(`Expected column ${columnName} in ${tableName}`);
  }
  return column;
}

describe('global db schema v8 migration', () => {
  const originalHome = process.env.HOME;
  const originalSteroidsHome = process.env.STEROIDS_HOME;
  let homeDir = '';

  beforeEach(() => {
    homeDir = createTempHome();
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalSteroidsHome === undefined) {
      delete process.env.STEROIDS_HOME;
    } else {
      process.env.STEROIDS_HOME = originalSteroidsHome;
    }

    if (homeDir) {
      removePath(homeDir);
    }
  });

  it('creates parallel_sessions with required columns and CHECK constraint', () => {
    createLegacyGlobalDb(homeDir, 7);
    const { db, close } = openGlobalDatabase();

    try {
      const columns = getColumns(db, 'parallel_sessions');
      expect(columns.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'id',
          'project_path',
          'status',
          'created_at',
          'completed_at',
        ]),
      );

      expect(getColumn(db, 'parallel_sessions', 'id').type).toBe('TEXT');
      expect(getColumn(db, 'parallel_sessions', 'project_path').notnull).toBe(1);
      expect(getColumn(db, 'parallel_sessions', 'status').notnull).toBe(1);
      expect(getColumn(db, 'parallel_sessions', 'created_at').notnull).toBe(1);
      expect(getColumn(db, 'parallel_sessions', 'completed_at').notnull).toBe(0);
      expect(
        getColumn(db, 'parallel_sessions', 'created_at').dflt_value?.toLowerCase().includes('datetime'),
      ).toBe(true);

      const ddl = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='parallel_sessions'`)
        .get() as { sql: string } | undefined;
      expect(ddl?.sql).toContain("'blocked_validation'");
    } finally {
      close();
    }
  });

  it('creates workstreams with a foreign key on session_id', () => {
    createLegacyGlobalDb(homeDir, 7);
    const { db, close } = openGlobalDatabase();

    try {
      const columns = getColumns(db, 'workstreams');
      expect(columns.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'id',
          'session_id',
          'branch_name',
          'section_ids',
          'status',
        ]),
      );

      const foreignKeys = db
        .prepare("PRAGMA foreign_key_list('workstreams')")
        .all() as Array<{ table: string; from: string; to: string }>;
      expect(
        foreignKeys,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'parallel_sessions',
            from: 'session_id',
            to: 'id',
          }),
        ]),
      );
    } finally {
      close();
    }
  });

  it('adds parallel_session_id to runners table', () => {
    createLegacyGlobalDb(homeDir, 6);
    const { db, close } = openGlobalDatabase();

    try {
      const columns = getColumns(db, 'runners');
      const runnerColumn = columns.some((c) => c.name === 'parallel_session_id');
      expect(runnerColumn).toBe(true);
    } finally {
      close();
    }
  });

  it('rejects invalid status values via CHECK constraints', () => {
    createLegacyGlobalDb(homeDir, 7);
    const { db, close } = openGlobalDatabase();

    try {
      db.prepare(`INSERT INTO parallel_sessions (id, project_path, status) VALUES (?, ?, ?)`)
        .run('ps-1', '/tmp/demo', 'running');
      expect(() => {
        db.prepare(`INSERT INTO parallel_sessions (id, project_path, status) VALUES (?, ?, ?)`)
          .run('ps-2', '/tmp/demo', 'bad-status');
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO workstreams (id, session_id, branch_name, section_ids, status) VALUES (?, ?, ?, ?, ?)`,
        ).run('ws-1', 'ps-1', 'feature', '["section-a"]', 'bogus');
      }).toThrow();
    } finally {
      close();
    }
  });

  it('migrates a v7 database to v8', () => {
    createLegacyGlobalDb(homeDir, 7);
    const { db, close } = openGlobalDatabase();

    try {
      expect(getGlobalSchemaVersion(db)).toBe('15');
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM parallel_sessions').get() as {
        count: number;
      };
      const workstreamCount = db.prepare('SELECT COUNT(*) as count FROM workstreams').get() as {
        count: number;
      };
      expect(sessionCount.count).toBe(0);
      expect(workstreamCount.count).toBe(0);
    } finally {
      close();
    }
  });

  it('migrates v6 directly to v8 by applying V8 migration', () => {
    createLegacyGlobalDb(homeDir, 6);
    const { db, close } = openGlobalDatabase();

    try {
      expect(getGlobalSchemaVersion(db)).toBe('15');
      const parallelSessionsColumns = getColumns(db, 'parallel_sessions');
      expect(parallelSessionsColumns.length).toBeGreaterThan(0);
      const runnersColumns = getColumns(db, 'runners');
      expect(runnersColumns.some((c) => c.name === 'parallel_session_id')).toBe(true);
      expect(
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='workstreams'`)
          .get(),
      ).toBeDefined();
    } finally {
      close();
    }
  });
});
