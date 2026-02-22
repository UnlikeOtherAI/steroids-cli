/**
 * Wakeup timing and state tracking
 */

import { openGlobalDatabase } from './global-db.js';

/**
 * Record the last wakeup invocation time
 */
export function recordWakeupTime(): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO _global_schema (key, value) VALUES ('last_wakeup_at', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = datetime('now')`
    ).run();
  } finally {
    close();
  }
}

/**
 * Get the last wakeup invocation time
 */
export function getLastWakeupTime(): string | null {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare("SELECT value FROM _global_schema WHERE key = 'last_wakeup_at'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    close();
  }
}
