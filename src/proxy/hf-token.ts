/**
 * HF Token Resolution
 *
 * Resolves a HuggingFace API token from available sources.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve HF token from available sources (in priority order):
 * 1. HF_TOKEN environment variable
 * 2. opencode.json config file
 * 3. ~/.huggingface/token file
 */
export function resolveHFToken(configDir?: string): string | null {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;

  // Try opencode.json
  const opencodeConfigPaths = [
    configDir ? join(configDir, 'opencode.json') : null,
    join(homedir(), '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean) as string[];

  for (const configPath of opencodeConfigPaths) {
    try {
      if (!existsSync(configPath)) continue;
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const token = config?.provider?.huggingface?.options?.apiKey;
      if (token) return token;
    } catch { /* continue */ }
  }

  // Try ~/.huggingface/token
  try {
    const tokenPath = join(homedir(), '.huggingface', 'token');
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, 'utf-8').trim();
      if (token) return token;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Detect if a model ID is a HuggingFace model (contains org/name format).
 * Native provider models don't contain slashes (e.g., claude-sonnet-4-6, gpt-5.3-codex).
 */
export function isHFModel(modelId: string): boolean {
  return modelId.includes('/') && !modelId.startsWith('models/');
}
