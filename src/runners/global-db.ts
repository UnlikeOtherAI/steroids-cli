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

const GLOBAL_SCHEMA_VERSION = '1';

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

  // Create schema (IF NOT EXISTS makes this idempotent)
  db.exec(GLOBAL_SCHEMA_SQL);

  // Set version if not set
  const version = db
    .prepare('SELECT value FROM _global_schema WHERE key = ?')
    .get('version') as { value: string } | undefined;

  if (!version) {
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'version',
      GLOBAL_SCHEMA_VERSION
    );
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'created_at',
      new Date().toISOString()
    );
  }

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
