/**
 * OpenCode Provider
 * Spawns `opencode run` as a subprocess for HF/Ollama model invocation with tool support.
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
  type TokenUsage,
  SessionNotFoundError,
  type ProviderError
} from './interface.js';

const DEFAULT_TIMEOUT = 900_000;

const DEFAULT_INVOCATION_TEMPLATE =
  '{cli} run -m {model} --format json "$(cat {prompt_file})" {session_id}';

interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    text?: string;
    tool?: string;
    tokens?: {
      input?: number;
      output?: number;
    };
  };
  error?: {
    message?: string;
    code?: string | number;
  };
}

export class OpenCodeProvider extends BaseAIProvider {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';

  private writePromptFile(prompt: string): string {
    const tempPath = join(tmpdir(), `steroids-opencode-${Date.now()}.txt`);
    writeFileSync(tempPath, prompt, { mode: 0o600 });
    return tempPath;
  }

  private cleanupPromptFile(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Ignore cleanup errors
    }
  }

  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const cwd = options.cwd ?? process.cwd();
    const model = options.model;
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
        model,
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
   * Parse a JSONL event from `opencode run --format json`.
   */
  parseJsonLine(line: string): {
    text?: string;
    tool?: string;
    sessionId?: string;
    tokenUsage?: TokenUsage;
    error?: string;
  } {
    try {
      const event: OpenCodeEvent = JSON.parse(line);

      if (event.sessionID) {
        const base: { sessionId: string } = { sessionId: event.sessionID };

        if (event.type === 'text' && event.part?.text) {
          return { ...base, text: event.part.text };
        }

        if (event.type === 'tool_use' && event.part?.tool) {
          return { ...base, tool: event.part.tool };
        }

        if (event.type === 'step_finish' && event.part?.tokens) {
          return {
            ...base,
            tokenUsage: {
              inputTokens: event.part.tokens.input ?? 0,
              outputTokens: event.part.tokens.output ?? 0,
            },
          };
        }

        if (event.type === 'error') {
          return { ...base, error: event.error?.message ?? 'Unknown OpenCode error' };
        }

        return base;
      }

      // No sessionID — still parse useful fields
      if (event.type === 'text' && event.part?.text) {
        return { text: event.part.text };
      }

      if (event.type === 'tool_use' && event.part?.tool) {
        return { tool: event.part.tool };
      }

      if (event.type === 'step_finish' && event.part?.tokens) {
        return {
          tokenUsage: {
            inputTokens: event.part.tokens.input ?? 0,
            outputTokens: event.part.tokens.output ?? 0,
          },
        };
      }

      if (event.type === 'error') {
        return { error: event.error?.message ?? 'Unknown OpenCode error' };
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
    onActivity?: InvokeOptions['onActivity'],
    resumeSessionId?: string
  ): Promise<InvokeResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let lineBuffer = '';
      let sessionId: string | undefined = resumeSessionId;
      let tokenUsage: TokenUsage | undefined;

      const sessionIdFlag = resumeSessionId ? `--session ${resumeSessionId}` : '';
      const command = this.buildCommand(promptFile, model, sessionIdFlag);

      const child = spawn(command, {
        shell: true,
        cwd,
        env: this.getSanitizedCliEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin?.end();

      const MAX_BUFFER = 2_000_000;
      let activityTimer: ReturnType<typeof setTimeout>;

      const resetActivityTimer = () => {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            setTimeout(() => {
              if (child.exitCode === null) {
                resolve({
                  success: false,
                  exitCode: 1,
                  stdout,
                  stderr,
                  duration: Date.now() - startTime,
                  timedOut: true,
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

        lineBuffer += raw;
        while (true) {
          const nl = lineBuffer.indexOf('\n');
          if (nl === -1) break;
          const line = lineBuffer.slice(0, nl).trim();
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line) continue;

          const parsed = this.parseJsonLine(line);

          if (parsed.sessionId) sessionId = parsed.sessionId;
          if (parsed.tokenUsage) tokenUsage = parsed.tokenUsage;

          if (parsed.error) {
            if (stderr.length < MAX_BUFFER) stderr += parsed.error + '\n';
            onActivity?.({ type: 'output', stream: 'stderr', msg: parsed.error });
            if (streamOutput) process.stderr.write(parsed.error + '\n');
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
        if (streamOutput) process.stderr.write(text);
      });

      child.on('close', (code) => {
        clearTimeout(activityTimer);
        const duration = Date.now() - startTime;

        const outputStr = (stdout + '\n' + stderr).toLowerCase();
        if (
          code !== 0 &&
          resumeSessionId &&
          (!outputStr.trim() ||
            outputStr.includes('session not found') ||
            outputStr.includes('failed to resume') ||
            outputStr.includes('unknown session'))
        ) {
          reject(new SessionNotFoundError(`Failed to resume OpenCode session ${resumeSessionId}`));
          return;
        }

        // OpenCode exits 0 even when the backend is unreachable.
        // Detect this: exit 0 + no useful stdout + error content in stderr.
        const nominalSuccess = code === 0 && !timedOut;
        const falseSuccess = nominalSuccess && !stdout.trim() && stderr.trim().length > 0;

        resolve({
          success: nominalSuccess && !falseSuccess,
          exitCode: code ?? 1,
          stdout,
          stderr,
          duration,
          timedOut,
          sessionId,
          tokenUsage,
        });
      });

      child.on('error', (error) => {
        clearTimeout(activityTimer);
        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          duration: Date.now() - startTime,
          timedOut: false,
          sessionId,
          tokenUsage,
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cli = this.cliPath ?? 'opencode';
      const child = spawn('which', [cli], {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
      setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5000);
    });
  }

  listModels(): string[] {
    return [];
  }

  getModelInfo(): ModelInfo[] {
    return [];
  }

  getDefaultModel(_role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined {
    return undefined;
  }

  getDefaultInvocationTemplate(): string {
    return DEFAULT_INVOCATION_TEMPLATE;
  }

  /**
   * Classify AI invocation results into error types for retry handling.
   */
  classifyResult(result: InvokeResult): ProviderError | null {
    if (result.success) {
      return null;
    }

    const stderr = result.stderr.toLowerCase();
    const stdout = result.stdout.toLowerCase();

    // Rate limit errors
    if (stderr.includes('rate limit') || stderr.includes('too many requests') || stderr.includes('429')) {
      return {
        type: 'rate_limit',
        message: 'Rate limit exceeded',
        retryable: true,
        retryAfterMs: 60000
      };
    }

    // Authentication errors
    if (stderr.includes('unauthorized') || 
        stderr.includes('invalid token') || 
        stderr.includes('authentication failed') ||
        stderr.includes('401')) {
      return {
        type: 'auth_error',
        message: 'Authentication failed',
        retryable: false
      };
    }

    // Model not found errors
    if (stderr.includes('model not found') || 
        stderr.includes('not found') || 
        stderr.includes('404')) {
      return {
        type: 'model_not_found',
        message: 'Model not found',
        retryable: false
      };
    }

    // Invalid request errors
    if (stderr.includes('invalid request') || 
        stderr.includes('bad request') ||
        stderr.includes('400')) {
      return {
        type: 'invalid_prompt',
        message: 'Invalid request',
        retryable: false
      };
    }

    // Out of memory errors
    if (stderr.includes('out of memory') || 
        stderr.includes('oom') ||
        stderr.includes('memory exhausted')) {
      return {
        type: 'subprocess_hung',
        message: 'Out of memory',
        retryable: false
      };
    }

    // Timeout errors
    if (result.timedOut || 
        stderr.includes('timeout') || 
        stderr.includes('deadline exceeded')) {
      return {
        type: 'subprocess_hung',
        message: 'Request timed out',
        retryable: true
      };
    }

    // General server errors
    if (stderr.includes('server error') || 
        stderr.includes('internal server error') ||
        stderr.includes('500')) {
      return {
        type: 'subprocess_hung',
        message: 'Server error',
        retryable: true
      };
    }

    // Network errors
    if (stderr.includes('network error') || 
        stderr.includes('connection refused') ||
        stderr.includes('connection timed out') ||
        stderr.includes('dns lookup failed')) {
      return {
        type: 'network_error',
        message: 'Network error',
        retryable: true
      };
    }

    // Unknown errors - default to retryable
    return {
      type: 'unknown',
      message: result.stderr.slice(0, 200) || 'Unknown error',
      retryable: true
    };
  }
}

export function createOpenCodeProvider(): OpenCodeProvider {
  return new OpenCodeProvider();
}
