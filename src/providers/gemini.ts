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
 * Uses -p flag for non-interactive mode with stream-json for realtime output
 */
const DEFAULT_INVOCATION_TEMPLATE = '{cli} -p "$(cat {prompt_file})" -m {model} --output-format stream-json';

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
  /**
   * Parse a stream-json line from Gemini CLI
   */
  private parseStreamJsonLine(line: string): { text?: string; tool?: string; result?: string } {
    try {
      const event = JSON.parse(line);

      // Assistant message with delta text
      if (event.type === 'message' && event.role === 'assistant' && event.content) {
        return { text: event.content };
      }

      // Tool call events
      if (event.type === 'tool_call' || event.type === 'function_call') {
        return { tool: event.name || event.function?.name || 'tool' };
      }

      // Final result
      if (event.type === 'result') {
        return { result: event.content || '' };
      }
    } catch {
      if (line.trim()) return { text: line };
    }
    return {};
  }

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
      let stdoutLineBuffer = '';
      const isStreamJson = this.getInvocationTemplate().includes('stream-json');

      // Build command from invocation template
      const command = this.buildCommand(promptFile, model);

      // Spawn using shell to handle the command template
      const child = spawn(command, {
        shell: true,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately to prevent CLI tools from hanging
      child.stdin?.end();

      // Activity-based timeout: resettable timer that only kills when silent
      const MAX_BUFFER = 2_000_000; // Cap stdout/stderr at ~2MB
      let activityTimer: ReturnType<typeof setTimeout>;

      const resetActivityTimer = () => {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
            }
            setTimeout(() => {
              if (child.exitCode === null) {
                resolve({
                  success: false, exitCode: 1, stdout, stderr,
                  duration: Date.now() - startTime, timedOut: true,
                });
              }
            }, 5000);
          }, 5000);
        }, timeout);
      };
      resetActivityTimer();

      child.stdout?.on('data', (data: Buffer) => {
        const raw = data.toString();
        resetActivityTimer();

        if (!isStreamJson) {
          if (stdout.length < MAX_BUFFER) stdout += raw;
          onActivity?.({ type: 'output', stream: 'stdout', msg: raw });
          if (streamOutput) process.stdout.write(raw);
          return;
        }

        // Stream-json mode: parse JSONL events
        stdoutLineBuffer += raw;
        while (true) {
          const nl = stdoutLineBuffer.indexOf('\n');
          if (nl === -1) break;
          const line = stdoutLineBuffer.slice(0, nl).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(nl + 1);
          if (!line) continue;

          const parsed = this.parseStreamJsonLine(line);

          if (parsed.result !== undefined) {
            if (parsed.result) stdout = parsed.result;
          } else if (parsed.text) {
            if (stdout.length < MAX_BUFFER) stdout += parsed.text;
            onActivity?.({ type: 'output', stream: 'stdout', msg: parsed.text });
            if (streamOutput) process.stdout.write(parsed.text);
          } else if (parsed.tool) {
            onActivity?.({ type: 'tool', cmd: parsed.tool });
            if (streamOutput) process.stdout.write(`[tool: ${parsed.tool}]\n`);
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (stderr.length < MAX_BUFFER) stderr += text;
        resetActivityTimer();
        onActivity?.({ type: 'output', stream: 'stderr', msg: text });
        if (streamOutput) {
          process.stderr.write(text);
        }
      });

      child.on('close', (code) => {
        clearTimeout(activityTimer);
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
        clearTimeout(activityTimer);
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
