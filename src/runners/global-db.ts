/**
 * Global database for runner state
 * Located at ~/.steroids/steroids.db (user home, not project)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STEROIDS_DIR = '.steroids';
const DB_NAME = 'steroids.db';

export interface GlobalDatabaseConnection {
  db: Database.Database;
  close: () => void;
}

/**
 * Schema for global database (runners and locks)
 */
const GLOBAL_SCHEMA_SQL = `
-- Runners table for tracking runner state
CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    pid INTEGER,
    project_path TEXT,
    current_task_id TEXT,
    started_at TEXT,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Runner lock for singleton enforcement
-- Only one row allowed (id = 1)
CREATE TABLE IF NOT EXISTS runner_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema metadata
CREATE TABLE IF NOT EXISTS _global_schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/**
 * Schema upgrade from version 1 to version 2: Add projects table
 */
const GLOBAL_SCHEMA_V2_SQL = `
-- Projects table for tracking registered projects
CREATE TABLE IF NOT EXISTS projects (
    path TEXT PRIMARY KEY,
    name TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
);
`;

/**
 * Schema upgrade from version 2 to version 3: Add stats columns to projects table
 */
const GLOBAL_SCHEMA_V3_SQL = `
-- Add task stats columns (for API/WebUI display without accessing project DBs)
ALTER TABLE projects ADD COLUMN pending_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN in_progress_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN completed_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN stats_updated_at TEXT;
`;

/**
 * Schema upgrade from version 3 to version 4: Add section_id to runners table
 */
const GLOBAL_SCHEMA_V4_SQL = `
-- Add section_id column to runners for section focus feature
ALTER TABLE runners ADD COLUMN section_id TEXT;
`;

const GLOBAL_SCHEMA_VERSION = '4';

/**
 * Get the path to the global steroids directory
 */
export function getGlobalSteroidsDir(): string {
  return join(homedir(), STEROIDS_DIR);
}

/**
 * Get the path to the global database
 */
export function getGlobalDbPath(): string {
  return join(getGlobalSteroidsDir(), DB_NAME);
}

/**
 * Check if global database exists
 */
export function isGlobalDbInitialized(): boolean {
  return existsSync(getGlobalDbPath());
}

/**
 * Initialize and open the global database
 * Creates it if it doesn't exist
 */
export function openGlobalDatabase(): GlobalDatabaseConnection {
  const dbPath = getGlobalDbPath();
  const steroidsDir = getGlobalSteroidsDir();

  // Create ~/.steroids directory if it doesn't exist
  if (!existsSync(steroidsDir)) {
    mkdirSync(steroidsDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Configure SQLite for optimal performance and safety
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Create base schema (IF NOT EXISTS makes this idempotent)
  db.exec(GLOBAL_SCHEMA_SQL);

  // Get current version
  const versionRow = db
    .prepare('SELECT value FROM _global_schema WHERE key = ?')
    .get('version') as { value: string } | undefined;

  const currentVersion = versionRow?.value;

  if (!currentVersion) {
    // Fresh database - apply all schemas and set to latest version
    db.exec(GLOBAL_SCHEMA_V2_SQL);
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'version',
      GLOBAL_SCHEMA_VERSION
    );
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'created_at',
      new Date().toISOString()
    );
  } else if (currentVersion === '1') {
    // Upgrade from version 1 to version 2, 3, and 4
    db.exec(GLOBAL_SCHEMA_V2_SQL);
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '2') {
    // Upgrade from version 2 to version 3 and 4
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '3') {
    // Upgrade from version 3 to version 4
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  }
  // Future upgrades would be handled here with additional conditions

  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Get global schema version
 */
export function getGlobalSchemaVersion(db: Database.Database): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM _global_schema WHERE key = ?')
      .get('version') as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
