/**
 * Reviewer configuration API routes
 * Focused endpoint for saving ai.reviewer.customInstructions
 */

import { Router, Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';

const router = Router();

const STEROIDS_DIR = '.steroids';
const CONFIG_FILE = 'config.yaml';

function getGlobalConfigPath(): string {
  return join(homedir(), STEROIDS_DIR, CONFIG_FILE);
}

function getProjectConfigPath(projectPath: string): string {
  return join(projectPath, STEROIDS_DIR, CONFIG_FILE);
}

function loadConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parse(content) ?? {};
  } catch {
    return {};
  }
}

function saveConfigFile(filePath: string, config: Record<string, unknown>): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, stringify(config, { indent: 2 }), 'utf-8');
}

function setConfigValue(config: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(config));
  const parts = path.split('.');
  let current: Record<string, unknown> = result;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
  return result;
}

// PUT /api/config/reviewer-custom-instructions
// Body: { scope?: 'global' | 'project', project?: string, customInstructions: string }
router.put('/config/reviewer-custom-instructions', (req: Request, res: Response) => {
  const { scope, project, customInstructions } = req.body as {
    scope?: 'global' | 'project';
    project?: string;
    customInstructions?: string;
  };

  if (typeof customInstructions !== 'string') {
    res.status(400).json({
      success: false,
      error: 'customInstructions must be a string',
    });
    return;
  }

  const targetScope = scope ?? 'project';

  if (targetScope === 'project' && !project) {
    res.status(400).json({
      success: false,
      error: 'Project path required for project scope',
    });
    return;
  }

  try {
    const configPath = targetScope === 'project'
      ? getProjectConfigPath(project as string)
      : getGlobalConfigPath();

    const config = loadConfigFile(configPath);
    const updated = setConfigValue(config, 'ai.reviewer.customInstructions', customInstructions);
    saveConfigFile(configPath, updated);

    res.json({
      success: true,
      data: {
        scope: targetScope,
        project: project ?? null,
        path: configPath,
        customInstructions,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to save reviewer custom instructions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
