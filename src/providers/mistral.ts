/**
 * Mistral Provider
 * Implementation for Mistral Vibe CLI
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type ProviderError,
  type TokenUsage,
} from './interface.js';

/**
 * Available Mistral models
 */
const MISTRAL_MODELS: ModelInfo[] = [
  {
    id: 'codestral-latest',
    name: 'Codestral (latest)',
    recommendedFor: ['orchestrator', 'coder', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'mistral-large-latest',
    name: 'Mistral Large (latest)',
    recommendedFor: [],
    supportsStreaming: true,
  },
  {
    id: 'mistral-medium-latest',
    name: 'Mistral Medium (latest)',
    recommendedFor: [],
    supportsStreaming: true,
  },
  {
    id: 'mistral-small-latest',
    name: 'Mistral Small (latest)',
    recommendedFor: [],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'codestral-latest',
  coder: 'codestral-latest',
  reviewer: 'codestral-latest',
};

/**
 * Default timeout in milliseconds (15 minutes)
 */
const DEFAULT_TIMEOUT = 900_000;

/**
 * Default invocation template for Vibe CLI
 * Model selection is injected through VIBE_ACTIVE_MODEL/VIBE_MODELS env vars.
 */
const DEFAULT_INVOCATION_TEMPLATE = '{cli} -p "$(cat {prompt_file})" {session_id} --output text --max-turns 80 --agent auto-approve';

/**
 * Mistral Vibe Provider implementation
 */
export class MistralProvider extends BaseAIProvider {
  readonly name = 'mistral';
  readonly displayName = 'Mistral Vibe';

  constructor() {
    super();
    // Provider ID is "mistral", but executable is "vibe".
    this.cliPath = 'vibe';
  }

  /**
   * Write prompt to a temporary file
   */
  private writePromptFile(prompt: string): string {
    const tempPath = join(tmpdir(), `steroids-mistral-${process.pid}-${randomUUID()}.txt`);
    writeFileSync(tempPath, prompt, { mode: 0o600 });
    return tempPath;
  }

  /**
   * Clean up temporary prompt file
   */
  private cleanupPromptFile(path: string): void {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Get the default invocation template
   */
  getDefaultInvocationTemplate(): string {
    return DEFAULT_INVOCATION_TEMPLATE;
  }

  /**
   * Invoke Mistral Vibe with a prompt
   */
  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const cwd = options.cwd ?? process.cwd();
    const streamOutput = options.streamOutput ?? true;
    const onActivity = options.onActivity;

    if (options.invocationTemplate) {
      this.setInvocationTemplate(options.invocationTemplate);
    }

    const promptFile = options.promptFile ?? this.writePromptFile(prompt);
    const createdTempFile = !options.promptFile;

    try {
      return await this.invokeWithFile(
        promptFile,
        options.model,
        timeout,
        cwd,
        streamOutput,
        onActivity,
        options.resumeSessionId
      );
    } finally {
      if (createdTempFile) {
        this.cleanupPromptFile(promptFile);
      }
    }
  }

  /**
   * Extract session ID and token usage from Vibe logs on disk.
   * Vibe does not include session metadata in structured output.
   * @param vibeHome The specific VIBE_HOME directory to scan
   */
  private extractSessionInfo(vibeHome?: string): { sessionId?: string; tokenUsage?: TokenUsage } {
    try {
      const home = vibeHome ?? join(homedir(), '.vibe');
      // Vibe puts logs in logs/session/ under the home dir
      const sessionsDir = join(home, 'logs', 'session');
      if (!existsSync(sessionsDir)) {
        // Fallback for isolated home where logs/session might be at the root or under .vibe
        const altDir = join(home, '.vibe', 'logs', 'session');
        if (existsSync(altDir)) return this.extractSessionInfo(join(home, '.vibe'));
        return {};
      }

      // Find newest session directory (named session_YYYYMMDD_HHMMSS_shortid)
      const dirs = readdirSync(sessionsDir)
        .filter((d) => d.startsWith('session_'))
        .sort()
        .reverse();

      if (dirs.length === 0) return {};

      const metaPath = join(sessionsDir, dirs[0], 'meta.json');
      if (!existsSync(metaPath)) return {};

      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (!meta.session_id) return {};

      const tokenUsage: TokenUsage | undefined = meta.stats ? {
        inputTokens: meta.stats.session_prompt_tokens,
        outputTokens: meta.stats.session_completion_tokens,
        totalCostUsd: meta.stats.session_cost,
      } : undefined;

      return {
        sessionId: meta.session_id,
        tokenUsage,
      };
    } catch {
      return {};
    }
  }

  /**
   * Invoke Vibe CLI with a prompt file using the invocation template
   */
  private invokeWithFile(
    promptFile: string,
    model: string,
    timeout: number,
    cwd: string,
    streamOutput: boolean,
    onActivity?: InvokeOptions['onActivity'],
    resumeSessionId?: string
  ): Promise<InvokeResult> {
    // Set up isolated VIBE_HOME
    const isolatedHome = this.setupIsolatedHome('.vibe', ['state.json', 'config.yaml']);

    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Vibe chooses models by alias. We inject a one-model runtime list so any
      // requested model ID can be selected deterministically.
      const env = this.getSanitizedCliEnv({
        VIBE_HOME: isolatedHome,
        VIBE_ACTIVE_MODEL: model,
        VIBE_MODELS: JSON.stringify([
          {
            name: model,
            provider: 'mistral',
            alias: model,
            input_price: 0.0,
            output_price: 0.0,
          },
        ]),
      });

      // Default path uses argument-based invocation (no shell interpolation),
      // which avoids command injection through prompt content.
      // If a custom template is explicitly set, preserve template behavior.
      const sessionIdFlag = resumeSessionId ? `--resume ${resumeSessionId}` : '';
      const child = this.invocationTemplate
        ? spawn(this.buildCommand(promptFile, model, sessionIdFlag), {
          shell: true,
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        : spawn(this.getCliPath() ?? this.cliPath ?? 'vibe', [
          '-p',
          readFileSync(promptFile, 'utf-8'),
          ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
          '--output',
          'text',
          '--max-turns',
          '80',
          '--agent',
          'auto-approve',
        ], {
          shell: false,
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

      child.stdin?.end();

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, timeout);

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        onActivity?.({ type: 'output', stream: 'stdout', msg: text });
        if (streamOutput) {
          process.stdout.write(text);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        onActivity?.({ type: 'output', stream: 'stderr', msg: text });
        if (streamOutput) {
          process.stderr.write(text);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;
        const sessionInfo = this.extractSessionInfo(isolatedHome);

        // Cleanup isolated home
        try {
          rmSync(isolatedHome, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }

        resolve({
          success: code === 0 && !timedOut,
          exitCode: code ?? 1,
          stdout: stdout.trimEnd(),
          stderr,
          duration,
          timedOut,
          ...sessionInfo,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;
        const sessionInfo = this.extractSessionInfo(isolatedHome);

        // Cleanup isolated home
        try {
          rmSync(isolatedHome, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }

        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          duration,
          timedOut: false,
          ...sessionInfo,
        });
      });
    });
  }

  /**
   * Check if Mistral Vibe CLI is available
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cli = this.cliPath ?? 'vibe';
      const lookup = process.platform === 'win32' ? 'where' : 'which';
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve(available);
      };

      const child = spawn(lookup, [cli], {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      child.on('close', (code) => {
        finish(code === 0);
      });

      child.on('error', () => {
        finish(false);
      });

      timeoutHandle = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Ignore kill errors
        }
        finish(false);
      }, 5000);
    });
  }

  /**
   * Add provider-specific error classification for Vibe startup failures.
   */
  classifyError(exitCode: number, stderr: string): ProviderError | null {
    if (exitCode === 0) return null;

    if (/active model .* not found in configuration/i.test(stderr)) {
      return {
        type: 'model_not_found',
        message: 'Requested model alias is not configured for Vibe',
        retryable: false,
      };
    }

    if (/missing .* environment variable .* provider/i.test(stderr) ||
        /mistral_api_key/i.test(stderr)) {
      return {
        type: 'auth_error',
        message: 'STEROIDS_MISTRAL_API_KEY is missing or invalid',
        retryable: false,
      };
    }

    return super.classifyError(exitCode, stderr);
  }

  /**
   * List available model IDs
   */
  listModels(): string[] {
    return MISTRAL_MODELS.map((m) => m.id);
  }

  /**
   * Get detailed model information
   */
  getModelInfo(): ModelInfo[] {
    return [...MISTRAL_MODELS];
  }

  /**
   * Get the default model for a role
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }
}

/**
 * Create a Mistral provider instance
 */
export function createMistralProvider(): MistralProvider {
  return new MistralProvider();
}
