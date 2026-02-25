/**
 * Global daemon active status management
 */

import { withGlobalDatabase } from './global-db-connection';

/**
 * Get the global daemon active status
 */
export function getDaemonActiveStatus(): boolean {
  try {
    return withGlobalDatabase((db) => {
      const row = db
        .prepare('SELECT value FROM _global_schema WHERE key = ?')
        .get('is_active') as { value: string } | undefined;
      // Default to true if not explicitly set to 'false'
      return row?.value !== 'false';
    });
  } catch {
    return true; // Default to active on error
  }
}

/**
 * Set the global daemon active status
 */
export function setDaemonActiveStatus(isActive: boolean): void {
  withGlobalDatabase((db) => {
    db.prepare(
      `INSERT INTO _global_schema (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('is_active', isActive ? 'true' : 'false');
  });
}
