/**
 * Custom Models Provider
 *
 * Reads ai.custom.models[] from config and delegates to the underlying CLI
 * (claude / opencode / codex) with user-defined base URL + token injected
 * as environment variables for the duration of the invocation.
 *
 * Per-CLI injection:
 *   claude   → ANTHROPIC_BASE_URL  + ANTHROPIC_AUTH_TOKEN
 *   opencode → OPENAI_BASE_URL     + OPENAI_API_KEY
 *   codex    → CODEX_HOME (isolated config.toml) + OPENAI_API_KEY
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
} from './interface.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { OpenCodeProvider } from './opencode.js';
import { loadConfig } from '../config/loader.js';
import type { CustomModelCli, CustomModelConfig } from '../config/loader.js';

export class CustomModelsProvider extends BaseAIProvider {
  readonly name = 'custom';
  readonly displayName = 'Custom Endpoints';

  // Delegate provider instances — reused for all custom model invocations
  private readonly claudeDelegate = new ClaudeProvider();
  private readonly opencodeDelegate = new OpenCodeProvider();
  private readonly codexDelegate = new CodexProvider();

  private getModels(): CustomModelConfig[] {
    try {
      return loadConfig().ai?.custom?.models ?? [];
    } catch {
      return [];
    }
  }

  private getModelConfig(modelName: string): CustomModelConfig | undefined {
    return this.getModels().find((m) => m.name === modelName);
  }

  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const modelName = options.model ?? '';
    const config = this.getModelConfig(modelName);

    if (!config) {
      return {
        success: false,
        stdout: '',
        stderr: `Custom model '${modelName}' not found in config. Add it via the Custom Models page.`,
        exitCode: 1,
        timedOut: false,
        duration: 0,
      };
    }

    // Snapshot original env values so we can restore them after the call
    const snap = {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME,
    };

    try {
      if (config.cli === 'claude') {
        process.env.ANTHROPIC_BASE_URL = config.baseUrl;
        process.env.ANTHROPIC_AUTH_TOKEN = config.token;
      } else if (config.cli === 'opencode') {
        process.env.OPENAI_BASE_URL = config.baseUrl;
        process.env.OPENAI_API_KEY = config.token;
      } else if (config.cli === 'codex') {
        // Write an isolated config.toml so the user's real ~/.codex/config.toml is untouched
        const codexHome = await this.setupIsolatedCodexHome(config.baseUrl, config.token);
        process.env.CODEX_HOME = codexHome;
        process.env.OPENAI_API_KEY = config.token;
      }

      const delegate = this.getDelegate(config.cli);
      return await delegate.invoke(prompt, { ...options, model: modelName });
    } finally {
      // Restore original env values — only delete our keys, leave everything else intact
      if (snap.ANTHROPIC_BASE_URL !== undefined) {
        process.env.ANTHROPIC_BASE_URL = snap.ANTHROPIC_BASE_URL;
      } else {
        delete process.env.ANTHROPIC_BASE_URL;
      }
      if (snap.ANTHROPIC_AUTH_TOKEN !== undefined) {
        process.env.ANTHROPIC_AUTH_TOKEN = snap.ANTHROPIC_AUTH_TOKEN;
      } else {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
      if (snap.OPENAI_BASE_URL !== undefined) {
        process.env.OPENAI_BASE_URL = snap.OPENAI_BASE_URL;
      } else {
        delete process.env.OPENAI_BASE_URL;
      }
      if (snap.OPENAI_API_KEY !== undefined) {
        process.env.OPENAI_API_KEY = snap.OPENAI_API_KEY;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (snap.CODEX_HOME !== undefined) {
        process.env.CODEX_HOME = snap.CODEX_HOME;
      } else {
        delete process.env.CODEX_HOME;
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.getModels().length > 0;
  }

  listModels(): string[] {
    return this.getModels().map((m) => m.name);
  }

  getModelInfo(): ModelInfo[] {
    return this.getModels().map((m) => ({
      id: m.name,
      name: m.name,
      recommendedFor: ['coder', 'reviewer', 'orchestrator'],
      supportsStreaming: true,
      contextWindow: 128000,
    }));
  }

  getDefaultModel(_role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined {
    return this.getModels()[0]?.name;
  }

  getDefaultInvocationTemplate(): string {
    return '{cli} -p "$(cat {prompt_file})" --model {model}';
  }

  private getDelegate(cli: CustomModelCli) {
    switch (cli) {
      case 'claude':
        return this.claudeDelegate;
      case 'opencode':
        return this.opencodeDelegate;
      case 'codex':
        return this.codexDelegate;
    }
  }

  /**
   * Write an isolated config.toml for Codex pointing at the custom endpoint.
   * CODEX_HOME is set on process.env so Codex uses this dir instead of ~/.codex.
   * The user's real ~/.codex/config.toml is never touched.
   */
  private async setupIsolatedCodexHome(baseUrl: string, token: string): Promise<string> {
    const uuid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const codexHome = join(tmpdir(), `steroids-codex-custom-${uuid}`);
    mkdirSync(codexHome, { recursive: true });

    // Write minimal config.toml with the custom OpenAI-compatible endpoint
    // Codex will also pick up OPENAI_API_KEY from process.env as fallback
    const configContent = [
      '[providers.openai]',
      `base_url = "${baseUrl}"`,
      `api_key = "${token}"`,
    ].join('\n');

    writeFileSync(join(codexHome, 'config.toml'), configContent, { mode: 0o600 });
    return codexHome;
  }
}
