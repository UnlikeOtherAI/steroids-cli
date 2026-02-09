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

// Static model lists for each provider (from official docs, Feb 2026)
const FALLBACK_MODELS: Record<string, APIModel[]> = {
  claude: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)' },
  ],
  codex: [
    { id: 'o3', name: 'O3' },
    { id: 'o4-mini', name: 'O4 Mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
  ],
};

// GET /api/ai/models/:provider - Get models for a provider
// Returns static model lists - no API keys needed
router.get('/ai/models/:provider', (req: Request, res: Response) => {
  const { provider } = req.params;

  const models = FALLBACK_MODELS[provider];
  if (!models) {
    return res.status(400).json({
      success: false,
      error: `Unknown provider: ${provider}`,
    });
  }

  res.json({
    success: true,
    provider,
    source: 'static',
    models,
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
