/**
 * Configuration API routes
 * Provides schema and config value endpoints
 */

import { Router, Request, Response } from 'express';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';

// Types for API model responses
interface APIModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
}

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

const STEROIDS_DIR = '.steroids';
const CONFIG_FILE = 'config.yaml';

/**
 * Get config schema by running CLI command
 * Uses the globally installed steroids command
 */
function getSchema(category?: string): object | null {
  try {
    const cmd = category
      ? `steroids config schema ${category} --json`
      : `steroids config schema --json`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    return JSON.parse(output);
  } catch (error) {
    console.error('Failed to get schema:', error);
    return null;
  }
}

/**
 * Get global config path
 */
function getGlobalConfigPath(): string {
  return join(homedir(), STEROIDS_DIR, CONFIG_FILE);
}

/**
 * Get project config path
 */
function getProjectConfigPath(projectPath: string): string {
  return join(projectPath, STEROIDS_DIR, CONFIG_FILE);
}

/**
 * Load config from file
 */
function loadConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parse(content) ?? {};
  } catch (error) {
    console.error(`Failed to load config from ${filePath}:`, error);
    return {};
  }
}

/**
 * Save config to file
 */
function saveConfigFile(filePath: string, config: Record<string, unknown>): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = stringify(config, { indent: 2 });
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Deep merge two objects
 */
function mergeConfigs(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const baseValue = base[key];
    const overrideValue = override[key];

    if (
      baseValue !== null &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue) &&
      overrideValue !== null &&
      typeof overrideValue === 'object' &&
      !Array.isArray(overrideValue)
    ) {
      result[key] = mergeConfigs(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>
      );
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

/**
 * Set a nested value in config object
 */
function setConfigValue(config: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(config));
  const parts = path.split('.');
  let current: Record<string, unknown> = result;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
  return result;
}

// GET /api/config/schema - Get full configuration schema
router.get('/config/schema', (req: Request, res: Response) => {
  const schema = getSchema();
  if (!schema) {
    return res.status(500).json({
      success: false,
      error: 'Failed to load schema',
    });
  }
  res.json({
    success: true,
    data: schema,
  });
});

// GET /api/config/schema/:category - Get schema for a specific category
router.get('/config/schema/:category', (req: Request, res: Response) => {
  const { category } = req.params;
  const schema = getSchema(category);
  if (!schema) {
    return res.status(404).json({
      success: false,
      error: `Category not found: ${category}`,
    });
  }
  res.json({
    success: true,
    data: schema,
  });
});

// GET /api/config - Get configuration values
router.get('/config', (req: Request, res: Response) => {
  const scope = req.query.scope as string || 'merged';
  const projectPath = req.query.project as string;

  try {
    let config: Record<string, unknown>;

    if (scope === 'global') {
      config = loadConfigFile(getGlobalConfigPath());
    } else if (scope === 'project') {
      if (!projectPath) {
        return res.status(400).json({
          success: false,
          error: 'Project path required for project scope',
        });
      }
      config = loadConfigFile(getProjectConfigPath(projectPath));
    } else {
      // Merged: global + project
      const globalConfig = loadConfigFile(getGlobalConfigPath());
      if (projectPath) {
        const projectConfig = loadConfigFile(getProjectConfigPath(projectPath));
        config = mergeConfigs(globalConfig, projectConfig);
      } else {
        config = globalConfig;
      }
    }

    res.json({
      success: true,
      data: {
        scope,
        project: projectPath || null,
        config,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load config',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// PUT /api/config - Update configuration values
router.put('/config', (req: Request, res: Response) => {
  const { scope, project, updates } = req.body as {
    scope?: 'global' | 'project';
    project?: string;
    updates: Record<string, unknown>;
  };

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'Updates object required',
    });
  }

  const targetScope = scope || 'global';

  try {
    let configPath: string;

    if (targetScope === 'project') {
      if (!project) {
        return res.status(400).json({
          success: false,
          error: 'Project path required for project scope',
        });
      }
      configPath = getProjectConfigPath(project);
    } else {
      configPath = getGlobalConfigPath();
    }

    // Load existing config
    let config = loadConfigFile(configPath);

    // Apply updates
    for (const [path, value] of Object.entries(updates)) {
      config = setConfigValue(config, path, value);
    }

    // Save config
    saveConfigFile(configPath, config);

    res.json({
      success: true,
      data: {
        scope: targetScope,
        project: project || null,
        path: configPath,
        updates,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to save config',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Claude CLI alias models — always valid regardless of API key availability
const CLAUDE_ALIAS_MODELS: APIModel[] = [
  { id: 'opus', name: 'Claude Opus (latest)' },
  { id: 'sonnet', name: 'Claude Sonnet (latest)' },
  { id: 'haiku', name: 'Claude Haiku (latest)' },
];

// Static model lists for each provider (fallback when API key present but API call fails)
const FALLBACK_MODELS: Record<string, APIModel[]> = {
  claude: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)' },
  ],
  codex: [
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  mistral: [
    { id: 'pixtral-large-latest', name: 'Pixtral Large' },
    { id: 'devstral-2', name: 'Devstral (Le Chat)' },
    { id: 'devstral-small', name: 'Devstral Small (Le Chat)' },
    { id: 'mistral-large-latest', name: 'Mistral Large (latest)' },
    { id: 'mistral-medium-latest', name: 'Mistral Medium (latest)' },
    { id: 'mistral-small-latest', name: 'Mistral Small (latest)' },
    { id: 'ministral-8b-latest', name: 'Ministral 8B (latest)' },
  ],
};

// CLI config file paths
const CLI_CONFIG_PATHS = {
  claude: join(homedir(), '.claude', '.credentials.json'),
  gemini: join(homedir(), '.gemini', 'oauth_creds.json'),
  codex: join(homedir(), '.codex', 'auth.json'),
  codexModelsCache: join(homedir(), '.codex', 'models_cache.json'),
};

/**
 * Get Claude API key
 * Note: CLI OAuth tokens (sk-ant-oat01-*) don't work with /v1/models endpoint
 * Only real API keys (sk-ant-api-*) work, so we check env vars
 */
function getClaudeApiKey(): string | null {
  // Check environment variable first (real API key)
  const envKey = process.env.STEROIDS_ANTHROPIC;
  if (envKey && envKey.startsWith('sk-ant-api')) {
    return envKey;
  }
  return null;
}

/**
 * Get Gemini API key
 * Note: CLI OAuth tokens don't have the right scope for generativelanguage API
 * Only API keys work, so we check env vars
 */
function getGeminiApiKey(): string | null {
  // Check environment variables (real API key)
  return process.env.STEROIDS_GOOGLE || null;
}

/**
 * Get Mistral API key
 */
function getMistralApiKey(): string | null {
  return process.env.STEROIDS_MISTRAL || null;
}

/**
 * Read Codex CLI OAuth token
 */
function getCodexToken(): string | null {
  try {
    if (!existsSync(CLI_CONFIG_PATHS.codex)) return null;
    const data = JSON.parse(readFileSync(CLI_CONFIG_PATHS.codex, 'utf-8'));
    return data?.tokens?.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Read Codex models from local cache file
 */
function getCodexModelsFromCache(): APIModel[] | null {
  try {
    if (!existsSync(CLI_CONFIG_PATHS.codexModelsCache)) return null;
    const data = JSON.parse(readFileSync(CLI_CONFIG_PATHS.codexModelsCache, 'utf-8'));
    if (!data?.models?.length) return null;
    return data.models
      .filter((m: { visibility?: string }) => m.visibility === 'list')
      .map((m: { slug: string; display_name?: string; description?: string }) => ({
        id: m.slug,
        name: m.display_name || m.slug,
        description: m.description,
      }));
  } catch {
    return null;
  }
}

/**
 * Fetch Claude models from Anthropic API
 * Note: Only works with real API keys, not CLI OAuth tokens.
 * Without an API key we return only the 3 CLI aliases (opus/sonnet/haiku) because
 * those are always valid regardless of the installed Claude CLI version.
 */
async function fetchClaudeModels(): Promise<{ models: APIModel[]; source: string }> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) {
    return { models: CLAUDE_ALIAS_MODELS, source: 'aliases' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      return { models: FALLBACK_MODELS.claude, source: 'fallback' };
    }

    const data = await response.json() as { data: Array<{ id: string; display_name?: string }> };
    const models: APIModel[] = data.data.map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
    }));

    // Sort: opus first, then sonnet, then haiku
    models.sort((a, b) => {
      const getScore = (id: string) => {
        if (id.includes('opus')) return 0;
        if (id.includes('sonnet')) return 1;
        if (id.includes('haiku')) return 2;
        return 3;
      };
      return getScore(a.id) - getScore(b.id);
    });

    return { models, source: 'api' };
  } catch {
    return { models: FALLBACK_MODELS.claude, source: 'fallback' };
  }
}

/**
 * Fetch Gemini models from Google API
 * Note: Only works with API keys, not CLI OAuth tokens
 */
async function fetchGeminiModels(): Promise<{ models: APIModel[]; source: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { models: FALLBACK_MODELS.gemini, source: 'fallback' };
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return { models: FALLBACK_MODELS.gemini, source: 'fallback' };
    }

    const data = await response.json() as {
      models: Array<{
        name: string;
        displayName?: string;
        description?: string;
        supportedGenerationMethods?: string[];
      }>;
    };

    const models: APIModel[] = data.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('gemini'))
      .map((m) => ({
        id: m.name.replace('models/', ''),
        name: m.displayName || m.name.replace('models/', ''),
        description: m.description,
      }));

    // Sort by version (newer first)
    models.sort((a, b) => {
      const getScore = (id: string) => {
        if (id.includes('3')) return 0;
        if (id.includes('2.5')) return 1;
        if (id.includes('2.0')) return 2;
        if (id.includes('1.5')) return 3;
        return 4;
      };
      return getScore(a.id) - getScore(b.id);
    });

    return { models, source: 'api' };
  } catch {
    return { models: FALLBACK_MODELS.gemini, source: 'fallback' };
  }
}

/**
 * Fetch Mistral models from Mistral API
 */
async function fetchMistralModels(): Promise<{ models: APIModel[]; source: string }> {
  const apiKey = getMistralApiKey();
  if (!apiKey) {
    return { models: FALLBACK_MODELS.mistral, source: 'fallback' };
  }

  try {
    const response = await fetch('https://api.mistral.ai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      return { models: FALLBACK_MODELS.mistral, source: 'fallback' };
    }

    const data = await response.json() as
      | { data?: Array<{ id: string; name?: string; description?: string; max_context_length?: number; capabilities?: { completion_chat?: boolean; function_calling?: boolean } }> }
      | Array<{ id: string; name?: string; description?: string; max_context_length?: number; capabilities?: { completion_chat?: boolean; function_calling?: boolean } }>;

    const rawModels = Array.isArray(data) ? data : (data.data ?? []);
    const modelById = new Map<string, APIModel>();
    for (const m of rawModels) {
      // Skip non-chat models (embeddings, OCR, moderation, audio-only)
      if (!m.capabilities?.completion_chat) continue;

      const mapped: APIModel = {
        id: m.id,
        name: m.name || formatMistralModelName(m.id),
        description: m.description,
        contextWindow: m.max_context_length,
      };

      if (!modelById.has(mapped.id)) {
        modelById.set(mapped.id, mapped);
      }
    }

    const models = dedupeMistralModels([...modelById.values()]);

    models.sort((a, b) => {
      const aScore = getMistralModelScore(a.id);
      const bScore = getMistralModelScore(b.id);
      if (aScore !== bScore) return aScore - bScore;
      return a.id.localeCompare(b.id);
    });

    return { models, source: 'api' };
  } catch {
    return { models: FALLBACK_MODELS.mistral, source: 'fallback' };
  }
}

function formatMistralModelName(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getMistralModelScore(id: string): number {
  if (id.includes('vibe-cli')) return 0;
  if (id.includes('devstral') || id.includes('codestral')) return 1;
  if (id.includes('mistral-large')) return 2;
  if (id.includes('mistral-medium')) return 3;
  if (id.includes('mistral-small')) return 4;
  if (id.includes('ministral')) return 5;
  return 6;
}

function dedupeMistralModels(models: APIModel[]): APIModel[] {
  const byName = new Map<string, APIModel>();

  for (const model of models) {
    // vibe-cli aliases are explicit routing targets — always keep them separate
    if (model.id.includes('vibe-cli')) {
      byName.set(model.id, model);
      continue;
    }
    const key = (model.name || model.id).trim().toLowerCase();
    const existing = byName.get(key);

    if (!existing || preferMistralModel(model, existing)) {
      byName.set(key, model);
    }
  }

  return [...byName.values()];
}

function preferMistralModel(candidate: APIModel, existing: APIModel): boolean {
  const score = (model: APIModel): number => {
    let value = 0;
    if (model.id.includes('latest')) value += 10;
    if (model.id.endsWith('-latest')) value += 5;
    if (model.name?.toLowerCase().includes('latest')) value += 1;
    return value;
  };

  const candidateScore = score(candidate);
  const existingScore = score(existing);

  if (candidateScore !== existingScore) {
    return candidateScore > existingScore;
  }

  return candidate.id.localeCompare(existing.id) < 0;
}

/**
 * Fetch Codex models - uses local cache or OpenAI API
 */
async function fetchCodexModels(): Promise<{ models: APIModel[]; source: string }> {
  // First try local cache (faster, always up to date from CLI)
  const cachedModels = getCodexModelsFromCache();
  if (cachedModels?.length) {
    return { models: cachedModels, source: 'cache' };
  }

  // Fall back to API if no cache
  const token = getCodexToken();
  if (!token) {
    return { models: FALLBACK_MODELS.codex, source: 'fallback' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { models: FALLBACK_MODELS.codex, source: 'fallback' };
    }

    const data = await response.json() as { data: Array<{ id: string }> };
    const models: APIModel[] = data.data
      .filter((m) => m.id.includes('gpt') || m.id.startsWith('o'))
      .map((m) => ({
        id: m.id,
        name: m.id,
      }));

    return { models, source: 'api' };
  } catch {
    return { models: FALLBACK_MODELS.codex, source: 'fallback' };
  }
}

// GET /api/ai/models/:provider - Get models for a provider
// Tries CLI config credentials first, falls back to static list
router.get('/ai/models/:provider', async (req: Request, res: Response) => {
  const { provider } = req.params;

  if (!FALLBACK_MODELS[provider]) {
    return res.status(400).json({
      success: false,
      error: `Unknown provider: ${provider}`,
    });
  }

  let result: { models: APIModel[]; source: string };

  switch (provider) {
    case 'claude':
      result = await fetchClaudeModels();
      break;
    case 'gemini':
      result = await fetchGeminiModels();
      break;
    case 'mistral':
      result = await fetchMistralModels();
      break;
    case 'codex':
      result = await fetchCodexModels();
      break;
    default:
      result = { models: FALLBACK_MODELS[provider], source: 'fallback' };
  }

  res.json({
    success: true,
    provider,
    source: result.source,
    models: result.models,
  });
});

/**
 * Check if a CLI tool is installed
 */
function isCliInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// GET /api/ai/providers - Get list of available providers
router.get('/ai/providers', (req: Request, res: Response) => {
  // Codex and Mistral depend on local CLIs
  const providers = [
    {
      id: 'claude',
      name: 'Anthropic (claude)',
      installed: isCliInstalled('claude'),
    },
    {
      id: 'gemini',
      name: 'Google (gemini)',
      installed: isCliInstalled('gemini'),
    },
    {
      id: 'mistral',
      name: 'Mistral (vibe)',
      installed: isCliInstalled('vibe'),
    },
    {
      id: 'codex',
      name: 'OpenAI (codex)',
      installed: isCliInstalled('codex'),
    },
  ];

  res.json({
    success: true,
    providers,
  });
});

// POST /api/custom/test - Test a custom endpoint server-side (bypasses CORS)
// Supports OpenAI-style (/v1/models) and Anthropic-style (/v1/messages) APIs
router.post('/custom/test', async (req: Request, res: Response) => {
  const { baseUrl, token } = req.body as { baseUrl?: string; token?: string };

  if (!baseUrl || !token) {
    return res.status(400).json({ success: false, error: 'baseUrl and token are required' });
  }

  const base = baseUrl.trim().replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${token.trim()}`,
    'Content-Type': 'application/json',
  };

  // OpenAI-style: GET /v1/models — 200 means models endpoint; 404 means path doesn't exist, fall through
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await r.text().catch(() => '');
    const parsed = body ? (() => { try { return JSON.parse(body); } catch { return null; } })() : null;
    if (r.ok) {
      return res.json({ reachable: true, status: r.status, path: '/v1/models', summary: `${r.status} — OpenAI /v1/models reachable`, body: parsed });
    }
    if (r.status !== 404) {
      // Non-404 non-OK (e.g. 401, 403) — endpoint exists but something rejected the call
      return res.json({ reachable: false, status: r.status, path: '/v1/models', summary: `${r.status} — OpenAI /v1/models responded`, body: parsed });
    }
    // 404 — try next endpoint
  } catch { /* try next */ }

  // Anthropic-style: POST /v1/messages — any non-5xx response means the endpoint exists
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await r.text().catch(() => '');
    const parsed = body ? (() => { try { return JSON.parse(body); } catch { return null; } })() : null;
    if (r.ok) {
      return res.json({ reachable: true, status: r.status, path: '/v1/messages', summary: `${r.status} — Anthropic /v1/messages reachable`, body: parsed });
    }
    if (r.status < 500) {
      return res.json({ reachable: false, status: r.status, path: '/v1/messages', summary: `${r.status} — Anthropic /v1/messages responded`, body: parsed });
    }
  } catch { /* try next */ }

  // All attempts failed
  return res.json({
    reachable: false,
    message: 'Endpoint unreachable — check base URL and token',
  });
});

export default router;
