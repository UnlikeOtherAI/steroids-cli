import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids config - Manage configuration
 */

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { stringify } from 'yaml';
import {
  loadConfig,
  loadConfigFile,
  saveConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  getConfigValue,
  setConfigValue,
  DEFAULT_CONFIG,
  type SteroidsConfig,
} from '../config/loader.js';
import {
  validateConfig,
  formatValidationResult,
  parseValue,
  validateValue,
} from '../config/validator.js';
import { getCategories, getCategoryDescription } from '../config/schema.js';
import { toJsonSchema, getCategoryJsonSchema, getSchemaCategories } from '../config/json-schema.js';
import { runBrowser } from '../config/browser.js';
import { runAISetup, quickAISetup } from '../config/ai-setup.js';
import { fetchModelsForProvider, hasApiKey, getApiKeyEnvVar } from '../providers/api-models.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'config',
  description: 'Manage configuration',
  details: 'Create, view, edit, and validate Steroids configuration files. Supports both global (~/.steroids/) and project-level (.steroids/) configs with hierarchical merging.',
  usage: [
    'steroids config <subcommand> [options]',
  ],
  subcommands: [
    { name: 'init', description: 'Create configuration file' },
    { name: 'show', args: '[key]', description: 'Display merged configuration or specific nested value' },
    { name: 'get', args: '<key>', description: 'Get a configuration value' },
    { name: 'set', args: '<key> <value>', description: 'Set a configuration value' },
    { name: 'schema', args: '[category]', description: 'Output configuration schema as JSON Schema' },
    { name: 'validate', description: 'Validate configuration syntax' },
    { name: 'path', description: 'Show configuration file paths' },
    { name: 'edit', description: 'Open config in $EDITOR' },
    { name: 'browse', description: 'Interactive configuration browser' },
    { name: 'ai', args: '[role]', description: 'Interactive AI provider/model setup' },
    { name: 'models', args: '<provider>', description: 'List available models from API' },
  ],
  options: [
    { long: 'template', description: 'Config template (init)', values: 'minimal | standard | full', default: 'standard' },
    { long: 'global', description: 'Use global config (~/.steroids/)' },
    { long: 'local', description: 'Use project config (.steroids/)' },
    { long: 'force', description: 'Overwrite existing config (init)' },
  ],
  examples: [
    { command: 'steroids config init', description: 'Create standard config' },
    { command: 'steroids config init --template minimal', description: 'Minimal config (AI only)' },
    { command: 'steroids config init --global', description: 'Create global config' },
    { command: 'steroids config show', description: 'Show merged config' },
    { command: 'steroids config show quality.tests', description: 'Show specific nested value' },
    { command: 'steroids config get ai.coder.model', description: 'Get value' },
    { command: 'steroids config set ai.coder.model opus', description: 'Set value' },
    { command: 'steroids config set output.colors false --global', description: 'Set in global config' },
    { command: 'steroids config validate', description: 'Validate config' },
    { command: 'steroids config path', description: 'Show file paths' },
    { command: 'steroids config edit', description: 'Open in editor' },
    { command: 'steroids config schema', description: 'Output full schema' },
    { command: 'steroids config schema ai', description: 'Output AI category schema' },
    { command: 'steroids config ai', description: 'Interactive AI setup wizard' },
    { command: 'steroids config ai coder', description: 'Configure coder role' },
    { command: 'steroids config models claude', description: 'List Claude models from API' },
  ],
  related: [
    { command: 'steroids init', description: 'Initialize steroids in project' },
  ],
});

export async function configCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'init':
      await runInit(subArgs);
      break;
    case 'show':
      await runShow(subArgs);
      break;
    case 'get':
      await runGet(subArgs);
      break;
    case 'set':
      await runSet(subArgs);
      break;
    case 'schema':
      await runSchema(subArgs);
      break;
    case 'validate':
      await runValidate(subArgs);
      break;
    case 'path':
      await runPath(subArgs);
      break;
    case 'edit':
      await runEdit(subArgs);
      break;
    case 'browse':
      await runBrowser();
      break;
    case 'ai':
      await runAI(subArgs, flags);
      break;
    case 'models':
      await runModels(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function runInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      template: { type: 'string', default: 'standard' },
      global: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids config init - Create configuration file

USAGE:
  steroids config init [options]

OPTIONS:
  --template <name>   minimal | standard | full (default: standard)
  --global            Create in ~/.steroids/
  --force             Overwrite existing config
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const configPath = values.global ? getGlobalConfigPath() : getProjectConfigPath();

  if (existsSync(configPath) && !values.force) {
    console.error(`Config already exists: ${configPath}`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  let config: Partial<SteroidsConfig>;

  switch (values.template) {
    case 'minimal':
      config = {
        ai: {
          coder: { provider: 'claude', model: 'claude-sonnet-4' },
          reviewer: { provider: 'claude', model: 'claude-sonnet-4' },
        },
      };
      break;
    case 'full':
      config = DEFAULT_CONFIG;
      break;
    case 'standard':
    default:
      config = {
        ai: {
          coder: { provider: 'claude', model: 'claude-sonnet-4' },
          reviewer: { provider: 'claude', model: 'claude-sonnet-4' },
        },
        output: { format: 'table', colors: true },
        git: { autoPush: true, remote: 'origin', branch: 'main' },
        runners: { heartbeatInterval: '30s', staleTimeout: '5m' },
      };
  }

  // Ensure directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  saveConfig(config, configPath);

  if (values.json) {
    console.log(JSON.stringify({ created: configPath, template: values.template }));
  } else {
    console.log(`Created config: ${configPath}`);
    console.log(`Template: ${values.template}`);
  }
}

async function runShow(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      global: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids config show - Display configuration

USAGE:
  steroids config show [key] [options]

ARGUMENTS:
  [key]               Optional nested path (e.g., quality.tests)

OPTIONS:
  --global            Show only global config
  --local             Show only project config
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids config show                    # Show all config
  steroids config show quality.tests      # Show specific nested value
  steroids config show --json             # Show all as JSON
`);
    return;
  }

  let config: Partial<SteroidsConfig>;

  if (values.global) {
    config = loadConfigFile(getGlobalConfigPath());
  } else if (values.local) {
    config = loadConfigFile(getProjectConfigPath());
  } else {
    config = loadConfig();
  }

  // If a key path is provided, show only that nested value
  let displayValue: unknown = config;
  if (positionals.length > 0) {
    const key = positionals[0];
    displayValue = getConfigValue(config as SteroidsConfig, key);

    if (displayValue === undefined) {
      console.error(`Key not found: ${key}`);
      process.exit(1);
    }
  }

  if (values.json) {
    console.log(JSON.stringify(displayValue, null, 2));
  } else {
    if (typeof displayValue === 'object' && displayValue !== null) {
      console.log(stringify(displayValue, { indent: 2 }));
    } else {
      console.log(String(displayValue));
    }
  }
}

async function runGet(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids config get <key> - Get configuration value

USAGE:
  steroids config get <key> [options]

EXAMPLES:
  steroids config get ai.coder.model
  steroids config get output.format
  steroids config get runners.heartbeatInterval
`);
    return;
  }

  const key = positionals[0];
  const config = loadConfig();
  const value = getConfigValue(config, key);

  if (value === undefined) {
    console.error(`Key not found: ${key}`);
    process.exit(1);
  }

  if (values.json) {
    console.log(JSON.stringify({ key, value }));
  } else {
    if (typeof value === 'object') {
      console.log(stringify(value, { indent: 2 }));
    } else {
      console.log(String(value));
    }
  }
}

async function runSet(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      global: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 2) {
    console.log(`
steroids config set <key> <value> - Set configuration value

USAGE:
  steroids config set <key> <value> [options]

OPTIONS:
  --global            Set in global config
  --local             Set in project config (default)

EXAMPLES:
  steroids config set ai.coder.model claude-opus-4
  steroids config set output.colors false
  steroids config set webui.port 8080
`);
    return;
  }

  const key = positionals[0];
  const rawValue = positionals.slice(1).join(' ');

  // Parse value to correct type
  const value = parseValue(key, rawValue);

  // Validate value
  const error = validateValue(key, value);
  if (error) {
    console.error(`Invalid value: ${error.message}`);
    if (error.suggestion) {
      console.error(`  → ${error.suggestion}`);
    }
    process.exit(1);
  }

  const configPath = values.global ? getGlobalConfigPath() : getProjectConfigPath();
  const existingConfig = loadConfigFile(configPath);
  const newConfig = setConfigValue(existingConfig as SteroidsConfig, key, value);

  saveConfig(newConfig, configPath);

  if (values.json) {
    console.log(JSON.stringify({ key, value, path: configPath }));
  } else {
    console.log(`Set ${key} = ${JSON.stringify(value)}`);
    console.log(`Saved to: ${configPath}`);
  }
}

async function runValidate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids config validate - Validate configuration

USAGE:
  steroids config validate [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const config = loadConfig();
  const result = validateConfig(config);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatValidationResult(result));
  }

  if (!result.valid) {
    process.exit(1);
  }
}

async function runPath(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids config path - Show configuration file paths

USAGE:
  steroids config path [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const globalPath = getGlobalConfigPath();
  const projectPath = getProjectConfigPath();

  const paths = {
    global: {
      path: globalPath,
      exists: existsSync(globalPath),
    },
    project: {
      path: projectPath,
      exists: existsSync(projectPath),
    },
  };

  if (values.json) {
    console.log(JSON.stringify(paths, null, 2));
  } else {
    console.log('Configuration Paths:');
    console.log('');
    console.log(`  Global:  ${globalPath}`);
    console.log(`           ${paths.global.exists ? '(exists)' : '(not found)'}`);
    console.log('');
    console.log(`  Project: ${projectPath}`);
    console.log(`           ${paths.project.exists ? '(exists)' : '(not found)'}`);
  }
}

async function runEdit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      global: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids config edit - Open config in editor

USAGE:
  steroids config edit [options]

OPTIONS:
  --global            Edit global config
  --local             Edit project config (default)
  -h, --help          Show help
`);
    return;
  }

  const configPath = values.global ? getGlobalConfigPath() : getProjectConfigPath();

  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error('Run "steroids config init" first.');
    process.exit(1);
  }

  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';

  try {
    execSync(`${editor} "${configPath}"`, { stdio: 'inherit' });
  } catch (error) {
    console.error(`Failed to open editor: ${editor}`);
    process.exit(1);
  }
}

async function runSchema(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids config schema - Output configuration schema

USAGE:
  steroids config schema [category] [options]

ARGUMENTS:
  [category]          Optional category to show (ai, git, runners, etc.)

OPTIONS:
  -h, --help          Show help

EXAMPLES:
  steroids config schema              # Full schema as JSON
  steroids config schema ai           # AI category only
  steroids config schema --help       # Show available categories

CATEGORIES:
${getSchemaCategories().map(c => `  ${c}`).join('\n')}
`);
    return;
  }

  // If a category is specified, show just that category
  if (positionals.length > 0) {
    const category = positionals[0];
    const categorySchema = getCategoryJsonSchema(category);

    if (!categorySchema) {
      console.error(`Unknown category: ${category}`);
      console.error('');
      console.error('Available categories:');
      getSchemaCategories().forEach(c => console.error(`  ${c}`));
      process.exit(1);
    }

    console.log(JSON.stringify(categorySchema, null, 2));
    return;
  }

  // Output full schema
  const schema = toJsonSchema();
  console.log(JSON.stringify(schema, null, 2));
}

async function runAI(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      global: { type: 'boolean', default: false },
      provider: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    console.log(`
steroids config ai - Interactive AI provider and model setup

USAGE:
  steroids config ai [role] [options]

ARGUMENTS:
  [role]              Role to configure: coder | reviewer | orchestrator

OPTIONS:
  -p, --provider      Provider (claude | openai | gemini) - skip interactive selection
  -m, --model         Model ID - skip interactive selection
  --global            Save to global config
  -h, --help          Show help

EXAMPLES:
  steroids config ai                              # Interactive setup wizard
  steroids config ai coder                        # Configure coder role
  steroids config ai coder -p claude -m sonnet    # Non-interactive setup
  steroids config ai reviewer --global            # Configure reviewer in global config

ENVIRONMENT VARIABLES:
  ANTHROPIC_API_KEY   Required for Claude models
  OPENAI_API_KEY      Required for OpenAI models
  GOOGLE_API_KEY      Required for Gemini models (or GEMINI_API_KEY)
`);
    return;
  }

  const role = positionals[0] as 'coder' | 'reviewer' | 'orchestrator' | undefined;

  if (role && !['coder', 'reviewer', 'orchestrator'].includes(role)) {
    console.error(`Invalid role: ${role}`);
    console.error('Valid roles: coder, reviewer, orchestrator');
    process.exit(1);
  }

  if (values.provider) {
    const provider = values.provider as 'claude' | 'openai' | 'gemini';
    if (!['claude', 'openai', 'gemini'].includes(provider)) {
      console.error(`Invalid provider: ${provider}`);
      console.error('Valid providers: claude, openai, gemini');
      process.exit(1);
    }

    const result = await quickAISetup({
      role: role ?? 'coder',
      provider,
      model: values.model,
      global: values.global,
    });

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    console.log('✓ Configuration saved');
    return;
  }

  await runAISetup({ role, global: values.global });
}

async function runModels(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    console.log(`
steroids config models - List available models from provider API

USAGE:
  steroids config models <provider> [options]

ARGUMENTS:
  <provider>          Provider to query: claude | openai | gemini

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids config models claude           # List Claude models
  steroids config models openai --json    # List OpenAI models as JSON
  steroids config models gemini           # List Gemini models

ENVIRONMENT VARIABLES:
  ANTHROPIC_API_KEY   Required for Claude
  OPENAI_API_KEY      Required for OpenAI
  GOOGLE_API_KEY      Required for Gemini (or GEMINI_API_KEY)
`);
    return;
  }

  if (positionals.length === 0) {
    console.error('Provider is required');
    console.error('Usage: steroids config models <claude|openai|gemini>');
    process.exit(2);
  }

  const provider = positionals[0] as 'claude' | 'openai' | 'gemini';

  if (!['claude', 'openai', 'gemini'].includes(provider)) {
    console.error(`Invalid provider: ${provider}`);
    console.error('Valid providers: claude, openai, gemini');
    process.exit(2);
  }

  if (!hasApiKey(provider)) {
    console.error(`${getApiKeyEnvVar(provider)} environment variable not set`);
    process.exit(1);
  }

  console.error(`Fetching models from ${provider}...`);

  const result = await fetchModelsForProvider(provider);

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  if (result.models.length === 0) {
    console.log('No models found');
    return;
  }

  if (values.json) {
    console.log(JSON.stringify(result.models, null, 2));
  } else {
    console.log('');
    console.log(`Available ${provider} models:`);
    console.log('');
    for (const model of result.models) {
      const ctx = model.contextWindow
        ? ` (${(model.contextWindow / 1000).toFixed(0)}k ctx)`
        : '';
      console.log(`  ${model.id}`);
      console.log(`    ${model.name}${ctx}`);
    }
    console.log('');
    console.log(`Total: ${result.models.length} models`);
  }
}
