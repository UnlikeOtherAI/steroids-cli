/**
 * Migration system exports
 * Re-exports all migration-related functionality
 */

// Manifest management
export {
  MigrationEntry,
  MigrationManifest,
  AppliedMigration,
  getBundledManifestPath,
  getCachedManifestPath,
  readBundledManifest,
  readCachedManifest,
  cacheManifest,
  parseManifest,
  validateManifest,
  calculateChecksum,
  verifyChecksum,
  findPendingMigrations,
  findOrphanedMigrations,
  getMigrationById,
  getCliSupportedVersions,
} from './manifest.js';

// Migration runner
export {
  MigrationResult,
  MigrationStatus,
  parseMigrationFile,
  readMigrationFile,
  getAppliedMigrations,
  getDatabaseVersion,
  createBackup,
  applyMigration,
  rollbackMigration,
  runMigrations,
  rollbackToVersion,
  getMigrationStatus,
} from './runner.js';
