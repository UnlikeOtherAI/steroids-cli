import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve steroids CLI entrypoint from compiled runtime.
 * Expected dist layout:
 * - dist/index.js
 * - dist/cli/entrypoint.js
 */
export function resolveCliEntrypoint(): string | null {
  const distCliPath = join(__dirname, '..', 'index.js');
  if (existsSync(distCliPath)) {
    return distCliPath;
  }
  return null;
}

