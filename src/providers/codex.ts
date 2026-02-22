/**
 * Codex Provider
 * Implementation for OpenAI Codex CLI
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type TokenUsage,
} from './interface.js';

/**
 * Available Codex models
 */
const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    recommendedFor: ['coder', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    recommendedFor: ['coder', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'o3',
    name: 'O3',
    recommendedFor: ['orchestrator'],
    supportsStreaming: true,
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    recommendedFor: ['reviewer'],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string | undefined> = {
  orchestrator: 'o3',
  coder: 'gpt-5.3-codex',
  reviewer: 'gpt-5.3-codex',
};

/**
 * Default timeout in milliseconds (15 minutes)
 */
const DEFAULT_TIMEOUT = 900_000;

/**
 * Default invocation template for Codex CLI
 * Uses dangerously-bypass-approvals-and-sandbox for full git access
 * --skip-git-repo-check allows running outside trusted directories
 * --json mode for session and token tracking
 * WARNING: This bypasses all sandboxing - use only in controlled environments
 */
const DEFAULT_INVOCATION_TEMPLATE = 'cat {prompt_file} | {cli} exec {session_id} --model {model} --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -';

/**
 * Codex AI Provider implementation
 */
export class CodexProvider extends BaseAIProvider {
  readonly name = 'codex';
  readonly displayName = 'OpenAI (codex)';

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
   * Parse a JSONL line from Codex CLI and extract relevant information
   */
  private parseJsonlLine(line: string): {
    text?: string;
    tool?: string;
    sessionId?: string;
    tokenUsage?: TokenUsage;
    error?: string;
  } {
    try {
      const event = JSON.parse(line);

      // Thread started — capture thread_id as session ID
      if (event.type === 'thread.started' && event.thread_id) {
        return { sessionId: event.thread_id };
      }

      // Error event — capture error message (rate limits, credit exhaustion, etc.)
      if (event.type === 'error' && event.message) {
        return { error: event.message };
      }

      // Turn failed — capture error message
      if (event.type === 'turn.failed' && event.error?.message) {
        return { error: event.error.message };
      }

      // Item completed — extract text content if it's an agent message
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        return { text: event.item.text };
      }

      // Tool call — from item.started or item.completed
      if (event.item?.type === 'tool_call') {
        return { tool: event.item.name };
      }

      // Turn completed — capture token usage
      if (event.type === 'turn.completed' && event.usage) {
        return {
          tokenUsage: {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
          },
        };
      }
    } catch {
      // Not JSON — fallback to plain text if not empty
      if (line.trim()) return { text: line };
    }
    return {};
  }

  /**
   * Get or create a persistent Codex home for the given project.
   * Unlike temp-dir isolated homes, this persists across invocations
   * so Codex session/thread state is preserved for resume.
   */
  private getPersistentHome(cwd: string): { home: string; isPersistent: boolean } {
    try {
      // Check if cwd has a .steroids directory (project-managed)
      const steroidsDir = join(cwd, '.steroids');
      if (existsSync(steroidsDir)) {
        // Resolve through symlinks to get the canonical path
        const realSteroidsDir = realpathSync(steroidsDir);
        const persistentHome = join(realSteroidsDir, 'provider-homes', 'codex');
        mkdirSync(persistentHome, { recursive: true });

        // Set up auth files if not already done
        this.setupIsolatedHome('.codex', ['auth.json', 'config.yaml', 'state.json'], persistentHome);
        return { home: persistentHome, isPersistent: true };
      }
    } catch {
      // Fall through to temp dir
    }

    // Fallback: use temp dir (non-persistent, will be cleaned up)
    return {
      home: this.setupIsolatedHome('.codex', ['auth.json', 'config.yaml', 'state.json']),
      isPersistent: false,
    };
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
    onActivity?: InvokeOptions['onActivity'],
    resumeSessionId?: string
  ): Promise<InvokeResult> {
    // Use persistent home to preserve session/thread state across invocations
    const { home: isolatedHome, isPersistent } = this.getPersistentHome(cwd);

    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutLineBuffer = '';
      let sessionId: string | undefined = resumeSessionId;
      let tokenUsage: TokenUsage | undefined;
      let expectingToolCmd = false;
      const isJson = this.getInvocationTemplate().includes('--json');

      // Build command from invocation template
      // Convert resumeSessionId to subcommand if present
      const sessionIdSubcmd = resumeSessionId ? `resume ${resumeSessionId}` : '';
      const command = this.buildCommand(promptFile, model, sessionIdSubcmd);

      // Spawn using shell to handle the command template
      const child = spawn(command, {
        shell: true,
        cwd,
        env: this.getSanitizedCliEnv({
          HOME: isolatedHome,
        }),
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

        if (!isJson) {
          // Plain text mode (legacy or custom template)
          if (stdout.length < MAX_BUFFER) stdout += raw;
          if (streamOutput) process.stdout.write(raw);

          if (!onActivity) return;

          // Best-effort parsing for Codex CLI tool execution markers
          stdoutLineBuffer += raw;
          while (true) {
            const nl = stdoutLineBuffer.indexOf('\n');
            if (nl === -1) break;
            const line = stdoutLineBuffer.slice(0, nl);
            stdoutLineBuffer = stdoutLineBuffer.slice(nl + 1);

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
          return;
        }

        // JSONL mode: parse JSONL events
        stdoutLineBuffer += raw;
        while (true) {
          const nl = stdoutLineBuffer.indexOf('\n');
          if (nl === -1) break;
          const line = stdoutLineBuffer.slice(0, nl).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(nl + 1);
          if (!line) continue;

          const parsed = this.parseJsonlLine(line);

          if (parsed.sessionId) sessionId = parsed.sessionId;
          if (parsed.tokenUsage) tokenUsage = { ...tokenUsage, ...parsed.tokenUsage };

          // Capture JSONL error events (rate limits, credit exhaustion) into stderr
          if (parsed.error) {
            if (stderr.length < MAX_BUFFER) stderr += parsed.error + '\n';
            onActivity?.({ type: 'output', stream: 'stderr', msg: parsed.error });
            if (streamOutput) process.stderr.write(`[codex error] ${parsed.error}\n`);
          }

          if (parsed.text) {
            // Ensure agent_message chunks are newline-separated so DECISION: tokens
            // remain at line boundaries when multiple messages are concatenated
            // (e.g. on session resume, history replay emits multiple item.completed events)
            const chunk = stdout.length > 0 && !stdout.endsWith('\n')
              ? '\n' + parsed.text
              : parsed.text;
            if (stdout.length < MAX_BUFFER) stdout += chunk;
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

        if (onActivity && stdoutLineBuffer && !isJson) {
          // Flush remaining unterminated line.
          if (expectingToolCmd) {
            const cmd = stdoutLineBuffer.trim();
            if (cmd) onActivity({ type: 'tool', cmd });
          } else {
            onActivity({ type: 'output', stream: 'stdout', msg: stdoutLineBuffer });
          }
        }

        // Only cleanup temp-dir homes, not persistent ones
        if (!isPersistent) {
          try {
            rmSync(isolatedHome, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        }

        resolve({
          success: code === 0 && !timedOut,
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
        const duration = Date.now() - startTime;

        // Only cleanup temp-dir homes, not persistent ones
        if (!isPersistent) {
          try {
            rmSync(isolatedHome, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        }

        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          duration,
          timedOut: false,
          sessionId,
          tokenUsage,
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
