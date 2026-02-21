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
  type ReviewerConfig,
  type ProviderName,
} from './loader.js';

type Provider = ProviderName;
type Role = 'orchestrator' | 'coder' | 'reviewer';

interface SetupState {
  step: 'role' | 'reviewer_mode' | 'reviewer_list' | 'provider' | 'model' | 'confirm' | 'done';
  role: Role;
  provider: Provider | null;
  model: string | null;
  selectedIndex: number;
  items: string[];
  models: APIModel[];
  loading: boolean;
  error: string | null;
  global: boolean;
  reviewers: ReviewerConfig[];
  editingReviewerIndex: number | null;
}

const PROVIDERS: { id: Provider; name: string; description: string }[] = [
  { id: 'claude', name: 'Anthropic (claude)', description: 'Claude Opus/Sonnet/Haiku models' },
  { id: 'codex', name: 'OpenAI (codex)', description: 'GPT-5 and specialized coding models' },
  { id: 'gemini', name: 'Google (gemini)', description: 'Gemini Pro/Flash models' },
  { id: 'mistral', name: 'Mistral (vibe)', description: 'Devstral and Mistral models' },
  { id: 'openai', name: 'OpenAI API', description: 'Standard GPT-4o/3.5 models via API' },
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
  const roleDisplay = state.role ? ROLES.find((r) => r.id === state.role)?.name || state.role : '-';
  let providerDisplay = state.provider
    ? PROVIDERS.find((p) => p.id === state.provider)?.name || state.provider
    : '-';
  let modelDisplay = state.model ?? '-';

  if (state.role === 'reviewer' && state.reviewers.length > 1 && state.step !== 'provider' && state.step !== 'model') {
    providerDisplay = `${state.reviewers.length} Reviewers`;
    modelDisplay = 'Multi-Review Mode';
  }

  console.log(
    '│' + `  Role: ${roleDisplay.padEnd(12)} │ Provider: ${providerDisplay.padEnd(18)} │ Model: ${modelDisplay.substring(0, 15).padEnd(15)}`.padEnd(width) + '│'
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
  } else if (state.step === 'reviewer_mode') {
    console.log('│' + '  Reviewer Configuration Mode:'.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');
    console.log('│' + '  How many reviewers should approve each task?'.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');

    const options = [
      { id: 'single', name: 'Single reviewer (default)', description: 'One reviewer makes the decision' },
      { id: 'multi', name: 'Multiple reviewers', description: 'All reviewers must approve (high assurance)' },
    ];

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const line1 = `${prefix}${opt.name}`;
      const line2 = `    ${opt.description}`;

      if (isSelected) {
        console.log('│' + `\x1b[7m${line1.padEnd(width)}\x1b[0m` + '│');
        console.log('│' + `\x1b[7m${line2.padEnd(width)}\x1b[0m` + '│');
      } else {
        console.log('│' + line1.padEnd(width) + '│');
        console.log('│' + `\x1b[90m${line2}\x1b[0m`.padEnd(width + 9) + '│');
      }
    }
  } else if (state.step === 'reviewer_list') {
    console.log('│' + '  Configure Reviewers (all must approve):'.padEnd(width) + '│');
    console.log('│' + ''.padEnd(width) + '│');

    for (let i = 0; i < state.reviewers.length; i++) {
      const r = state.reviewers[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? '▸ ' : '  ';
      const line1 = `${prefix}${i + 1}. ${r.provider ?? '(empty)'} / ${r.model ?? '(empty)'}`;

      if (isSelected) {
        console.log('│' + `\x1b[7m${line1.padEnd(width)}\x1b[0m` + '│');
      } else {
        console.log('│' + line1.padEnd(width) + '│');
      }
    }

    const isAddSelected = state.selectedIndex === state.reviewers.length;
    const isDoneSelected = state.selectedIndex === state.reviewers.length + 1;

    console.log('│' + ''.padEnd(width) + '│');
    const addLine = `  [+] Add reviewer`;
    if (isAddSelected) {
      console.log('│' + `\x1b[7m${addLine.padEnd(width)}\x1b[0m` + '│');
    } else {
      console.log('│' + addLine.padEnd(width) + '│');
    }

    const doneLine = `  [Done] Finish configuration`;
    if (isDoneSelected) {
      console.log('│' + `\x1b[7m${doneLine.padEnd(width)}\x1b[0m` + '│');
    } else {
      console.log('│' + doneLine.padEnd(width) + '│');
    }

    console.log('│' + ''.padEnd(width) + '│');
    console.log('│' + '  [↑/↓] Navigate  [Enter] Edit/Add  [x] Remove  [q] Done'.padEnd(width) + '│');
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
    const selectedProviderName =
      PROVIDERS.find((p) => p.id === state.provider)?.name ?? state.provider ?? '-';
    console.log(
      '│' + `  Select a model from ${selectedProviderName}:`.padEnd(width) + '│'
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

  // Save to appropriate location
  const configPath = state.global ? getGlobalConfigPath() : getProjectConfigPath();

  // For project config, only save the AI settings we changed
  const partialConfig: Partial<SteroidsConfig> = {
    ai: {},
  };

  if (role === 'reviewer' && state.reviewers.length > 1) {
    partialConfig.ai!.reviewers = state.reviewers.map(r => ({
      provider: r.provider!,
      model: r.model!,
    }));
    // Also clear singular reviewer if it exists to avoid confusion, 
    // though plural takes precedence in loader.
  } else {
    partialConfig.ai![role] = {
      provider: state.provider!,
      model: state.model!,
    };
    
    // If we are setting a single reviewer, we should clear the multi-reviewer array
    // so it doesn't take precedence anymore.
    if (role === 'reviewer') {
      partialConfig.ai!.reviewers = [];
    }
  }

  saveConfig(partialConfig, configPath);
}

/**
 * Run the interactive AI setup wizard
 */
export async function runAISetup(options: {
  role?: Role;
  global?: boolean;
}): Promise<void> {
  const config = loadConfig();
  
  const state: SetupState = {
    step: options.role ? (options.role === 'reviewer' ? 'reviewer_mode' : 'provider') : 'role',
    role: options.role ?? 'coder',
    provider: null,
    model: null,
    selectedIndex: 0,
    items: [],
    models: [],
    loading: false,
    error: null,
    global: options.global ?? false,
    reviewers: config.ai?.reviewers && config.ai.reviewers.length > 0 ? [...config.ai.reviewers] : [],
    editingReviewerIndex: null,
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

      if (key.name === 'escape' || (key.name === 'backspace' && state.step !== 'reviewer_list')) {
        // Go back
        if (state.step === 'reviewer_mode') {
          if (!options.role) {
            state.step = 'role';
            state.selectedIndex = ROLES.findIndex((r) => r.id === state.role);
          }
        } else if (state.step === 'reviewer_list') {
          state.step = 'reviewer_mode';
          state.selectedIndex = 0;
        } else if (state.step === 'provider') {
          if (state.role === 'reviewer') {
            if (state.editingReviewerIndex !== null) {
              state.step = 'reviewer_list';
              state.selectedIndex = state.editingReviewerIndex;
            } else {
              state.step = 'reviewer_mode';
              state.selectedIndex = 0;
            }
          } else if (!options.role) {
            state.step = 'role';
            state.selectedIndex = ROLES.findIndex((r) => r.id === state.role);
          }
        } else if (state.step === 'model') {
          state.step = 'provider';
          state.selectedIndex = PROVIDERS.findIndex((p) => p.id === state.provider);
          state.model = null;
        } else if (state.step === 'confirm') {
          if (state.role === 'reviewer' && state.reviewers.length > 1) {
            state.step = 'reviewer_list';
            state.selectedIndex = state.reviewers.length + 1; // On "Done"
          } else {
            state.step = 'model';
            state.selectedIndex = state.models.findIndex((m) => m.id === state.model);
          }
        }
        render(state);
        return;
      }

      if (key.name === 'up') {
        let maxIdx = 0;
        if (state.step === 'role') maxIdx = ROLES.length - 1;
        else if (state.step === 'reviewer_mode') maxIdx = 1;
        else if (state.step === 'reviewer_list') maxIdx = state.reviewers.length + 1;
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
        else if (state.step === 'reviewer_mode') maxIdx = 1;
        else if (state.step === 'reviewer_list') maxIdx = state.reviewers.length + 1;
        else if (state.step === 'provider') maxIdx = PROVIDERS.length - 1;
        else if (state.step === 'model') maxIdx = state.models.length - 1;
        else if (state.step === 'confirm') maxIdx = 2;

        state.selectedIndex = Math.min(maxIdx, state.selectedIndex + 1);
        render(state);
        return;
      }

      if (key.name === 'x' && state.step === 'reviewer_list') {
        if (state.selectedIndex < state.reviewers.length) {
          if (state.reviewers.length > 1) {
            state.reviewers.splice(state.selectedIndex, 1);
            state.selectedIndex = Math.min(state.selectedIndex, state.reviewers.length + 1);
            render(state);
          }
        }
        return;
      }

      if (key.name === 'return') {
        if (state.step === 'role') {
          state.role = ROLES[state.selectedIndex].id;
          if (state.role === 'reviewer') {
            state.step = 'reviewer_mode';
          } else {
            state.step = 'provider';
          }
          state.selectedIndex = 0;
          render(state);
        } else if (state.step === 'reviewer_mode') {
          if (state.selectedIndex === 0) {
            // Single reviewer
            state.reviewers = [];
            state.step = 'provider';
          } else {
            // Multi reviewer
            if (state.reviewers.length === 0) {
              // Initialize with current singular reviewer if exists
              const currentReviewer = config.ai?.reviewer;
              if (currentReviewer) {
                state.reviewers.push({ ...currentReviewer });
              }
            }
            state.step = 'reviewer_list';
          }
          state.selectedIndex = 0;
          render(state);
        } else if (state.step === 'reviewer_list') {
          if (state.selectedIndex < state.reviewers.length) {
            // Edit existing reviewer
            state.editingReviewerIndex = state.selectedIndex;
            state.step = 'provider';
            state.selectedIndex = 0;
          } else if (state.selectedIndex === state.reviewers.length) {
            // Add new reviewer
            state.editingReviewerIndex = null;
            state.step = 'provider';
            state.selectedIndex = 0;
          } else {
            // Done
            if (state.reviewers.length < 2) {
              state.error = 'At least 2 reviewers are required for multi-review mode';
              render(state);
            } else {
              state.step = 'confirm';
              state.selectedIndex = 0;
            }
          }
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
          
          if (state.role === 'reviewer' && state.step === 'model') {
             if (state.editingReviewerIndex !== null) {
               // Update existing
               state.reviewers[state.editingReviewerIndex] = {
                 provider: state.provider!,
                 model: state.model!,
               };
               state.step = 'reviewer_list';
               state.selectedIndex = state.editingReviewerIndex;
             } else if (state.editingReviewerIndex === null && state.reviewers.length > 0) {
               // Add new
               state.reviewers.push({
                 provider: state.provider!,
                 model: state.model!,
               });
               state.step = 'reviewer_list';
               state.selectedIndex = state.reviewers.length - 1;
             } else {
               // Single reviewer case
               state.step = 'confirm';
               state.selectedIndex = 0;
             }
          } else {
            state.step = 'confirm';
            state.selectedIndex = 0;
          }
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
            if (state.role === 'reviewer' && state.reviewers.length > 1) {
              console.log(`  ai.reviewers = ${state.reviewers.length} reviewers configured`);
            } else {
              console.log(`  ai.${state.role}.provider = ${state.provider}`);
              console.log(`  ai.${state.role}.model = ${state.model}`);
            }
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
