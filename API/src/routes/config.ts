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

interface FetchModelsResult {
  success: boolean;
  models: APIModel[];
  error?: string;
  source: 'api' | 'fallback';
}

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

const STEROIDS_DIR = '.steroids';
const CONFIG_FILE = 'config.yaml';

/**
 * Get config schema by running CLI command
 * Uses node directly with the built CLI to avoid PATH issues
 */
function getSchema(category?: string): object | null {
  try {
    // Get path to the CLI dist directory
    // When running from API/dist/API/src/routes/config.js, we need to go up to project root
    const cliPath = join(__dirname, '..', '..', '..', '..', '..', 'dist', 'index.js');
    const cmd = category
      ? `node "${cliPath}" config schema ${category}`
      : `node "${cliPath}" config schema`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
    return JSON.parse(output);
  } catch (error) {
    console.error('Failed to get schema:', error);
    console.error('CLI path attempted:', join(__dirname, '..', '..', '..', '..', '..', 'dist', 'index.js'));
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

// Static model lists for each provider
const FALLBACK_MODELS: Record<string, APIModel[]> = {
  claude: [
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    { id: 'gemini-pro', name: 'Gemini Pro' },
  ],
  codex: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-4', name: 'GPT-4' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
    { id: 'o1', name: 'O1' },
    { id: 'o1-mini', name: 'O1 Mini' },
  ],
};

/**
 * Fetch models from Anthropic API
 */
async function fetchClaudeModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Return fallback models if no API key (no error shown)
  if (!apiKey) {
    return { success: true, models: FALLBACK_MODELS.claude, source: 'fallback' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return { success: false, models: FALLBACK_MODELS.claude, error: `API error: ${response.status}`, source: 'fallback' };
    }

    const data = await response.json() as { data: Array<{ id: string; display_name?: string }> };
    const models: APIModel[] = data.data.map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
    }));

    // Sort by name, putting claude-4 and claude-3.5 first
    models.sort((a, b) => {
      const aScore = a.id.includes('claude-4') || a.id.includes('opus-4') || a.id.includes('sonnet-4') ? 0 : a.id.includes('claude-3-5') ? 1 : 2;
      const bScore = b.id.includes('claude-4') || b.id.includes('opus-4') || b.id.includes('sonnet-4') ? 0 : b.id.includes('claude-3-5') ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return a.name.localeCompare(b.name);
    });

    return { success: true, models, source: 'api' };
  } catch (error) {
    return { success: false, models: FALLBACK_MODELS.claude, error: error instanceof Error ? error.message : 'Unknown error', source: 'fallback' };
  }
}


/**
 * Fetch models from Google AI (Gemini) API
 */
async function fetchGeminiModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;

  // Return fallback models if no API key (no error shown)
  if (!apiKey) {
    return { success: true, models: FALLBACK_MODELS.gemini, source: 'fallback' };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!response.ok) {
      return { success: false, models: FALLBACK_MODELS.gemini, error: `API error: ${response.status}`, source: 'fallback' };
    }

    const data = await response.json() as {
      models: Array<{
        name: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };

    // Filter to generative models
    const generativeModels = data.models.filter(
      (m) =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('gemini')
    );

    const models: APIModel[] = generativeModels.map((m) => {
      const id = m.name.replace('models/', '');
      return {
        id,
        name: m.displayName ?? id,
        description: m.description,
        contextWindow: m.inputTokenLimit,
      };
    });

    // Sort by model tier
    models.sort((a, b) => {
      const aScore = a.id.includes('2.0') ? 0 : a.id.includes('1.5') ? 1 : a.id.includes('ultra') ? 2 : a.id.includes('pro') ? 3 : 4;
      const bScore = b.id.includes('2.0') ? 0 : b.id.includes('1.5') ? 1 : b.id.includes('ultra') ? 2 : b.id.includes('pro') ? 3 : 4;
      if (aScore !== bScore) return aScore - bScore;
      return a.name.localeCompare(b.name);
    });

    return { success: true, models, source: 'api' };
  } catch (error) {
    return { success: false, models: FALLBACK_MODELS.gemini, error: error instanceof Error ? error.message : 'Unknown error', source: 'fallback' };
  }
}

/**
 * Fetch models from OpenAI API (used by Codex)
 */
async function fetchCodexModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  // Return fallback models if no API key
  if (!apiKey) {
    return { success: true, models: FALLBACK_MODELS.codex, source: 'fallback' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return { success: false, models: FALLBACK_MODELS.codex, error: `API error: ${response.status}`, source: 'fallback' };
    }

    const data = await response.json() as { data: Array<{ id: string; created?: number }> };

    // Filter to chat models
    const chatModels = data.data.filter(
      (m) =>
        m.id.startsWith('gpt-4') ||
        m.id.startsWith('gpt-3.5') ||
        m.id.startsWith('o1') ||
        m.id.startsWith('o3')
    );

    const models: APIModel[] = chatModels.map((m) => ({
      id: m.id,
      name: formatOpenAIModelName(m.id),
    }));

    // Sort by model family
    models.sort((a, b) => {
      const aScore = getOpenAIModelScore(a.id);
      const bScore = getOpenAIModelScore(b.id);
      if (aScore !== bScore) return aScore - bScore;
      return a.id.localeCompare(b.id);
    });

    return { success: true, models, source: 'api' };
  } catch (error) {
    return { success: false, models: FALLBACK_MODELS.codex, error: error instanceof Error ? error.message : 'Unknown error', source: 'fallback' };
  }
}

function formatOpenAIModelName(id: string): string {
  if (id.startsWith('gpt-4o')) return `GPT-4o ${id.replace('gpt-4o', '').replace(/-/g, ' ').trim()}`.trim();
  if (id.startsWith('gpt-4-turbo')) return 'GPT-4 Turbo';
  if (id.startsWith('gpt-4')) return `GPT-4 ${id.replace('gpt-4', '').replace(/-/g, ' ').trim()}`.trim();
  if (id.startsWith('gpt-3.5-turbo')) return 'GPT-3.5 Turbo';
  if (id.startsWith('o1')) return `O1 ${id.replace('o1', '').replace(/-/g, ' ').trim()}`.trim();
  if (id.startsWith('o3')) return `O3 ${id.replace('o3', '').replace(/-/g, ' ').trim()}`.trim();
  return id;
}

function getOpenAIModelScore(id: string): number {
  if (id.startsWith('o3')) return 0;
  if (id.startsWith('o1')) return 1;
  if (id.startsWith('gpt-4o')) return 2;
  if (id.startsWith('gpt-4-turbo')) return 3;
  if (id.startsWith('gpt-4')) return 4;
  if (id.startsWith('gpt-3.5')) return 5;
  return 6;
}

// GET /api/ai/models/:provider - Get models for a provider
// Tries to fetch from API first, falls back to static list
router.get('/ai/models/:provider', async (req: Request, res: Response) => {
  const { provider } = req.params;

  // Check if provider is valid
  if (!FALLBACK_MODELS[provider]) {
    return res.status(400).json({
      success: false,
      error: `Unknown provider: ${provider}`,
    });
  }

  let result: FetchModelsResult;

  switch (provider) {
    case 'claude':
      result = await fetchClaudeModels();
      break;
    case 'gemini':
      result = await fetchGeminiModels();
      break;
    case 'codex':
      result = await fetchCodexModels();
      break;
    default:
      result = { success: true, models: FALLBACK_MODELS[provider], source: 'fallback' };
  }

  res.json({
    success: true,
    provider,
    source: result.source,
    models: result.models,
    ...(result.error && { error: result.error }),
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
  // Only codex has a CLI tool to check for
  const providers = [
    {
      id: 'claude',
      name: 'Claude (Anthropic)',
      installed: true, // Uses claude CLI or API
    },
    {
      id: 'gemini',
      name: 'Gemini (Google)',
      installed: true, // Uses API
    },
    {
      id: 'codex',
      name: 'Codex',
      installed: isCliInstalled('codex'),
    },
  ];

  res.json({
    success: true,
    providers,
  });
});

export default router;
