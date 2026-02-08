/**
 * Path validation utilities for API security
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Validate that a path is safe and points to a valid Steroids project
 *
 * @param path - Path to validate
 * @returns True if path is valid and safe
 */
export function isValidProjectPath(path: string): boolean {
  try {
    const realPath = realpathSync(path);

    // Must contain .steroids directory with database
    const steroidsDb = join(realPath, '.steroids', 'steroids.db');
    if (!existsSync(steroidsDb)) {
      return false;
    }

    // Must not be system directories
    const forbidden = ['/etc', '/var', '/usr', '/bin', '/sbin', '/System'];
    if (forbidden.some((f) => realPath.startsWith(f))) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate request body for path-based operations
 *
 * @param body - Request body
 * @returns Validation result with error message if invalid
 */
export function validatePathRequest(body: unknown): { valid: boolean; error?: string; path?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }

  const { path } = body as { path?: unknown };

  if (!path || typeof path !== 'string') {
    return { valid: false, error: 'Request body must contain a "path" string field' };
  }

  if (path.trim().length === 0) {
    return { valid: false, error: 'Path cannot be empty' };
  }

  return { valid: true, path };
}
