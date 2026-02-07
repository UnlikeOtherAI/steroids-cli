/**
 * Claude Provider
 * Implementation for Anthropic's Claude CLI
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
 * Available Claude models
 */
const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4',
    name: 'Claude Opus 4',
    recommendedFor: ['orchestrator', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
  {
    id: 'claude-haiku-4',
    name: 'Claude Haiku 4',
    recommendedFor: [],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'claude-opus-4',
  coder: 'claude-sonnet-4',
  reviewer: 'claude-opus-4',
};

/**
 * Default timeout in milliseconds (15 minutes)
 */
const DEFAULT_TIMEOUT = 900_000;

/**
 * Default invocation template for Claude CLI
 * Uses -p flag for print mode with prompt from file via shell substitution
 */
const DEFAULT_INVOCATION_TEMPLATE = '{cli} -p "$(cat {prompt_file})" --model {model}';

/**
 * Claude AI Provider implementation
 */
export class ClaudeProvider extends BaseAIProvider {
  readonly name = 'claude';
  readonly displayName = 'Anthropic Claude';

  /**
   * Write prompt to a temporary file
   */
  private writePromptFile(prompt: string): string {
    const tempPath = join(tmpdir(), `steroids-claude-${Date.now()}.txt`);
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
   * Invoke Claude CLI with a prompt
   */
  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const cwd = options.cwd ?? process.cwd();
    const model = options.model;
    const streamOutput = options.streamOutput ?? true;

    // Apply custom invocation template if provided in options
    if (options.invocationTemplate) {
      this.setInvocationTemplate(options.invocationTemplate);
    }

    // Write prompt to temp file
    const promptFile = options.promptFile ?? this.writePromptFile(prompt);
    const createdTempFile = !options.promptFile;

    try {
      return await this.invokeWithFile(promptFile, model, timeout, cwd, streamOutput);
    } finally {
      if (createdTempFile) {
        this.cleanupPromptFile(promptFile);
      }
    }
  }

  /**
   * Invoke Claude CLI with a prompt file using the invocation template
   */
  private invokeWithFile(
    promptFile: string,
    model: string,
    timeout: number,
    cwd: string,
    streamOutput: boolean
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
        // Stream output in real-time if enabled
        if (streamOutput) {
          process.stdout.write(text);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
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
   * Check if Claude CLI is available
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cli = this.cliPath ?? 'claude';

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
    return CLAUDE_MODELS.map((m) => m.id);
  }

  /**
   * Get detailed model information
   */
  getModelInfo(): ModelInfo[] {
    return [...CLAUDE_MODELS];
  }

  /**
   * Get the default model for a role
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }

  /**
   * Get the default invocation template for Claude CLI
   */
  getDefaultInvocationTemplate(): string {
    return DEFAULT_INVOCATION_TEMPLATE;
  }
}

/**
 * Create a Claude provider instance
 */
export function createClaudeProvider(): ClaudeProvider {
  return new ClaudeProvider();
}
