/**
 * Shared types and interfaces for AI providers.
 * Implementation lives in interface.ts (BaseAIProvider).
 */

export interface InvokeOptions {
  /** Model identifier (e.g., 'claude-sonnet-4', 'gpt-4') */
  model: string;
  /** Timeout in milliseconds (default: 900000 = 15 minutes) */
  timeout?: number;
  /** Working directory for the invocation */
  cwd?: string;
  /** Path to prompt file (alternative to inline prompt) */
  promptFile?: string;
  /** Role for this invocation (orchestrator, coder, reviewer) */
  role?: 'orchestrator' | 'coder' | 'reviewer';
  /** Custom invocation template (e.g., "claude -p {prompt_file} --model {model}") */
  invocationTemplate?: string;
  /** Whether to stream output to stdout/stderr */
  streamOutput?: boolean;
  /**
   * Optional activity callback for live monitoring.
   * Providers should emit lightweight JSON-serializable events as work progresses.
   */
  onActivity?: (activity: InvocationActivity) => void;
  /** Resume a previous session instead of starting fresh */
  resumeSessionId?: string;
}

/**
 * Activity entry emitted during a provider invocation.
 * Kept intentionally flexible (JSONL logger appends arbitrary fields).
 */
export type InvocationActivity = Record<string, unknown> & { type: string };

export interface TokenUsage {
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Subset served from server-side cache (Codex, Gemini) */
  cachedInputTokens?: number;
  /** Tokens served from cache (Claude) */
  cacheReadTokens?: number;
  /** Tokens written to cache (Claude) */
  cacheCreationTokens?: number;
  /** Total cost for the invocation (Claude, Vibe) */
  totalCostUsd?: number;
}

/**
 * Error thrown when a provider fails to resume a session (e.g., session not found on disk/server)
 */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

export interface InvokeResult {
  /** Whether the invocation succeeded (exit code 0) */
  success: boolean;
  /** Exit code from the CLI process */
  exitCode: number;
  /** Standard output from the process */
  stdout: string;
  /** Standard error from the process */
  stderr: string;
  /** Duration in milliseconds */
  duration: number;
  /** Whether the process was killed due to timeout */
  timedOut: boolean;
  /** Session ID from the provider CLI (if available) */
  sessionId?: string;
  /** Token usage statistics (if available) */
  tokenUsage?: TokenUsage;
}

export type ProviderErrorType =
  | 'rate_limit'
  | 'auth_error'
  | 'network_error'
  | 'model_not_found'
  | 'context_exceeded'
  | 'credit_exhaustion'
  | 'model_capability_error'
  | 'subprocess_hung'
  | 'safety_violation'
  | 'policy_violation'
  | 'invalid_prompt'
  | 'unknown';

export interface ProviderError {
  /** Type of error */
  type: ProviderErrorType;
  /** Human-readable error message */
  message: string;
  /** Whether this error is retryable */
  retryable: boolean;
  /** Suggested retry delay in milliseconds */
  retryAfterMs?: number;
}

export interface ModelInfo {
  /** Model identifier used for invocation */
  id: string;
  /** Human-readable name */
  name: string;
  /** Recommended role for this model */
  recommendedFor?: ('orchestrator' | 'coder' | 'reviewer')[];
  /** Whether this model supports streaming */
  supportsStreaming?: boolean;
  /** Maximum context window size in tokens */
  contextWindow?: number;
}

export interface IAIProvider {
  readonly name: string;
  readonly displayName: string;
  invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult>;
  resume(sessionId: string, prompt: string, options: InvokeOptions): Promise<InvokeResult>;
  initialize?(): Promise<void>;
  isAvailable(): Promise<boolean>;
  listModels(): string[];
  getModelInfo(): ModelInfo[];
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined;
  classifyError(exitCode: number, stderr: string): ProviderError | null;
  classifyResult(result: InvokeResult): ProviderError | null;
  getCliPath(): string | undefined;
  setCliPath(path: string): void;
  getDefaultInvocationTemplate(): string;
  setInvocationTemplate(template: string): void;
  getInvocationTemplate(): string;
}
