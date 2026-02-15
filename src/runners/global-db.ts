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

/**
 * Schema upgrade from version 4 to version 5: Add activity_log table
 */
const GLOBAL_SCHEMA_V5_SQL = `
-- Activity log for tracking task completions across all projects
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
`;

/**
 * Schema upgrade from version 5 to version 6: Add commit_message to activity_log
 */
const GLOBAL_SCHEMA_V6_SQL = `
-- Add commit_message column to activity_log for storing coder's final message
ALTER TABLE activity_log ADD COLUMN commit_message TEXT;
`;

/**
 * Schema upgrade from version 6 to version 7: Add commit_sha to activity_log
 */
const GLOBAL_SCHEMA_V7_SQL = `
-- Add commit_sha column to activity_log for GitHub links
ALTER TABLE activity_log ADD COLUMN commit_sha TEXT;
`;

/**
 * Schema upgrade from version 7 to version 8: Add parallel session tracking
 */
const GLOBAL_SCHEMA_V8_SQL = `
-- Parallel run sessions for independent workstreams
CREATE TABLE IF NOT EXISTS parallel_sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'merging', 'completed', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

-- Workstreams within a parallel session
CREATE TABLE IF NOT EXISTS workstreams (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES parallel_sessions(id),
    branch_name TEXT NOT NULL,
    section_ids TEXT NOT NULL,
    clone_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    runner_id TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Associate runners with a parallel session
ALTER TABLE runners ADD COLUMN parallel_session_id TEXT;
`;

const GLOBAL_SCHEMA_VERSION = '8';

/**
 * Get the path to the global steroids directory.
 * Respects STEROIDS_HOME env var for test isolation (Jest's ESM VM context
 * doesn't propagate process.env.HOME changes to CJS os.homedir()).
 */
export function getGlobalSteroidsDir(): string {
  const home = process.env.STEROIDS_HOME || homedir();
  return join(home, STEROIDS_DIR);
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
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'version',
      GLOBAL_SCHEMA_VERSION
    );
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'created_at',
      new Date().toISOString()
    );
  } else if (currentVersion === '1') {
    // Upgrade from version 1 to latest
    db.exec(GLOBAL_SCHEMA_V2_SQL);
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '2') {
    // Upgrade from version 2 to latest
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '3') {
    // Upgrade from version 3 to latest
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '4') {
    // Upgrade from version 4 to latest
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '5') {
    // Upgrade from version 5 to latest
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '6') {
    // Upgrade from version 6 to version 7
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '7') {
    // Upgrade from version 7 to version 8
    db.exec(GLOBAL_SCHEMA_V8_SQL);
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
