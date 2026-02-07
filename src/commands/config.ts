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
import { runBrowser } from '../config/browser.js';

const HELP = `
steroids config - Manage configuration

USAGE:
  steroids config <subcommand> [options]

SUBCOMMANDS:
  init              Create configuration file
  show              Display merged configuration
  get <key>         Get a configuration value
  set <key> <value> Set a configuration value
  validate          Validate configuration syntax
  path              Show configuration file paths
  edit              Open config in $EDITOR

INIT OPTIONS:
  --template <name>   Template: minimal | standard | full (default: standard)
  --global            Create in ~/.steroids/ instead of project
  --force             Overwrite existing config

SHOW OPTIONS:
  --global            Show only global config
  --local             Show only project config

SET OPTIONS:
  --global            Set in global config
  --local             Set in project config (default)

EDIT OPTIONS:
  --global            Edit global config
  --local             Edit project config (default)

GLOBAL OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids config init                           # Create standard config
  steroids config init --template minimal        # Minimal config (AI only)
  steroids config init --global                  # Create global config
  steroids config show                           # Show merged config
  steroids config show --json                    # As JSON
  steroids config get ai.coder.model             # Get value
  steroids config set ai.coder.model opus        # Set value
  steroids config set output.colors false --global
  steroids config validate                       # Validate config
  steroids config path                           # Show file paths
  steroids config edit                           # Open in editor
`;

export async function configCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
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
      template: { type: 'string', short: 't', default: 'standard' },
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
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      global: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids config show - Display configuration

USAGE:
  steroids config show [options]

OPTIONS:
  --global            Show only global config
  --local             Show only project config
  -j, --json          Output as JSON
  -h, --help          Show help
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

  if (values.json) {
    console.log(JSON.stringify(config, null, 2));
  } else {
    console.log(stringify(config, { indent: 2 }));
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
