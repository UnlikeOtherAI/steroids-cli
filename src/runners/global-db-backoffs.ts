/**
 * Provider backoff coordination
 */

import Database from 'better-sqlite3';
import { withGlobalDatabase } from './global-db-connection';
import { loadConfig } from '../config/loader.js';

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

/**
 * Record a provider rate limit backoff in the global DB.
 * Uses MAX so existing longer backoffs are never shortened.
 */
export function recordProviderBackoff(provider: string, backoffUntilMs: number, reason?: string, reasonType?: string): void {
  withGlobalDatabase((db) => {
    // We only update reason_type if the schema has it (V18+)
    if (hasColumn(db, 'provider_backoffs', 'reason_type')) {
      db.prepare(`
        INSERT INTO provider_backoffs (provider, backoff_until_ms, retry_count, reason, reason_type, updated_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          backoff_until_ms = MAX(backoff_until_ms, excluded.backoff_until_ms),
          retry_count = retry_count + 1,
          reason = excluded.reason,
          reason_type = excluded.reason_type,
          updated_at = excluded.updated_at
      `).run(provider, backoffUntilMs, reason ?? null, reasonType ?? null, Date.now());
    } else {
      db.prepare(`
        INSERT INTO provider_backoffs (provider, backoff_until_ms, retry_count, reason, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          backoff_until_ms = MAX(backoff_until_ms, excluded.backoff_until_ms),
          retry_count = retry_count + 1,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `).run(provider, backoffUntilMs, reason ?? null, Date.now());
    }
  });
}

/**
 * Get how many ms until the provider's global backoff expires (0 if not backed off).
 */
export function getProviderBackoffRemainingMs(provider: string): number {
  return withGlobalDatabase((db) => {
    const row = db
      .prepare('SELECT backoff_until_ms FROM provider_backoffs WHERE provider = ?')
      .get(provider) as { backoff_until_ms: number } | undefined;
    if (!row) return 0;
    return Math.max(0, row.backoff_until_ms - Date.now());
  });
}

/**
 * Get full backoff info including reason_type (for auth probes).
 */
export function getProviderBackoffInfo(provider: string): { remainingMs: number; reasonType: string | null } | null {
  return withGlobalDatabase((db) => {
    const row = db
      .prepare('SELECT backoff_until_ms, reason_type FROM provider_backoffs WHERE provider = ?')
      .get(provider) as { backoff_until_ms: number; reason_type: string | null } | undefined;
    if (!row) return null;
    const remainingMs = Math.max(0, row.backoff_until_ms - Date.now());
    if (remainingMs <= 0) return null;
    return { remainingMs, reasonType: row.reason_type ?? null };
  });
}

/**
 * Clear a provider's backoff record (called after a successful invocation).
 */
export function clearProviderBackoff(provider: string): void {
  withGlobalDatabase((db) => {
    db.prepare('DELETE FROM provider_backoffs WHERE provider = ?').run(provider);
  });
}

/**
 * Check if any provider used by a specific project is currently backed off.
 * Loads the project config to determine coder/reviewer providers, then checks
 * only those providers — prevents cross-project backoff contamination.
 */
export function getProjectProviderBackoff(
  projectPath: string,
): { provider: string; remainingMs: number } | null {
  const projectConfig = loadConfig(projectPath);
  const coderProvider = projectConfig.ai?.coder?.provider;
  const reviewerProvider = projectConfig.ai?.reviewer?.provider;
  const providersToCheck = [...new Set([coderProvider, reviewerProvider].filter(Boolean) as string[])];

  for (const provider of providersToCheck) {
    const remainingMs = getProviderBackoffRemainingMs(provider);
    if (remainingMs > 0) {
      return { provider, remainingMs };
    }
  }

  return null;
}
