/**
 * SQLite database connection management
 * Uses better-sqlite3 for synchronous operations with WAL mode
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_SQL, INITIAL_SCHEMA_DATA, SCHEMA_VERSION } from './schema.js';
import { autoMigrate } from '../migrations/runner.js';

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
 * Check if an error is a schema mismatch (missing column/table)
 */
function isSchemaMismatchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('has no column named') ||
    msg.includes('no such column') ||
    msg.includes('no such table')
  );
}

/**
 * Format a helpful error message for schema mismatches
 */
function formatMigrationHint(originalError: Error, migrationResult?: string): string {
  const lines = [
    `Database schema is out of date: ${originalError.message}`,
    '',
    'Your database is missing columns or tables added in a newer version of Steroids.',
  ];

  if (migrationResult) {
    lines.push(`Auto-migration failed: ${migrationResult}`);
  }

  lines.push(
    '',
    'To fix this, run:',
    '',
    '  STEROIDS_AUTO_MIGRATE=1 steroids health',
    '',
    'Or set STEROIDS_AUTO_MIGRATE=1 in your environment to migrate automatically.',
  );

  return lines.join('\n');
}

/**
 * Open an existing database connection
 * Automatically applies pending migrations if any are found
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

  // Always attempt auto-migration for pending migrations
  try {
    const result = autoMigrate(db, dbPath);
    if (result.applied && result.migrations.length > 0) {
      console.log(`Auto-migrated database: ${result.migrations.join(', ')}`);
    }
    if (result.error) {
      console.error(`Warning: Migration issue: ${result.error}`);
    }
  } catch (err) {
    // Log but don't fail - the DB may still work if no new columns are needed
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Could not check migrations: ${msg}`);
  }

  // Wrap the database with schema error interception
  return {
    db: wrapWithSchemaErrorHandling(db),
    close: () => db.close(),
  };
}

/**
 * Wrap a database instance to intercept schema mismatch errors
 * and provide helpful migration instructions instead of raw SQLite errors
 */
function wrapWithSchemaErrorHandling(db: Database.Database): Database.Database {
  const originalPrepare = db.prepare.bind(db);

  db.prepare = function wrappedPrepare(sql: string) {
    try {
      const stmt = originalPrepare(sql);
      return wrapStatement(stmt);
    } catch (err) {
      if (isSchemaMismatchError(err)) {
        const hint = formatMigrationHint(err as Error);
        const wrapped = new Error(hint);
        wrapped.name = 'MigrationRequired';
        throw wrapped;
      }
      throw err;
    }
  } as typeof db.prepare;

  // Also wrap db.exec for raw SQL execution
  const originalExec = db.exec.bind(db);
  db.exec = function wrappedExec(sql: string) {
    try {
      return originalExec(sql);
    } catch (err) {
      if (isSchemaMismatchError(err)) {
        const hint = formatMigrationHint(err as Error);
        const wrapped = new Error(hint);
        wrapped.name = 'MigrationRequired';
        throw wrapped;
      }
      throw err;
    }
  } as typeof db.exec;

  return db;
}

/**
 * Wrap a prepared statement to intercept schema errors at execution time
 */
function wrapStatement(stmt: Database.Statement): Database.Statement {
  const wrapMethod = <T extends (...args: unknown[]) => unknown>(fn: T): T => {
    return ((...args: unknown[]) => {
      try {
        return fn.apply(stmt, args);
      } catch (err) {
        if (isSchemaMismatchError(err)) {
          const hint = formatMigrationHint(err as Error);
          const wrapped = new Error(hint);
          wrapped.name = 'MigrationRequired';
          throw wrapped;
        }
        throw err;
      }
    }) as T;
  };

  if (stmt.run) stmt.run = wrapMethod(stmt.run.bind(stmt));
  if (stmt.get) stmt.get = wrapMethod(stmt.get.bind(stmt));
  if (stmt.all) stmt.all = wrapMethod(stmt.all.bind(stmt));

  return stmt;
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
