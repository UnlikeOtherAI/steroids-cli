/**
 * Claude Provider
 * Implementation for Anthropic's Claude CLI
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, rmSync } from 'node:fs';
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
 * Available Claude models
 * Use aliases (sonnet, opus, haiku) for latest versions
 */
const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'opus',
    name: 'Claude Opus (latest)',
    recommendedFor: ['orchestrator', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet (latest)',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
  {
    id: 'haiku',
    name: 'Claude Haiku (latest)',
    recommendedFor: [],
    supportsStreaming: true,
  },
];

/**
 * Default models per role
 */
const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'opus',
  coder: 'sonnet',
  reviewer: 'opus',
};

/**
 * Default timeout in milliseconds (15 minutes)
 */
const DEFAULT_TIMEOUT = 900_000;

/**
 * Default invocation template for Claude CLI
 * Uses -p flag for print mode with stream-json for realtime output
 */
const DEFAULT_INVOCATION_TEMPLATE = '{cli} -p "$(cat {prompt_file})" {session_id} --model {model} --output-format stream-json --verbose';

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
   * Parse a stream-json line from Claude CLI and extract text content, sessionId and tokenUsage
   */
  private parseStreamJsonLine(line: string): {
    text?: string;
    tool?: string;
    result?: string;
    sessionId?: string;
    tokenUsage?: TokenUsage;
  } {
    try {
      const event = JSON.parse(line);

      // Assistant message — extract text and tool_use from content blocks
      if (event.type === 'assistant' && event.message?.content) {
        const parts: string[] = [];
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) parts.push(block.text);
          if (block.type === 'tool_use') return { tool: `${block.name}`, sessionId: event.session_id };
        }
        if (parts.length > 0) return { text: parts.join(''), sessionId: event.session_id };
      }

      // Content block delta (raw streaming events)
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return { text: event.delta.text, sessionId: event.session_id };
      }

      // Tool use events from content_block_start
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        return { tool: event.content_block.name, sessionId: event.session_id };
      }

      // Final result contains the complete text and token usage
      if (event.type === 'result') {
        const usage: TokenUsage | undefined = event.usage ? {
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cacheReadTokens: event.usage.cache_read_input_tokens,
          cacheCreationTokens: event.usage.cache_creation_input_tokens,
          totalCostUsd: event.total_cost_usd,
        } : undefined;

        return {
          result: typeof event.result === 'string' ? event.result : '',
          sessionId: event.session_id,
          tokenUsage: usage,
        };
      }

      // Catch session_id from any event type (like 'init')
      if (event.session_id) {
        return { sessionId: event.session_id };
      }
    } catch {
      // Not JSON or unexpected format — treat as plain text
      if (line.trim()) return { text: line };
    }
    return {};
  }

  /**
   * Invoke Claude CLI with a prompt file using the invocation template
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
    // Set up isolated HOME
    const isolatedHome = this.setupIsolatedHome('.claude', ['config.json']);

    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutLineBuffer = '';
      let sessionId: string | undefined = resumeSessionId;
      let tokenUsage: TokenUsage | undefined;
      const isStreamJson = this.getInvocationTemplate().includes('stream-json');

      // Build command from invocation template
      // Convert resumeSessionId to flag if present
      const sessionIdFlag = resumeSessionId ? `--resume ${resumeSessionId}` : '';
      const command = this.buildCommand(promptFile, model, sessionIdFlag);

      // Spawn using shell to handle the command template
      const child = spawn(command, {
        shell: true,
        cwd,
        env: this.getSanitizedCliEnv({
          HOME: isolatedHome,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately — CLI tools (especially Claude with --verbose)
      // hang when stdin pipe stays open, waiting for input that never comes.
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
          // Plain text mode (legacy or custom template)
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

          if (parsed.sessionId) sessionId = parsed.sessionId;
          if (parsed.tokenUsage) tokenUsage = parsed.tokenUsage;

          if (parsed.result !== undefined) {
            // Final result — use as the definitive stdout
            stdout = parsed.result;
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

        // Cleanup isolated home
        try {
          rmSync(isolatedHome, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
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
          sessionId,
          tokenUsage,
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
