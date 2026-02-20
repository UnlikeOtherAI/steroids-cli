/**
 * Codex Provider
 * Implementation for OpenAI Codex CLI
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
 * Available Codex models
 */
const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    recommendedFor: ['reviewer'],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string | undefined> = {
  orchestrator: undefined,
  coder: undefined,
  reviewer: 'codex',
};

/**
 * Default timeout in milliseconds (15 minutes)
 */
const DEFAULT_TIMEOUT = 900_000;

/**
 * Default invocation template for Codex CLI
 * Uses dangerously-bypass-approvals-and-sandbox for full git access
 * --skip-git-repo-check allows running outside trusted directories
 * WARNING: This bypasses all sandboxing - use only in controlled environments
 */
const DEFAULT_INVOCATION_TEMPLATE = 'cat {prompt_file} | {cli} exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -';

/**
 * Codex AI Provider implementation
 */
export class CodexProvider extends BaseAIProvider {
  readonly name = 'codex';
  readonly displayName = 'OpenAI (Codex)';

  /**
   * Write prompt to a temporary file
   */
  private writePromptFile(prompt: string): string {
    const tempPath = join(tmpdir(), `steroids-codex-${Date.now()}.txt`);
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
   * Invoke Codex CLI with a prompt
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
   * Invoke Codex CLI with a prompt file using the invocation template
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
      let stdoutParseBuffer = '';
      let expectingToolCmd = false;

      // Build command from invocation template
      const command = this.buildCommand(promptFile, model);

      // Spawn using shell to handle the command template
      const child = spawn(command, {
        shell: true,
        cwd,
        env: this.getSanitizedCliEnv(),
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
        const text = data.toString();
        if (stdout.length < MAX_BUFFER) stdout += text;
        resetActivityTimer();
        if (streamOutput) {
          process.stdout.write(text);
        }

        if (!onActivity) return;

        // Best-effort parsing for Codex CLI tool execution markers:
        // Some versions emit lines like:
        //   exec
        //   <command>
        // We interpret that as a tool event and otherwise forward text as output.
        stdoutParseBuffer += text;
        while (true) {
          const nl = stdoutParseBuffer.indexOf('\n');
          if (nl === -1) break;
          const line = stdoutParseBuffer.slice(0, nl);
          stdoutParseBuffer = stdoutParseBuffer.slice(nl + 1);

          if (expectingToolCmd) {
            const cmd = line.trim();
            if (cmd) onActivity({ type: 'tool', cmd });
            expectingToolCmd = false;
            continue;
          }

          if (line === 'exec') {
            expectingToolCmd = true;
            continue;
          }

          onActivity({ type: 'output', stream: 'stdout', msg: `${line}\n` });
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

        if (onActivity && stdoutParseBuffer) {
          // Flush remaining unterminated line.
          if (expectingToolCmd) {
            const cmd = stdoutParseBuffer.trim();
            if (cmd) onActivity({ type: 'tool', cmd });
          } else {
            onActivity({ type: 'output', stream: 'stdout', msg: stdoutParseBuffer });
          }
        }

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
   * Check if Codex CLI is available
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cli = this.cliPath ?? 'codex';

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
    return CODEX_MODELS.map((m) => m.id);
  }

  /**
   * Get detailed model information
   */
  getModelInfo(): ModelInfo[] {
    return [...CODEX_MODELS];
  }

  /**
   * Get the default model for a role
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined {
    return DEFAULT_MODELS[role];
  }
}

/**
 * Create a Codex provider instance
 */
export function createCodexProvider(): CodexProvider {
  return new CodexProvider();
}
