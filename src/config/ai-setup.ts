/**
 * Interactive AI Provider and Model Setup
 * Wizard for configuring AI providers with live model fetching from APIs
 */

import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import {
  fetchModelsForProvider,
  hasApiKey,
  getApiKeyEnvVar,
  type APIModel,
} from '../providers/api-models.js';
import {
  loadConfig,
  saveConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  type SteroidsConfig,
} from './loader.js';

type Provider = 'claude' | 'openai' | 'gemini' | 'mistral';
type Role = 'orchestrator' | 'coder' | 'reviewer';

interface SetupState {
  step: 'role' | 'provider' | 'model' | 'confirm' | 'done';
  role: Role;
  provider: Provider | null;
  model: string | null;
  selectedIndex: number;
  items: string[];
  models: APIModel[];
  loading: boolean;
  error: string | null;
  global: boolean;
}

const PROVIDERS: { id: Provider; name: string; description: string }[] = [
  { id: 'claude', name: 'Anthropic Claude', description: 'Claude 3.5/4 models' },
  { id: 'openai', name: 'OpenAI', description: 'GPT-4, O1, O3 models' },
  { id: 'gemini', name: 'Google Gemini', description: 'Gemini Pro/Ultra/Flash' },
  { id: 'mistral', name: 'Mistral AI', description: 'Mistral and Codestral models' },
];

const ROLES: { id: Role; name: string; description: string }[] = [
  { id: 'coder', name: 'Coder', description: 'Implements tasks and writes code' },
  { id: 'reviewer', name: 'Reviewer', description: 'Reviews code and approves/rejects' },
  { id: 'orchestrator', name: 'Orchestrator', description: 'Coordinates workflow decisions' },
];

/**
 * Clear screen and move cursor to top
 */
function clearScreen(): void {
  stdout.write('\x1b[2J\x1b[H');
}

/**
 * Show a loading spinner
 */
function showLoading(message: string): void {
  stdout.write(`\r${message}...`);
}

/**
 * Render the setup UI
 */
function render(state: SetupState): void {
  clearScreen();

  const width = 72;
  const line = '─'.repeat(width);

  console.log('┌' + line + '┐');
  console.log('│' + ' 🤖 AI Provider Setup'.padEnd(width) + '│');
  console.log('├' + line + '┤');

  if (state.loading) {
    console.log('│' + '  Loading models from API...'.padEnd(width) + '│');
    console.log('└' + line + '┘');
    return;
  }

  if (state.error) {
    console.log('│' + `  ⚠️  Error: ${state.error}`.substring(0, width).padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');
    console.log('│' + '  Press any key to go back'.padEnd(width) + '│');
    console.log('└' + line + '┘');
    return;
  }

  // Show current selections
  const roleDisplay = state.role ? ROLES.find((r) => r.id === state.role)?.name : '-';
  const providerDisplay = state.provider
    ? PROVIDERS.find((p) => p.id === state.provider)?.name
    : '-';
  const modelDisplay = state.model ?? '-';

  console.log(
    '│' + `  Role: ${roleDisplay}  │  Provider: ${providerDisplay}  │  Model: ${modelDisplay}`.padEnd(width) + '│'
  );
  console.log('├' + line + '┤');

  if (state.step === 'role') {
    console.log('│' + '  Select a role to configure:'.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');

    for (let i = 0; i < ROLES.length; i++) {
      const role = ROLES[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const line1 = `${prefix}${role.name}`;
      const line2 = `    ${role.description}`;

      if (isSelected) {
        console.log('│' + `\x1b[7m${line1.padEnd(width)}\x1b[0m` + '│');
        console.log('│' + `\x1b[7m${line2.padEnd(width)}\x1b[0m` + '│');
      } else {
        console.log('│' + line1.padEnd(width) + '│');
        console.log('│' + `\x1b[90m${line2}\x1b[0m`.padEnd(width + 9) + '│');
      }
    }
  } else if (state.step === 'provider') {
    console.log('│' + `  Select a provider for ${state.role}:`.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');

    for (let i = 0; i < PROVIDERS.length; i++) {
      const provider = PROVIDERS[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const hasKey = hasApiKey(provider.id);
      const keyStatus = hasKey ? '✓ API key set' : '✗ No API key';
      const keyColor = hasKey ? '\x1b[32m' : '\x1b[33m';

      const line1 = `${prefix}${provider.name}`;
      const line2 = `    ${provider.description} (${keyColor}${keyStatus}\x1b[0m)`;

      if (isSelected) {
        console.log('│' + `\x1b[7m${line1.padEnd(width)}\x1b[0m` + '│');
        console.log('│' + line2.padEnd(width + 18) + '│');
      } else {
        console.log('│' + line1.padEnd(width) + '│');
        console.log('│' + line2.padEnd(width + 18) + '│');
      }
    }
  } else if (state.step === 'model') {
    console.log(
      '│' + `  Select a model from ${state.provider}:`.padEnd(width) + '│'
    );
    console.log('│' + ''.padEnd(width) + '│');

    const maxVisible = 10;
    const startIdx = Math.max(0, state.selectedIndex - Math.floor(maxVisible / 2));
    const endIdx = Math.min(state.models.length, startIdx + maxVisible);

    if (startIdx > 0) {
      console.log('│' + '  ↑ more above'.padEnd(width) + '│');
    }

    for (let i = startIdx; i < endIdx; i++) {
      const model = state.models[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const contextInfo = model.contextWindow
        ? ` (${(model.contextWindow / 1000).toFixed(0)}k ctx)`
        : '';
      const line1 = `${prefix}${model.name}${contextInfo}`;
      const line2 = `    ${model.id}`;

      if (isSelected) {
        console.log('│' + `\x1b[7m${line1.substring(0, width).padEnd(width)}\x1b[0m` + '│');
        console.log('│' + `\x1b[7m${line2.substring(0, width).padEnd(width)}\x1b[0m` + '│');
      } else {
        console.log('│' + line1.substring(0, width).padEnd(width) + '│');
        console.log('│' + `\x1b[90m${line2}\x1b[0m`.substring(0, width + 9).padEnd(width + 9) + '│');
      }
    }

    if (endIdx < state.models.length) {
      console.log('│' + '  ↓ more below'.padEnd(width) + '│');
    }
  } else if (state.step === 'confirm') {
    console.log('│' + '  Confirm configuration:'.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');
    console.log('│' + `    Role:     ${roleDisplay}`.padEnd(width) + '│');
    console.log('│' + `    Provider: ${providerDisplay}`.padEnd(width) + '│');
    console.log('│' + `    Model:    ${modelDisplay}`.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');

    const saveLocation = state.global ? 'global (~/.steroids/config.yaml)' : 'project (.steroids/config.yaml)';
    console.log('│' + `    Save to: ${saveLocation}`.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');

    const options = ['Save configuration', 'Change scope (global/project)', 'Cancel'];
    for (let i = 0; i < options.length; i++) {
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const line1 = `${prefix}${options[i]}`;

      if (isSelected) {
        console.log('│' + `\x1b[7m${line1.padEnd(width)}\x1b[0m` + '│');
      } else {
        console.log('│' + line1.padEnd(width) + '│');
      }
    }
  }

  console.log('├' + line + '┤');
  console.log(
    '│' + ' [↑/↓] Navigate  [Enter] Select  [Esc] Back  [q] Quit'.padEnd(width) + '│'
  );
  console.log('└' + line + '┘');
}

/**
 * Save the configuration
 */
function saveConfiguration(state: SetupState): void {
  const config = loadConfig();
  const role = state.role;

  // Ensure ai section exists
  if (!config.ai) {
    config.ai = {};
  }

  // Ensure role section exists
  if (!config.ai[role]) {
    config.ai[role] = {};
  }

  // Update provider and model
  config.ai[role]!.provider = state.provider!;
  config.ai[role]!.model = state.model!;

  // Save to appropriate location
  const configPath = state.global ? getGlobalConfigPath() : getProjectConfigPath();

  // For project config, only save the AI settings we changed
  const partialConfig: Partial<SteroidsConfig> = {
    ai: {
      [role]: {
        provider: state.provider!,
        model: state.model!,
      },
    },
  };

  saveConfig(partialConfig, configPath);
}

/**
 * Run the interactive AI setup wizard
 */
export async function runAISetup(options: {
  role?: Role;
  global?: boolean;
}): Promise<void> {
  const state: SetupState = {
    step: options.role ? 'provider' : 'role',
    role: options.role ?? 'coder',
    provider: null,
    model: null,
    selectedIndex: 0,
    items: [],
    models: [],
    loading: false,
    error: null,
    global: options.global ?? false,
  };

  // Set up raw mode for key input
  if (!stdin.isTTY) {
    console.error('AI setup requires an interactive terminal.');
    process.exit(1);
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);

  render(state);

  return new Promise((resolve) => {
    const handleKeypress = async (str: string | undefined, key: readline.Key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        stdin.setRawMode(false);
        stdin.removeListener('keypress', handleKeypress);
        clearScreen();
        console.log('AI setup cancelled.');
        resolve();
        return;
      }

      if (state.error) {
        // Any key clears error and goes back
        state.error = null;
        state.step = 'provider';
        state.selectedIndex = 0;
        render(state);
        return;
      }

      if (key.name === 'escape' || key.name === 'backspace') {
        // Go back
        if (state.step === 'provider') {
          if (!options.role) {
            state.step = 'role';
            state.selectedIndex = ROLES.findIndex((r) => r.id === state.role);
          }
        } else if (state.step === 'model') {
          state.step = 'provider';
          state.selectedIndex = PROVIDERS.findIndex((p) => p.id === state.provider);
          state.model = null;
        } else if (state.step === 'confirm') {
          state.step = 'model';
          state.selectedIndex = state.models.findIndex((m) => m.id === state.model);
        }
        render(state);
        return;
      }

      if (key.name === 'up') {
        let maxIdx = 0;
        if (state.step === 'role') maxIdx = ROLES.length - 1;
        else if (state.step === 'provider') maxIdx = PROVIDERS.length - 1;
        else if (state.step === 'model') maxIdx = state.models.length - 1;
        else if (state.step === 'confirm') maxIdx = 2;

        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
        render(state);
        return;
      }

      if (key.name === 'down') {
        let maxIdx = 0;
        if (state.step === 'role') maxIdx = ROLES.length - 1;
        else if (state.step === 'provider') maxIdx = PROVIDERS.length - 1;
        else if (state.step === 'model') maxIdx = state.models.length - 1;
        else if (state.step === 'confirm') maxIdx = 2;

        state.selectedIndex = Math.min(maxIdx, state.selectedIndex + 1);
        render(state);
        return;
      }

      if (key.name === 'return') {
        if (state.step === 'role') {
          state.role = ROLES[state.selectedIndex].id;
          state.step = 'provider';
          state.selectedIndex = 0;
          render(state);
        } else if (state.step === 'provider') {
          state.provider = PROVIDERS[state.selectedIndex].id;

          // Check for API key
          if (!hasApiKey(state.provider)) {
            state.error = `${getApiKeyEnvVar(state.provider)} environment variable not set`;
            render(state);
            return;
          }

          // Fetch models from API
          state.loading = true;
          render(state);

          const result = await fetchModelsForProvider(state.provider);

          state.loading = false;

          if (!result.success) {
            state.error = result.error ?? 'Failed to fetch models';
            render(state);
            return;
          }

          if (result.models.length === 0) {
            state.error = 'No models available from this provider';
            render(state);
            return;
          }

          state.models = result.models;
          state.step = 'model';
          state.selectedIndex = 0;
          render(state);
        } else if (state.step === 'model') {
          state.model = state.models[state.selectedIndex].id;
          state.step = 'confirm';
          state.selectedIndex = 0;
          render(state);
        } else if (state.step === 'confirm') {
          if (state.selectedIndex === 0) {
            // Save
            saveConfiguration(state);
            stdin.setRawMode(false);
            stdin.removeListener('keypress', handleKeypress);
            clearScreen();
            console.log('✓ Configuration saved successfully!');
            console.log('');
            console.log(`  ai.${state.role}.provider = ${state.provider}`);
            console.log(`  ai.${state.role}.model = ${state.model}`);
            console.log('');
            resolve();
          } else if (state.selectedIndex === 1) {
            // Toggle global/project
            state.global = !state.global;
            render(state);
          } else {
            // Cancel
            stdin.setRawMode(false);
            stdin.removeListener('keypress', handleKeypress);
            clearScreen();
            console.log('AI setup cancelled.');
            resolve();
          }
        }
      }
    };

    stdin.on('keypress', handleKeypress);
  });
}

/**
 * Quick setup - non-interactive mode for scripting
 */
export async function quickAISetup(options: {
  role: Role;
  provider: Provider;
  model?: string;
  global?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  const { role, provider, global = false } = options;

  // Check API key
  if (!hasApiKey(provider)) {
    return {
      success: false,
      error: `${getApiKeyEnvVar(provider)} environment variable not set`,
    };
  }

  let model = options.model;

  // If no model specified, fetch and use the first one
  if (!model) {
    const result = await fetchModelsForProvider(provider);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    if (result.models.length === 0) {
      return { success: false, error: 'No models available' };
    }
    model = result.models[0].id;
  }

  // Save configuration
  const config = loadConfig();
  if (!config.ai) config.ai = {};
  if (!config.ai[role]) config.ai[role] = {};

  config.ai[role]!.provider = provider;
  config.ai[role]!.model = model;

  const configPath = global ? getGlobalConfigPath() : getProjectConfigPath();
  const partialConfig: Partial<SteroidsConfig> = {
    ai: {
      [role]: { provider, model },
    },
  };

  saveConfig(partialConfig, configPath);

  return { success: true };
}
