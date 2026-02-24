import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProviderRegistry } from './registry.js';

/**
 * Perform a lightweight, deterministic ping to check if provider capacity is restored.
 */
export async function pingProvider(providerName: string, model: string): Promise<boolean> {
  const registry = await getProviderRegistry();
  const provider = registry.tryGet(providerName);
  if (!provider) return false;

  const tmpFile = join(tmpdir(), `ping-${randomUUID()}.txt`);
  writeFileSync(tmpFile, 'hello world!', 'utf8');

  try {
    const result = await provider.invoke(tmpFile, { model, timeout: 15000, cwd: tmpdir() });
    return result.success && result.exitCode === 0;
  } catch (err) {
    return false;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup error
    }
  }
}