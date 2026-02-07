/**
 * SQLite database connection management
 * Uses better-sqlite3 for synchronous operations with WAL mode
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_SQL, INITIAL_SCHEMA_DATA, SCHEMA_VERSION } from './schema.js';

const STEROIDS_DIR = '.steroids';
const DB_NAME = 'steroids.db';

export interface DatabaseConnection {
  db: Database.Database;
  close: () => void;
}

/**
 * Get the path to the steroids database
 */
export function getDbPath(projectPath?: string): string {
  const basePath = projectPath || process.cwd();
  return join(basePath, STEROIDS_DIR, DB_NAME);
}

/**
 * Check if steroids is initialized in the given directory
 */
export function isInitialized(projectPath?: string): boolean {
  return existsSync(getDbPath(projectPath));
}

/**
 * Initialize the database with schema
 */
export function initDatabase(projectPath?: string): DatabaseConnection {
  const dbPath = getDbPath(projectPath);
  const steroidsDir = dirname(dbPath);

  // Create .steroids directory if it doesn't exist
  if (!existsSync(steroidsDir)) {
    mkdirSync(steroidsDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Configure SQLite for optimal performance and safety
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Create schema
  db.exec(SCHEMA_SQL);
  db.exec(INITIAL_SCHEMA_DATA);

  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Open an existing database connection
 */
export function openDatabase(projectPath?: string): DatabaseConnection {
  const dbPath = getDbPath(projectPath);

  if (!existsSync(dbPath)) {
    throw new Error(
      `Steroids not initialized. Run 'steroids init' first.\nExpected database at: ${dbPath}`
    );
  }

  const db = new Database(dbPath);

  // Configure SQLite
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Get schema version from database
 */
export function getSchemaVersion(db: Database.Database): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM _schema WHERE key = ?')
      .get('version') as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if database schema is current
 */
export function isSchemaUpToDate(db: Database.Database): boolean {
  const version = getSchemaVersion(db);
  return version === SCHEMA_VERSION;
}
