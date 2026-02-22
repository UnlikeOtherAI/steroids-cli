/**
 * steroids ai - AI provider management and testing
 */

import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors, markers } from '../cli/colors.js';
import { generateHelp } from '../cli/help.js';
import { getProviderRegistry } from '../providers/registry.js';
import { runAISetup } from '../config/ai-setup.js';
import {
  fetchModelsForProvider,
  hasApiKey,
  getApiKeyEnvVar,
  getModelsForProvider,
  checkProviderCLI,
} from '../providers/api-models.js';
import { loadConfig } from '../config/loader.js';

const HELP = generateHelp({
  command: 'ai',
  description: 'AI provider management and testing',
  details: `Manage AI providers, detect installed CLIs, list available models, and test configurations.`,
  usage: ['steroids ai <subcommand> [options]'],
  subcommands: [
    { name: 'providers', description: 'List all detected AI providers' },
    { name: 'models', args: '<provider>', description: 'List available models for a provider' },
    { name: 'test', args: '<role>', description: 'Test provider configuration for a role' },
    { name: 'setup', args: '[role]', description: 'Run interactive setup wizard' },
  ],
  options: [
    { long: 'api', description: 'Fetch models from API (requires API key) (models)' },
    { long: 'global', description: 'Use global config (setup)' },
  ],
  examples: [
    { command: 'steroids ai providers', description: 'List all detected providers' },
    { command: 'steroids ai models claude', description: 'List Claude models from CLI' },
    { command: 'steroids ai models mistral --api', description: 'Fetch Mistral models from API' },
    { command: 'steroids ai test coder', description: 'Test coder provider configuration' },
    { command: 'steroids ai setup', description: 'Interactive setup wizard' },
    { command: 'steroids ai setup reviewer', description: 'Configure reviewer role' },
  ],
  related: [
    { command: 'steroids config ai', description: 'Alternative setup command' },
    { command: 'steroids config show ai', description: 'Show current AI config' },
  ],
});

export async function aiCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai', flags });

  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    out.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'providers':
      await providersSubcommand(subArgs, flags);
      break;
    case 'models':
      await modelsSubcommand(subArgs, flags);
      break;
    case 'test':
      await testSubcommand(subArgs, flags);
      break;
    case 'setup':
      await setupSubcommand(subArgs, flags);
      break;
    default:
      out.error('INVALID_ARGUMENTS', `Unknown subcommand: ${subcommand}`);
      out.log(HELP);
      process.exit(1);
  }
}

/**
 * steroids ai providers - List detected providers
 */
async function providersSubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai providers', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(`
steroids ai providers - List detected AI providers

USAGE:
  steroids ai providers [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help

DESCRIPTION:
  Detects which AI provider CLIs are installed and available.
  Shows CLI path and available models for each provider.
`);
    return;
  }

  const registry = await getProviderRegistry();
  const statuses = await registry.getStatus();

  if (flags.json) {
    out.success({ providers: statuses });
    return;
  }

  out.log('');
  out.log(colors.bold('Detected AI Providers:'));
  out.log('');

  for (const status of statuses) {
    const icon = status.available ? markers.success('') : markers.error('');
    const availText = status.available ? colors.green('available') : colors.red('not installed');

    out.log(`  ${icon} ${colors.bold(status.displayName)} (${status.name})`);
    out.log(`     Status: ${availText}`);

    if (status.cliPath) {
      out.log(`     CLI: ${colors.cyan(status.cliPath)}`);
    }

    if (status.models.length > 0) {
      out.log(`     Models: ${status.models.join(', ')}`);
    }

    out.log('');
  }

  const availableCount = statuses.filter((s) => s.available).length;
  out.log(`${availableCount} of ${statuses.length} providers available`);
  out.log('');
}

/**
 * steroids ai models - List models for a provider
 */
async function modelsSubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai models', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      api: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids ai models <provider> - List available models

USAGE:
  steroids ai models <provider> [options]

ARGUMENTS:
  <provider>          Provider name: claude | openai | gemini | codex | mistral

OPTIONS:
  --api               Fetch models from API (requires API key)
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids ai models claude              # List Claude models from CLI
  steroids ai models mistral --api       # Fetch Mistral models from API

ENVIRONMENT VARIABLES:
  STEROIDS_ANTHROPIC_API_KEY   Required for Claude API access
  STEROIDS_OPENAI_API_KEY      Required for OpenAI API access
  STEROIDS_GOOGLE_API_KEY      Required for Gemini API access
  STEROIDS_MISTRAL_API_KEY     Required for Mistral API access
`);
    return;
  }

  const provider = positionals[0];

  if (!['claude', 'openai', 'gemini', 'codex', 'mistral'].includes(provider)) {
    out.error('INVALID_ARGUMENTS', `Invalid provider: ${provider}`);
    out.log('Valid providers: claude, openai, gemini, codex, mistral');
    process.exit(2);
  }

  if (values.api) {
    // Fetch from API
    if (!['claude', 'openai', 'gemini', 'mistral'].includes(provider)) {
      out.error('INVALID_ARGUMENTS', `Provider ${provider} does not support API model fetching`);
      process.exit(2);
    }

    if (!hasApiKey(provider as 'claude' | 'openai' | 'gemini' | 'mistral')) {
      out.error('CONFIGURATION_ERROR', `${getApiKeyEnvVar(provider as 'claude' | 'openai' | 'gemini' | 'mistral')} environment variable not set`);
      process.exit(1);
    }

    out.verbose(`Fetching models from ${provider} API...`);

    const result = await fetchModelsForProvider(provider as 'claude' | 'openai' | 'gemini' | 'mistral');

    if (!result.success) {
      out.error('GENERAL_ERROR', `Failed to fetch models: ${result.error}`);
      process.exit(1);
    }

    if (flags.json) {
      out.success({ provider, models: result.models });
      return;
    }

    out.log('');
    out.log(colors.bold(`${provider} models (from API):`));
    out.log('');

    for (const model of result.models) {
      const ctx = model.contextWindow
        ? colors.dim(` (${(model.contextWindow / 1000).toFixed(0)}k ctx)`)
        : '';
      out.log(`  ${colors.cyan(model.id)}`);
      out.log(`    ${model.name}${ctx}`);
    }

    out.log('');
    out.log(`Total: ${result.models.length} models`);
  } else {
    // Get from CLI provider registry
    const models = await getModelsForProvider(provider as any);

    if (models.length === 0) {
      out.error('NOT_FOUND', `No models found for provider: ${provider}`);
      process.exit(1);
    }

    if (flags.json) {
      out.success({ provider, models });
      return;
    }

    out.log('');
    out.log(colors.bold(`${provider} models:`));
    out.log('');

    for (const model of models) {
      const recommended = model.recommendedFor && model.recommendedFor.length > 0
        ? colors.dim(` (recommended for: ${model.recommendedFor.join(', ')})`)
        : '';
      out.log(`  ${colors.cyan(model.id)}`);
      out.log(`    ${model.name}${recommended}`);
    }

    out.log('');
    out.log(`Total: ${models.length} models`);
  }

  out.log('');
}

/**
 * steroids ai test - Test provider configuration
 */
async function testSubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai test', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids ai test <role> - Test provider configuration

USAGE:
  steroids ai test <role> [options]

ARGUMENTS:
  <role>              Role to test: orchestrator | coder | reviewer

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help

DESCRIPTION:
  Tests the configured provider for a role by:
  1. Checking if the provider CLI is available
  2. Verifying the configured model is valid
  3. Checking API key if required

EXAMPLES:
  steroids ai test coder              # Test coder configuration
  steroids ai test reviewer           # Test reviewer configuration
`);
    return;
  }

  const role = positionals[0] as 'orchestrator' | 'coder' | 'reviewer';

  if (!['orchestrator', 'coder', 'reviewer'].includes(role)) {
    out.error('INVALID_ARGUMENTS', `Invalid role: ${role}`);
    out.log('Valid roles: orchestrator, coder, reviewer');
    process.exit(2);
  }

  const config = loadConfig();
  const roleConfig = config.ai?.[role];

  if (!roleConfig || !roleConfig.provider || !roleConfig.model) {
    out.error('CONFIGURATION_ERROR', `No provider configured for role: ${role}`);
    out.log(`Run "steroids ai setup ${role}" to configure`);
    process.exit(1);
  }

  const provider = roleConfig.provider;
  const model = roleConfig.model;

  out.verbose(`Testing ${role} configuration...`);
  out.verbose(`  Provider: ${provider}`);
  out.verbose(`  Model: ${model}`);
  out.log('');

  // Check if provider CLI is available
  const status = await checkProviderCLI(provider as 'claude' | 'openai' | 'gemini' | 'codex' | 'mistral');

  const results = {
    role,
    provider,
    model,
    cliAvailable: status.available,
    cliPath: status.cliPath,
    modelValid: status.models.includes(model),
    success: false,
  };

  if (!status.available) {
    if (flags.json) {
      out.error('CONFIGURATION_ERROR', 'Provider CLI not available', { ...results, error: 'Provider CLI not available' });
    } else {
      out.log(markers.error(`Provider CLI not available: ${provider}`));
      out.log(`Install the ${provider} CLI to use this provider`);
    }
    process.exit(1);
  }

  out.log(markers.success(`Provider CLI available: ${status.displayName}`));
  if (status.cliPath) {
    out.log(`  Path: ${colors.cyan(status.cliPath)}`);
  }
  out.log('');

  // Validate model
  if (!status.models.includes(model)) {
    if (flags.json) {
      out.error('CONFIGURATION_ERROR', 'Model not found in provider', { ...results, error: 'Model not found in provider' });
    } else {
      out.log(markers.error(`Model not valid: ${model}`));
      out.log(`Available models: ${status.models.join(', ')}`);
    }
    process.exit(1);
  }

  out.log(markers.success(`Model valid: ${model}`));
  out.log('');

  results.success = true;

  if (flags.json) {
    out.success(results);
  } else {
    out.log(markers.success(`Configuration valid for role: ${role}`));
    out.log('');
    out.log('Ready to use!');
  }

  out.log('');
}

/**
 * steroids ai setup - Run setup wizard
 */
async function setupSubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai setup', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      global: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    out.log(`
steroids ai setup [role] - Interactive setup wizard

USAGE:
  steroids ai setup [role] [options]

ARGUMENTS:
  [role]              Optional role: orchestrator | coder | reviewer

OPTIONS:
  --global            Save to global config
  -h, --help          Show help

DESCRIPTION:
  Runs the interactive AI provider setup wizard.
  Detects available providers and prompts for model selection.

EXAMPLES:
  steroids ai setup                    # Setup any role interactively
  steroids ai setup coder              # Setup coder role
  steroids ai setup reviewer --global  # Setup reviewer in global config
`);
    return;
  }

  const role = positionals[0] as 'orchestrator' | 'coder' | 'reviewer' | undefined;

  if (role && !['orchestrator', 'coder', 'reviewer'].includes(role)) {
    out.error('INVALID_ARGUMENTS', `Invalid role: ${role}`);
    out.log('Valid roles: orchestrator, coder, reviewer');
    process.exit(2);
  }

  await runAISetup({ role, global: values.global });
}
