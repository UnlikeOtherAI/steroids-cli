/**
 * Global project registry management
 * Tracks all registered steroids projects across the system
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openGlobalDatabase } from './global-db.js';
/**
 * Normalize a project path to its canonical form
 * - Resolves symlinks
 * - Removes trailing slashes
 * - Returns absolute path
 */
function normalizePath(p) {
    try {
        const resolved = resolve(p);
        const realPath = realpathSync(resolved);
        return realPath.replace(/\/+$/, '');
    }
    catch (error) {
        // If path doesn't exist or can't be resolved, just clean up the input
        return resolve(p).replace(/\/+$/, '');
    }
}
/**
 * Register a project in the global registry
 * Idempotent - updates last_seen_at if project already exists
 *
 * @param path - Absolute path to project directory
 * @param name - Optional project name
 */
export function registerProject(path, name) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        db.prepare(`
      INSERT INTO projects (path, name, registered_at, last_seen_at, enabled)
      VALUES (?, ?, datetime('now'), datetime('now'), 1)
      ON CONFLICT(path) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        last_seen_at = datetime('now')
    `).run(normalizedPath, name ?? null);
    }
    finally {
        close();
    }
}
/**
 * Get all registered projects (enabled only by default)
 *
 * @param includeDisabled - If true, includes disabled projects
 * @returns Array of registered projects
 */
export function getRegisteredProjects(includeDisabled = false) {
    const { db, close } = openGlobalDatabase();
    try {
        const query = includeDisabled
            ? 'SELECT path, name, registered_at, last_seen_at, enabled FROM projects'
            : 'SELECT path, name, registered_at, last_seen_at, enabled FROM projects WHERE enabled = 1';
        const rows = db.prepare(query).all();
        return rows.map((row) => ({
            path: row.path,
            name: row.name,
            registered_at: row.registered_at,
            last_seen_at: row.last_seen_at,
            enabled: row.enabled === 1,
        }));
    }
    finally {
        close();
    }
}
/**
 * Get a single registered project by path
 *
 * @param path - Project path to look up
 * @returns Project if found, null otherwise
 */
export function getRegisteredProject(path) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        const row = db
            .prepare('SELECT path, name, registered_at, last_seen_at, enabled FROM projects WHERE path = ?')
            .get(normalizedPath);
        if (!row) {
            return null;
        }
        return {
            path: row.path,
            name: row.name,
            registered_at: row.registered_at,
            last_seen_at: row.last_seen_at,
            enabled: row.enabled === 1,
        };
    }
    finally {
        close();
    }
}
/**
 * Unregister a project from the global registry
 * Removes it completely from the database
 *
 * @param path - Project path to unregister
 */
export function unregisterProject(path) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        db.prepare('DELETE FROM projects WHERE path = ?').run(normalizedPath);
    }
    finally {
        close();
    }
}
/**
 * Disable a project (skip in wakeup, but keep in registry)
 *
 * @param path - Project path to disable
 */
export function disableProject(path) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        db.prepare('UPDATE projects SET enabled = 0 WHERE path = ?').run(normalizedPath);
    }
    finally {
        close();
    }
}
/**
 * Enable a project (include in wakeup)
 *
 * @param path - Project path to enable
 */
export function enableProject(path) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        db.prepare('UPDATE projects SET enabled = 1 WHERE path = ?').run(normalizedPath);
    }
    finally {
        close();
    }
}
/**
 * Remove projects that no longer exist on disk
 * Returns the number of projects removed
 *
 * @returns Number of projects pruned
 */
export function pruneProjects() {
    const { db, close } = openGlobalDatabase();
    try {
        const projects = db.prepare('SELECT path FROM projects').all();
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
    }
    finally {
        close();
    }
}
/**
 * Update last_seen_at timestamp for a project
 * Used by runners to track when project was last active
 *
 * @param path - Project path to update
 */
export function updateProjectLastSeen(path) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        db.prepare("UPDATE projects SET last_seen_at = datetime('now') WHERE path = ?").run(normalizedPath);
    }
    finally {
        close();
    }
}
/**
 * Check if a project is registered
 *
 * @param path - Project path to check
 * @returns True if project is registered
 */
export function isProjectRegistered(path) {
    const normalizedPath = normalizePath(path);
    const { db, close } = openGlobalDatabase();
    try {
        const row = db
            .prepare('SELECT 1 FROM projects WHERE path = ?')
            .get(normalizedPath);
        return row !== undefined;
    }
    finally {
        close();
    }
}
//# sourceMappingURL=projects.js.map