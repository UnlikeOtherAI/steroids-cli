/**
 * Migration runner
 * Applies and rolls back database migrations with transaction safety
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  MigrationManifest,
  MigrationEntry,
  AppliedMigration,
  readBundledManifest,
  getMigrationFilePath,
  calculateChecksum,
  verifyChecksum,
  findPendingMigrations,
} from './manifest.js';

/**
 * Result of a migration operation
 */
export interface MigrationResult {
  success: boolean;
  applied: string[];
  failed?: string;
  error?: string;
}

/**
 * Migration SQL sections
 */
interface MigrationSql {
  up: string;
  down: string;
}

/**
 * Parse migration file into UP and DOWN sections
 */
export function parseMigrationFile(content: string): MigrationSql {
  const lines = content.split('\n');
  let currentSection: 'none' | 'up' | 'down' = 'none';
  const upLines: string[] = [];
  const downLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();

    if (trimmed === '-- UP') {
      currentSection = 'up';
      continue;
    }

    if (trimmed === '-- DOWN') {
      currentSection = 'down';
      continue;
    }

    if (currentSection === 'up') {
      upLines.push(line);
    } else if (currentSection === 'down') {
      downLines.push(line);
    }
  }

  return {
    up: upLines.join('\n').trim(),
    down: downLines.join('\n').trim(),
  };
}

/**
 * Read migration file content
 */
export function readMigrationFile(entry: MigrationEntry): string {
  const filePath = getMigrationFilePath(entry.file);

  if (!existsSync(filePath)) {
    throw new Error(`Migration file not found: ${filePath}`);
  }

  return readFileSync(filePath, 'utf-8');
}

/**
 * Get applied migrations from database
 */
export function getAppliedMigrations(db: Database.Database): AppliedMigration[] {
  try {
    const rows = db.prepare('SELECT id, name, checksum, applied_at FROM _migrations ORDER BY id').all();
    return rows as AppliedMigration[];
  } catch {
    // Table may not exist yet
    return [];
  }
}

/**
 * Get current database version
 */
export function getDatabaseVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM _schema WHERE key = ?').get('version') as { value: string } | undefined;
    if (!row) return 0;

    // Parse version - could be semver "0.1.0" or just a number
    const version = row.value;
    if (/^\d+$/.test(version)) {
      return parseInt(version, 10);
    }

    // For semver, use the number of applied migrations as the version
    const migrations = getAppliedMigrations(db);
    return migrations.length;
  } catch {
    return 0;
  }
}

/**
 * Update database version in _schema table
 */
function updateDatabaseVersion(db: Database.Database, version: number, migrationName: string): void {
  db.prepare('INSERT OR REPLACE INTO _schema (key, value) VALUES (?, ?)').run('version', version.toString());
  db.prepare('INSERT OR REPLACE INTO _schema (key, value) VALUES (?, ?)').run('last_migration', migrationName);
}

/**
 * Record applied migration
 */
function recordMigration(db: Database.Database, entry: MigrationEntry, checksum: string): void {
  db.prepare('INSERT INTO _migrations (id, name, checksum) VALUES (?, ?, ?)').run(
    entry.id,
    entry.name,
    checksum
  );
}

/**
 * Remove migration record (for rollback)
 */
function removeMigrationRecord(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM _migrations WHERE id = ?').run(id);
}

/**
 * Create backup of database before migration
 */
export function createBackup(dbPath: string): string {
  const steroidsDir = dirname(dbPath);
  const backupDir = join(steroidsDir, 'backup');

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `pre-migrate-${timestamp}.db`);

  copyFileSync(dbPath, backupPath);

  // Also copy WAL and SHM files if they exist
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  if (existsSync(walPath)) {
    copyFileSync(walPath, `${backupPath}-wal`);
  }
  if (existsSync(shmPath)) {
    copyFileSync(shmPath, `${backupPath}-shm`);
  }

  return backupPath;
}

/**
 * Apply a single migration
 * Handles idempotent migrations (e.g., duplicate column errors are treated as success)
 */
export function applyMigration(
  db: Database.Database,
  entry: MigrationEntry,
  content: string
): void {
  const parsed = parseMigrationFile(content);
  const checksum = calculateChecksum(content);

  if (entry.checksum && !verifyChecksum(content, entry.checksum)) {
    throw new Error(
      `Checksum mismatch for migration ${entry.name}. ` +
      `Expected ${entry.checksum}, got ${checksum}. ` +
      'The migration file may have been corrupted or tampered with.'
    );
  }

  if (!parsed.up) {
    throw new Error(`Migration ${entry.name} has no UP section`);
  }

  // Apply the migration in a transaction
  // Handle idempotent cases like "duplicate column name" or "table already exists"
  const transaction = db.transaction(() => {
    try {
      db.exec(parsed.up);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // These errors indicate the migration was already effectively applied
      const idempotentErrors = [
        'duplicate column name',
        'table already exists',
        'index already exists',
      ];
      const isIdempotent = idempotentErrors.some(e => msg.toLowerCase().includes(e));
      if (!isIdempotent) {
        throw err;
      }
      // Migration already applied, continue to record it
    }
    recordMigration(db, entry, checksum);
    updateDatabaseVersion(db, entry.id, entry.name);
  });

  transaction();
}

/**
 * Rollback a single migration
 */
export function rollbackMigration(
  db: Database.Database,
  entry: MigrationEntry,
  content: string
): void {
  const parsed = parseMigrationFile(content);

  if (!parsed.down) {
    throw new Error(`Migration ${entry.name} has no DOWN section - cannot rollback`);
  }

  // Rollback in a transaction
  const transaction = db.transaction(() => {
    db.exec(parsed.down);
    removeMigrationRecord(db, entry.id);

    // Update version to previous migration
    const previousId = entry.id - 1;
    if (previousId > 0) {
      const manifest = readBundledManifest();
      const previousMigration = manifest.migrations.find(m => m.id === previousId);
      if (previousMigration) {
        updateDatabaseVersion(db, previousId, previousMigration.name);
      }
    } else {
      // No more migrations, set version to 0
      db.prepare('DELETE FROM _schema WHERE key = ?').run('version');
      db.prepare('DELETE FROM _schema WHERE key = ?').run('last_migration');
    }
  });

  transaction();
}

/**
 * Run all pending migrations
 */
export function runMigrations(
  db: Database.Database,
  manifest: MigrationManifest,
  options: {
    toVersion?: number;
    dryRun?: boolean;
  } = {}
): MigrationResult {
  const applied = getAppliedMigrations(db);
  const pending = findPendingMigrations(manifest, applied);

  // Filter by target version if specified
  const migrationsToApply = options.toVersion
    ? pending.filter(m => m.id <= options.toVersion!)
    : pending;

  if (migrationsToApply.length === 0) {
    return {
      success: true,
      applied: [],
    };
  }

  // Sort by ID to ensure correct order
  migrationsToApply.sort((a, b) => a.id - b.id);

  if (options.dryRun) {
    return {
      success: true,
      applied: migrationsToApply.map(m => m.name),
    };
  }

  const appliedNames: string[] = [];

  for (const migration of migrationsToApply) {
    try {
      const content = readMigrationFile(migration);
      applyMigration(db, migration, content);
      appliedNames.push(migration.name);
    } catch (error) {
      return {
        success: false,
        applied: appliedNames,
        failed: migration.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    success: true,
    applied: appliedNames,
  };
}

/**
 * Rollback to a specific version
 */
export function rollbackToVersion(
  db: Database.Database,
  manifest: MigrationManifest,
  targetVersion: number
): MigrationResult {
  const applied = getAppliedMigrations(db);

  // Find migrations to rollback (those with id > targetVersion)
  const toRollback = applied
    .filter(m => m.id > targetVersion)
    .sort((a, b) => b.id - a.id); // Rollback in reverse order

  if (toRollback.length === 0) {
    return {
      success: true,
      applied: [],
    };
  }

  const rolledBack: string[] = [];

  for (const migration of toRollback) {
    const entry = manifest.migrations.find(m => m.id === migration.id);
    if (!entry) {
      return {
        success: false,
        applied: rolledBack,
        failed: migration.name,
        error: `Migration ${migration.name} not found in manifest`,
      };
    }

    try {
      const content = readMigrationFile(entry);
      rollbackMigration(db, entry, content);
      rolledBack.push(migration.name);
    } catch (error) {
      return {
        success: false,
        applied: rolledBack,
        failed: migration.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    success: true,
    applied: rolledBack,
  };
}

/**
 * Get migration status
 */
export interface MigrationStatus {
  currentVersion: number;
  latestVersion: number;
  isUpToDate: boolean;
  pending: MigrationEntry[];
  applied: AppliedMigration[];
}

export function getMigrationStatus(
  db: Database.Database,
  manifest: MigrationManifest
): MigrationStatus {
  const applied = getAppliedMigrations(db);
  const pending = findPendingMigrations(manifest, applied);
  const currentVersion = applied.length > 0 ? Math.max(...applied.map(m => m.id)) : 0;

  return {
    currentVersion,
    latestVersion: manifest.latestDbVersion,
    isUpToDate: pending.length === 0,
    pending,
    applied,
  };
}

/**
 * Check and apply any pending migrations automatically
 * Returns true if migrations were applied, false if already up to date
 */
export function autoMigrate(db: Database.Database, dbPath?: string): {
  applied: boolean;
  migrations: string[];
  error?: string;
} {
  try {
    const manifest = readBundledManifest();
    const status = getMigrationStatus(db, manifest);

    if (status.isUpToDate) {
      return { applied: false, migrations: [] };
    }

    // Create backup before migrating if path provided
    if (dbPath) {
      try {
        createBackup(dbPath);
      } catch (backupErr) {
        // Log but don't fail - backup is optional
        console.error('Warning: Could not create backup before migration:', backupErr);
      }
    }

    // Apply pending migrations
    const result = runMigrations(db, manifest);

    if (!result.success) {
      return {
        applied: false,
        migrations: result.applied,
        error: `Migration failed at ${result.failed}: ${result.error}`,
      };
    }

    return {
      applied: result.applied.length > 0,
      migrations: result.applied,
    };
  } catch (err) {
    return {
      applied: false,
      migrations: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
