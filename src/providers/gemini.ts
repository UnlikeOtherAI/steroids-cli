/**
 * Gemini Provider
 * Implementation for Google Gemini CLI
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
} from './interface.js';

/**
 * Available Gemini models
 */
const GEMINI_MODELS: ModelInfo[] = [
  {
    id: 'gemini-pro',
    name: 'Gemini Pro',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
  {
    id: 'gemini-ultra',
    name: 'Gemini Ultra',
    recommendedFor: ['orchestrator', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'gemini-flash',
    name: 'Gemini Flash',
    recommendedFor: [],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'gemini-ultra',
  coder: 'gemini-pro',
  reviewer: 'gemini-ultra',
};

/**
 * Default timeout in milliseconds (15 minutes)
 */
const DEFAULT_TIMEOUT = 900_000;

/**
 * Default invocation template for Gemini CLI
 * Uses -p flag for non-interactive (headless) mode with prompt from file
 */
const DEFAULT_INVOCATION_TEMPLATE = '{cli} -p "$(cat {prompt_file})" -m {model}';

/**
 * Gemini AI Provider implementation
 */
export class GeminiProvider extends BaseAIProvider {
  readonly name = 'gemini';
  readonly displayName = 'Google Gemini';

  /**
   * Write prompt to a temporary file
   */
  private writePromptFile(prompt: string): string {
    const tempPath = join(tmpdir(), `steroids-gemini-${Date.now()}.txt`);
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
   * Invoke Gemini CLI with a prompt
   */
  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const cwd = options.cwd ?? process.cwd();
    const streamOutput = options.streamOutput ?? true;
    const onActivity = options.onActivity;

    // Apply custom invocation template if provided in options
    if (options.invocationTemplate) {
      this.setInvocationTemplate(options.invocationTemplate);
    }

    // Write prompt to temp file
    const promptFile = options.promptFile ?? this.writePromptFile(prompt);
    const createdTempFile = !options.promptFile;

    try {
      return await this.invokeWithFile(promptFile, options.model, timeout, cwd, streamOutput, onActivity);
    } finally {
      if (createdTempFile) {
        this.cleanupPromptFile(promptFile);
      }
    }
  }

  /**
   * Invoke Gemini CLI with a prompt file using the invocation template
   */
  private invokeWithFile(
    promptFile: string,
    model: string,
    timeout: number,
    cwd: string,
    streamOutput: boolean,
    onActivity?: InvokeOptions['onActivity']
  ): Promise<InvokeResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Build command from invocation template
      const command = this.buildCommand(promptFile, model);

      // Spawn using shell to handle the command template
      const child = spawn(command, {
        shell: true,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (!child.killed) {
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

        resolve({
          success: code === 0 && !timedOut,
          exitCode: code ?? 1,
          stdout,
          stderr,
          duration,
          timedOut,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;

        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          duration,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Check if Gemini CLI is available
   * Checks for both 'gemini' and 'gcloud' CLIs
   */
  async isAvailable(): Promise<boolean> {
    const cli = this.cliPath ?? 'gemini';

    // First try the specified or default gemini CLI
    const geminiAvailable = await this.checkCliAvailable(cli);
    if (geminiAvailable) {
      return true;
    }

    // Fall back to gcloud if gemini CLI not found
    if (cli === 'gemini') {
      return this.checkCliAvailable('gcloud');
    }

    return false;
  }

  /**
   * Check if a specific CLI is available
   */
  private checkCliAvailable(cli: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('which', [cli], {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('close', (code) => {
        resolve(code === 0);
      });

      child.on('error', () => {
        resolve(false);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5000);
    });
  }

  /**
   * List available model IDs
   */
  listModels(): string[] {
    return GEMINI_MODELS.map((m) => m.id);
  }

  /**
   * Get detailed model information
   */
  getModelInfo(): ModelInfo[] {
    return [...GEMINI_MODELS];
  }

  /**
   * Get the default model for a role
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }
}

/**
 * Create a Gemini provider instance
 */
export function createGeminiProvider(): GeminiProvider {
  return new GeminiProvider();
}
