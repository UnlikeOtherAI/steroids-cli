/**
 * Migration manifest management
 * Handles reading, parsing, and validating the migration manifest
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

/**
 * Single migration entry in the manifest
 */
export interface MigrationEntry {
  id: number;
  name: string;
  file: string;
  description: string;
  checksum: string;
  cliVersion: string;
}

/**
 * Migration manifest structure
 */
export interface MigrationManifest {
  version: string;
  latestDbVersion: number;
  migrations: MigrationEntry[];
}

/**
 * Applied migration record from database
 */
export interface AppliedMigration {
  id: number;
  name: string;
  checksum: string;
  applied_at: string;
}

/**
 * Cache entry for remote manifest
 */
interface ManifestCache {
  fetchedAt: number;
  manifest: MigrationManifest;
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const GLOBAL_STEROIDS_DIR = join(homedir(), '.steroids');
const CACHE_DIR = join(GLOBAL_STEROIDS_DIR, 'migrations');
const CACHE_FILE = join(CACHE_DIR, 'manifest-cache.json');

/**
 * Get the path to the bundled manifest (in the package)
 */
export function getBundledManifestPath(): string {
  // Resolve relative to project root
  return join(process.cwd(), 'migrations', 'manifest.json');
}

/**
 * Get the path to the cached manifest
 */
export function getCachedManifestPath(): string {
  return join(CACHE_DIR, 'manifest.json');
}

/**
 * Read the bundled manifest from the package
 */
export function readBundledManifest(): MigrationManifest {
  const manifestPath = getBundledManifestPath();

  if (!existsSync(manifestPath)) {
    throw new Error(`Bundled manifest not found at: ${manifestPath}`);
  }

  const content = readFileSync(manifestPath, 'utf-8');
  return parseManifest(content);
}

/**
 * Read the cached manifest if it exists and is valid
 */
export function readCachedManifest(): MigrationManifest | null {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  try {
    const cacheContent = readFileSync(CACHE_FILE, 'utf-8');
    const cache: ManifestCache = JSON.parse(cacheContent);

    // Check if cache is still valid
    if (Date.now() - cache.fetchedAt > CACHE_TTL) {
      return null;
    }

    return cache.manifest;
  } catch {
    return null;
  }
}

/**
 * Save manifest to cache
 */
export function cacheManifest(manifest: MigrationManifest): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cache: ManifestCache = {
    fetchedAt: Date.now(),
    manifest,
  };

  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

  // Also save the manifest itself for offline access
  writeFileSync(getCachedManifestPath(), JSON.stringify(manifest, null, 2));
}

/**
 * Parse and validate manifest content
 */
export function parseManifest(content: string): MigrationManifest {
  const manifest = JSON.parse(content) as MigrationManifest;
  validateManifest(manifest);
  return manifest;
}

/**
 * Validate manifest structure
 */
export function validateManifest(manifest: MigrationManifest): void {
  if (!manifest.version) {
    throw new Error('Manifest missing version field');
  }

  if (typeof manifest.latestDbVersion !== 'number' || manifest.latestDbVersion < 1) {
    throw new Error('Manifest missing or invalid latestDbVersion field');
  }

  if (!Array.isArray(manifest.migrations)) {
    throw new Error('Manifest missing migrations array');
  }

  // Validate each migration entry
  for (const migration of manifest.migrations) {
    validateMigrationEntry(migration);
  }

  // Validate migrations are in order
  const ids = manifest.migrations.map(m => m.id);
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] <= ids[i - 1]) {
      throw new Error(`Migrations not in order: ${ids[i - 1]} followed by ${ids[i]}`);
    }
  }

  // Validate latestDbVersion matches
  if (manifest.migrations.length > 0) {
    const maxId = Math.max(...ids);
    if (maxId !== manifest.latestDbVersion) {
      throw new Error(
        `latestDbVersion (${manifest.latestDbVersion}) does not match highest migration id (${maxId})`
      );
    }
  }
}

/**
 * Validate a single migration entry
 */
function validateMigrationEntry(entry: MigrationEntry): void {
  if (typeof entry.id !== 'number' || entry.id < 1) {
    throw new Error(`Invalid migration id: ${entry.id}`);
  }

  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error(`Migration ${entry.id} missing name`);
  }

  if (!entry.file || typeof entry.file !== 'string') {
    throw new Error(`Migration ${entry.id} missing file`);
  }

  if (!entry.description || typeof entry.description !== 'string') {
    throw new Error(`Migration ${entry.id} missing description`);
  }

  if (!entry.cliVersion || typeof entry.cliVersion !== 'string') {
    throw new Error(`Migration ${entry.id} missing cliVersion`);
  }

  // Checksum can be empty for new migrations
}

/**
 * Calculate SHA256 checksum for migration file content
 */
export function calculateChecksum(content: string): string {
  const hash = createHash('sha256');
  hash.update(content);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Verify checksum matches
 */
export function verifyChecksum(content: string, expectedChecksum: string): boolean {
  if (!expectedChecksum) {
    // No checksum to verify
    return true;
  }

  const actual = calculateChecksum(content);
  return actual === expectedChecksum;
}

/**
 * Find pending migrations that need to be applied
 */
export function findPendingMigrations(
  manifest: MigrationManifest,
  appliedMigrations: AppliedMigration[]
): MigrationEntry[] {
  const appliedIds = new Set(appliedMigrations.map(m => m.id));
  return manifest.migrations.filter(m => !appliedIds.has(m.id));
}

/**
 * Find migrations to rollback (applied but not in manifest)
 */
export function findOrphanedMigrations(
  manifest: MigrationManifest,
  appliedMigrations: AppliedMigration[]
): AppliedMigration[] {
  const manifestIds = new Set(manifest.migrations.map(m => m.id));
  return appliedMigrations.filter(m => !manifestIds.has(m.id));
}

/**
 * Get migration entry by ID
 */
export function getMigrationById(manifest: MigrationManifest, id: number): MigrationEntry | null {
  return manifest.migrations.find(m => m.id === id) ?? null;
}

/**
 * Get the current supported database version range for this CLI
 */
export function getCliSupportedVersions(manifest: MigrationManifest): { min: number; max: number } {
  if (manifest.migrations.length === 0) {
    return { min: 0, max: 0 };
  }

  return {
    min: 1, // Always support from version 1
    max: manifest.latestDbVersion,
  };
}
