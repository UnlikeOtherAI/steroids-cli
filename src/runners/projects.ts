/**
 * Global project registry management
 * Tracks all registered steroids projects across the system
 */

import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openGlobalDatabase } from './global-db.js';
import { loadConfigFile, getGlobalConfigPath } from '../config/loader.js';

export interface RegisteredProject {
  path: string;
  name: string | null;
  registered_at: string;
  last_seen_at: string;
  enabled: boolean;
  pending_count?: number;
  in_progress_count?: number;
  review_count?: number;
  completed_count?: number;
  stats_updated_at?: string | null;
}

/**
 * Normalize a project path to its canonical form
 * - Resolves symlinks
 * - Removes trailing slashes
 * - Returns absolute path
 */
function normalizePath(p: string): string {
  try {
    const resolved = resolve(p);
    const realPath = realpathSync(resolved);
    return realPath.replace(/\/+$/, '');
  } catch (error) {
    // If path doesn't exist or can't be resolved, just clean up the input
    return resolve(p).replace(/\/+$/, '');
  }
}

/** Paths that should never be registered globally (temp dirs, system dirs) */
const BLOCKED_PATH_PREFIXES = ['/tmp/', '/tmp', '/var/tmp/', '/var/tmp'];

/**
 * Check if a path is in a temporary/ephemeral directory
 * Prevents test projects from polluting the global registry
 */
export function isTemporaryPath(path: string): boolean {
  const normalized = normalizePath(path);
  return BLOCKED_PATH_PREFIXES.some(
    (prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
  );
}

/**
 * Expand ~ to the user's home directory
 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Normalize a path list: auto-split entries that look like multiple paths
 * jammed into one string (e.g., "/path1 ~/path2" → ["/path1", "~/path2"]).
 */
function normalizePathList(paths: string[]): string[] {
  const result: string[] = [];
  for (const entry of paths) {
    if (!entry) continue;
    // Split on spaces followed by / or ~ (indicates two paths in one string)
    const parts = entry.split(/\s+(?=[/~])/).map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      console.warn(`Warning: auto-split path entry "${entry}" into ${parts.length} entries: ${parts.join(', ')}`);
    }
    result.push(...parts);
  }
  return result;
}

/**
 * Check if a project path is allowed by whitelist/blacklist config.
 * Reads from global config (~/.steroids/config.yaml).
 *
 * @param path - Normalized absolute path to check
 * @returns Object with allowed boolean and optional reason
 */
export function isPathAllowed(path: string): { allowed: boolean; reason?: string } {
  const globalConfig = loadConfigFile(getGlobalConfigPath());
  const allowedPaths = normalizePathList(globalConfig.projects?.allowedPaths ?? []);
  const blockedPaths = normalizePathList(globalConfig.projects?.blockedPaths ?? []);

  // Whitelist check (if non-empty, path must match at least one entry)
  if (allowedPaths.length > 0) {
    const expanded = allowedPaths.map(p => expandHome(resolve(p)).replace(/\/+$/, ''));
    const matches = expanded.some(prefix => path === prefix || path.startsWith(prefix + '/'));
    if (!matches) {
      return { allowed: false, reason: `Path not in allowed directories: ${allowedPaths.join(', ')}` };
    }
  }

  // Blacklist check (if non-empty, path must NOT match any entry)
  if (blockedPaths.length > 0) {
    const expanded = blockedPaths.map(p => expandHome(resolve(p)).replace(/\/+$/, ''));
    const blocked = expanded.find(prefix => path === prefix || path.startsWith(prefix + '/'));
    if (blocked) {
      return { allowed: false, reason: `Path is in blocked directory: ${blocked}` };
    }
  }

  return { allowed: true };
}

/**
 * Register a project in the global registry
 * Idempotent - updates last_seen_at if project already exists
 *
 * @param path - Absolute path to project directory
 * @param name - Optional project name
 */
export function registerProject(path: string, name?: string): void {
  const normalizedPath = normalizePath(path);

  // Block temporary/ephemeral paths from polluting the global registry
  if (isTemporaryPath(normalizedPath)) {
    return;
  }

  // Check whitelist/blacklist
  const { allowed } = isPathAllowed(normalizedPath);
  if (!allowed) {
    return;
  }

  const { db, close } = openGlobalDatabase();

  try {
    db.prepare(`
      INSERT INTO projects (path, name, registered_at, last_seen_at, enabled)
      VALUES (?, ?, datetime('now'), datetime('now'), 1)
      ON CONFLICT(path) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        last_seen_at = datetime('now')
    `).run(normalizedPath, name ?? null);
  } finally {
    close();
  }
}

/**
 * Get all registered projects (enabled only by default)
 *
 * @param includeDisabled - If true, includes disabled projects
 * @returns Array of registered projects
 */
export function getRegisteredProjects(includeDisabled = false): RegisteredProject[] {
  const { db, close } = openGlobalDatabase();

  try {
    const query = includeDisabled
      ? 'SELECT * FROM projects'
      : 'SELECT * FROM projects WHERE enabled = 1';

    const rows = db.prepare(query).all() as Array<{
      path: string;
      name: string | null;
      registered_at: string;
      last_seen_at: string;
      enabled: number;
      pending_count?: number;
      in_progress_count?: number;
      review_count?: number;
      completed_count?: number;
      stats_updated_at?: string | null;
    }>;

    return rows.map((row) => ({
      path: row.path,
      name: row.name,
      registered_at: row.registered_at,
      last_seen_at: row.last_seen_at,
      enabled: row.enabled === 1,
      pending_count: row.pending_count,
      in_progress_count: row.in_progress_count,
      review_count: row.review_count,
      completed_count: row.completed_count,
      stats_updated_at: row.stats_updated_at,
    }));
  } finally {
    close();
  }
}

/**
 * Get a single registered project by path
 *
 * @param path - Project path to look up
 * @returns Project if found, null otherwise
 */
export function getRegisteredProject(path: string): RegisteredProject | null {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    const row = db
      .prepare('SELECT * FROM projects WHERE path = ?')
      .get(normalizedPath) as {
        path: string;
        name: string | null;
        registered_at: string;
        last_seen_at: string;
        enabled: number;
        pending_count?: number;
        in_progress_count?: number;
        review_count?: number;
        completed_count?: number;
        stats_updated_at?: string | null;
      } | undefined;

    if (!row) {
      return null;
    }

    return {
      path: row.path,
      name: row.name,
      registered_at: row.registered_at,
      last_seen_at: row.last_seen_at,
      enabled: row.enabled === 1,
      pending_count: row.pending_count,
      in_progress_count: row.in_progress_count,
      review_count: row.review_count,
      completed_count: row.completed_count,
      stats_updated_at: row.stats_updated_at,
    };
  } finally {
    close();
  }
}

/**
 * Unregister a project from the global registry
 * Removes it completely from the database
 *
 * @param path - Project path to unregister
 */
export function unregisterProject(path: string): void {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    db.prepare('DELETE FROM projects WHERE path = ?').run(normalizedPath);
  } finally {
    close();
  }
}

/**
 * Disable a project (skip in wakeup, but keep in registry)
 *
 * @param path - Project path to disable
 */
export function disableProject(path: string): void {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    db.prepare('UPDATE projects SET enabled = 0 WHERE path = ?').run(normalizedPath);
  } finally {
    close();
  }
}

/**
 * Enable a project (include in wakeup)
 *
 * @param path - Project path to enable
 */
export function enableProject(path: string): void {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    db.prepare('UPDATE projects SET enabled = 1 WHERE path = ?').run(normalizedPath);
  } finally {
    close();
  }
}

/**
 * Remove projects that no longer exist on disk
 * Returns the number of projects removed
 *
 * @returns Number of projects pruned
 */
export function pruneProjects(): number {
  const { db, close } = openGlobalDatabase();

  try {
    const projects = db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>;
    let removed = 0;

    for (const project of projects) {
      const steroidsDir = join(project.path, '.steroids');
      const steroidsDb = join(steroidsDir, 'steroids.db');

      // Remove if project directory or .steroids directory doesn't exist
      if (!existsSync(project.path) || !existsSync(steroidsDir) || !existsSync(steroidsDb)) {
        db.prepare('DELETE FROM projects WHERE path = ?').run(project.path);
        removed++;
      }
    }

    return removed;
  } finally {
    close();
  }
}

/**
 * Update last_seen_at timestamp for a project
 * Used by runners to track when project was last active
 *
 * @param path - Project path to update
 */
export function updateProjectLastSeen(path: string): void {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    db.prepare("UPDATE projects SET last_seen_at = datetime('now') WHERE path = ?").run(
      normalizedPath
    );
  } finally {
    close();
  }
}

/**
 * Check if a project is registered
 *
 * @param path - Project path to check
 * @returns True if project is registered
 */
export function isProjectRegistered(path: string): boolean {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    const row = db
      .prepare('SELECT 1 FROM projects WHERE path = ?')
      .get(normalizedPath) as { 1: number } | undefined;

    return row !== undefined;
  } finally {
    close();
  }
}

/**
 * Task count statistics for a project
 */
export interface ProjectStats {
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
}

/**
 * Update project stats in global database
 * Called by runner heartbeat to cache stats for API/WebUI access
 *
 * @param path - Project path
 * @param stats - Task counts by status
 */
export function updateProjectStats(path: string, stats: ProjectStats): void {
  const normalizedPath = normalizePath(path);
  const { db, close } = openGlobalDatabase();

  try {
    db.prepare(`
      UPDATE projects SET
        pending_count = ?,
        in_progress_count = ?,
        review_count = ?,
        completed_count = ?,
        stats_updated_at = datetime('now')
      WHERE path = ?
    `).run(
      stats.pending,
      stats.in_progress,
      stats.review,
      stats.completed,
      normalizedPath
    );
  } finally {
    close();
  }
}
