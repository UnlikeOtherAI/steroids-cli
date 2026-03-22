/**
 * Global database connection management and initialization
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  GLOBAL_SCHEMA_SQL,
  GLOBAL_SCHEMA_V2_SQL,
  GLOBAL_SCHEMA_V3_SQL,
  GLOBAL_SCHEMA_V4_SQL,
  GLOBAL_SCHEMA_V5_SQL,
  GLOBAL_SCHEMA_V6_SQL,
  GLOBAL_SCHEMA_V7_SQL,
  GLOBAL_SCHEMA_V8_SQL,
  GLOBAL_SCHEMA_VERSION,
  applyGlobalSchemaV9,
  applyGlobalSchemaV10,
  applyGlobalSchemaV11,
  applyGlobalSchemaV12,
  applyGlobalSchemaV13,
  applyGlobalSchemaV14,
  applyGlobalSchemaV15,
  applyGlobalSchemaV16,
  applyGlobalSchemaV17,
  applyGlobalSchemaV18,
  applyGlobalSchemaV19,
  applyGlobalSchemaV20,
  applyGlobalSchemaV21,
  applyGlobalSchemaV22,
  applyGlobalSchemaV23,
} from './global-db-schema';

const STEROIDS_DIR = '.steroids';
const DB_NAME = 'steroids.db';

export interface GlobalDatabaseConnection {
  db: Database.Database;
  close: () => void;
}

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
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV15(db);
    applyGlobalSchemaV16(db);
    applyGlobalSchemaV17(db);
    applyGlobalSchemaV18(db);
    applyGlobalSchemaV19(db);
    applyGlobalSchemaV20(db);
    applyGlobalSchemaV21(db);
    applyGlobalSchemaV22(db);
    applyGlobalSchemaV23(db);

    db.prepare('INSERT OR REPLACE INTO _global_schema (key, value) VALUES (?, ?)')
      .run('version', GLOBAL_SCHEMA_VERSION);
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
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
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
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
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
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
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
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '5') {
    // Upgrade from version 5 to latest
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '6') {
    // Upgrade from version 6 to version 7
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '7') {
    // Upgrade from version 7 to version 8
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '8') {
    // Upgrade from version 8 to version 9
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '9') {
    // Upgrade from version 9 to version 10
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '10') {
    // Upgrade from version 10 to version 11
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '11') {
    // Upgrade from version 11 to version 12
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '15') {
    applyGlobalSchemaV16(db);
    applyGlobalSchemaV17(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '18') {
    applyGlobalSchemaV19(db);
    applyGlobalSchemaV20(db);
    applyGlobalSchemaV21(db);
    applyGlobalSchemaV22(db);
    applyGlobalSchemaV23(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '19') {
    applyGlobalSchemaV20(db);
    applyGlobalSchemaV21(db);
    applyGlobalSchemaV22(db);
    applyGlobalSchemaV23(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '20') {
    applyGlobalSchemaV21(db);
    applyGlobalSchemaV22(db);
    applyGlobalSchemaV23(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '21') {
    applyGlobalSchemaV22(db);
    applyGlobalSchemaV23(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '22') {
    applyGlobalSchemaV23(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  }
  applyGlobalSchemaV9(db);
  applyGlobalSchemaV10(db);
  applyGlobalSchemaV11(db);
  applyGlobalSchemaV12(db);
  applyGlobalSchemaV13(db);
  applyGlobalSchemaV14(db);
  applyGlobalSchemaV15(db);
  applyGlobalSchemaV16(db);
  applyGlobalSchemaV17(db);
  applyGlobalSchemaV19(db);
  applyGlobalSchemaV20(db);
  applyGlobalSchemaV21(db);
  applyGlobalSchemaV22(db);
  applyGlobalSchemaV23(db);
  db.prepare(
    `INSERT INTO _global_schema (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('version', GLOBAL_SCHEMA_VERSION);

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

/**
 * Execute a callback with a managed global database connection.
 * Automatically handles closing the connection when done or if an error occurs.
 */
export function withGlobalDatabase<T>(
  callback: (db: Database.Database) => T
): T {
  const { db, close } = openGlobalDatabase();
  try {
    const result = callback(db);
    if (result instanceof Promise) {
      return result.finally(() => close()) as T;
    }
    close();
    return result;
  } catch (error) {
    close();
    throw error;
  }
}
