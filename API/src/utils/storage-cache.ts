/**
 * In-memory cache for project storage computations.
 * Keyed by project path with configurable TTL.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  getStorageBreakdown,
  formatBytes,
  type StorageBreakdown,
} from '../../../dist/cleanup/directory-size.js';
import { getRegisteredProject } from '../../../dist/runners/projects.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const detailCache = new Map<string, CacheEntry<StorageBreakdown>>();
const listCache = new Map<string, CacheEntry<ListStorageInfo>>();

const DETAIL_TTL_MS = 60_000;    // 60 seconds
const LIST_TTL_MS = 300_000;     // 5 minutes

export interface ListStorageInfo {
  storage_bytes: number;
  storage_human: string;
  storage_warning: 'orange' | 'red' | null;
}

/**
 * Validate that a query path is a registered project.
 * Uses fs.promises.realpath() to resolve symlinks, then checks the global DB.
 */
export async function validateProjectPath(
  path: string | undefined,
): Promise<{ valid: true; realPath: string } | { valid: false; error: string; status: number }> {
  if (!path || typeof path !== 'string' || path.trim().length === 0) {
    return { valid: false, error: 'Query parameter "path" is required', status: 400 };
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(path);
  } catch {
    return { valid: false, error: 'Path does not exist or is inaccessible', status: 404 };
  }
  const project = getRegisteredProject(realPath);
  if (!project) {
    return { valid: false, error: 'Path is not a registered project', status: 403 };
  }
  return { valid: true, realPath };
}

/**
 * Get detailed storage breakdown with 60s cache.
 */
export async function getCachedStorageBreakdown(
  projectPath: string, 
  retentionDays: number = 7,
  backupRetentionDays: number = 30
): Promise<StorageBreakdown> {
  const entry = detailCache.get(projectPath);
  if (entry && Date.now() < entry.expiresAt) return entry.data;

  const steroidsDir = join(projectPath, '.steroids');
  const data = await getStorageBreakdown(steroidsDir, retentionDays, backupRetentionDays);
  detailCache.set(projectPath, { data, expiresAt: Date.now() + DETAIL_TTL_MS });
  return data;
}

/**
 * Get lightweight storage info for project list with 5-minute cache.
 * Returns null if not yet computed (triggers background computation).
 */
export function getCachedListStorage(projectPath: string): ListStorageInfo | null {
  const entry = listCache.get(projectPath);
  if (entry && Date.now() < entry.expiresAt) return entry.data;

  // Trigger background computation (don't block the list response)
  computeListStorageInBackground(projectPath);
  return entry?.data ?? null;  // Return stale data if available, null otherwise
}

function computeListStorageInBackground(projectPath: string): void {
  const steroidsDir = join(projectPath, '.steroids');
  getStorageBreakdown(steroidsDir)
    .then((breakdown) => {
      listCache.set(projectPath, {
        data: {
          storage_bytes: breakdown.total_bytes,
          storage_human: breakdown.total_human,
          storage_warning: breakdown.threshold_warning,
        },
        expiresAt: Date.now() + LIST_TTL_MS,
      });
    })
    .catch(() => { /* tolerate background failures */ });
}

/**
 * Bust all caches for a given project path.
 * Called after POST /clear-logs to ensure fresh data.
 */
export function bustStorageCache(projectPath: string): void {
  detailCache.delete(projectPath);
  listCache.delete(projectPath);
}
