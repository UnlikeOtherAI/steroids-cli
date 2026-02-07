/**
 * AI Provider Interface
 * Defines the contract for AI providers (Claude, Gemini, OpenAI, etc.)
 */

/**
 * Options for invoking an AI provider
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
}

/**
 * Result of an AI provider invocation
 */
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
}

/**
 * Error types that can be classified from provider output
 */
export type ProviderErrorType =
  | 'rate_limit'
  | 'auth_error'
  | 'network_error'
  | 'model_not_found'
  | 'context_exceeded'
  | 'subprocess_hung'
  | 'unknown';

/**
 * Classified error from provider invocation
 */
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

/**
 * Model information
 */
export interface ModelInfo {
  /** Model identifier used for invocation */
  id: string;
  /** Human-readable name */
  name: string;
  /** Recommended role for this model */
  recommendedFor?: ('orchestrator' | 'coder' | 'reviewer')[];
  /** Whether this model supports streaming */
  supportsStreaming?: boolean;
}

/**
 * AI Provider interface
 * All providers must implement this interface
 */
export interface IAIProvider {
  /** Provider name (e.g., 'claude', 'gemini', 'openai') */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /**
   * Invoke the provider with a prompt
   * @param prompt The prompt text to send
   * @param options Invocation options
   * @returns Promise resolving to the invocation result
   */
  invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult>;

  /**
   * Check if this provider is available (CLI installed and accessible)
   * @returns Promise resolving to true if available
   */
  isAvailable(): Promise<boolean>;

  /**
   * List available models for this provider
   * @returns Array of model identifiers
   */
  listModels(): string[];

  /**
   * Get detailed model information
   * @returns Array of model info objects
   */
  getModelInfo(): ModelInfo[];

  /**
   * Get the default model for a role
   * @param role The role to get default model for
   * @returns Default model ID or undefined
   */
  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined;

  /**
   * Classify an error from stderr output
   * @param exitCode The process exit code
   * @param stderr The stderr output
   * @returns Classified error or null if not an error
   */
  classifyError(exitCode: number, stderr: string): ProviderError | null;

  /**
   * Get the CLI path for this provider
   * @returns Path to CLI executable or undefined if using default
   */
  getCliPath(): string | undefined;

  /**
   * Set a custom CLI path
   * @param path Path to CLI executable
   */
  setCliPath(path: string): void;
}

/**
 * Base abstract class for AI providers
 * Provides common functionality
 */
export abstract class BaseAIProvider implements IAIProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;

  protected cliPath: string | undefined;

  abstract invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult>;
  abstract isAvailable(): Promise<boolean>;
  abstract listModels(): string[];
  abstract getModelInfo(): ModelInfo[];
  abstract getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined;

  /**
   * Classify an error based on exit code and stderr
   * Subclasses can override for provider-specific error detection
   */
  classifyError(exitCode: number, stderr: string): ProviderError | null {
    if (exitCode === 0) {
      return null;
    }

    const stderrLower = stderr.toLowerCase();

    if (stderrLower.includes('rate limit') || stderr.includes('429')) {
      return {
        type: 'rate_limit',
        message: 'Rate limit exceeded',
        retryable: true,
        retryAfterMs: 60000,
      };
    }

    if (stderrLower.includes('unauthorized') || stderrLower.includes('auth')) {
      return {
        type: 'auth_error',
        message: 'Authentication failed',
        retryable: false,
      };
    }

    if (stderrLower.includes('connection') || stderrLower.includes('timeout') ||
        stderrLower.includes('network')) {
      return {
        type: 'network_error',
        message: 'Network error',
        retryable: true,
      };
    }

    if (stderrLower.includes('model') && stderrLower.includes('not found')) {
      return {
        type: 'model_not_found',
        message: 'Model not found',
        retryable: false,
      };
    }

    if (stderrLower.includes('context') || stderrLower.includes('token limit') ||
        stderrLower.includes('too long')) {
      return {
        type: 'context_exceeded',
        message: 'Context limit exceeded',
        retryable: false,
      };
    }

    return {
      type: 'unknown',
      message: stderr.slice(0, 200) || 'Unknown error',
      retryable: true,
    };
  }

  getCliPath(): string | undefined {
    return this.cliPath;
  }

  setCliPath(path: string): void {
    this.cliPath = path;
  }
}
