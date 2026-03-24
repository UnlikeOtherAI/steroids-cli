import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Types and interfaces live in provider-types.ts; re-exported here for backward compat.
export type {
  InvokeOptions,
  InvocationActivity,
  TokenUsage,
  InvokeResult,
  ProviderErrorType,
  ProviderError,
  ModelInfo,
  IAIProvider,
} from './provider-types.js';
export { SessionNotFoundError } from './provider-types.js';

import type {
  InvokeOptions,
  InvocationActivity,
  InvokeResult,
  ProviderError,
  ModelInfo,
  IAIProvider,
} from './provider-types.js';
import { SessionNotFoundError } from './provider-types.js';

// Re-export SessionNotFoundError is handled above via named export.
export abstract class BaseAIProvider implements IAIProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;

  protected cliPath: string | undefined;
  protected invocationTemplate: string | undefined;

  abstract invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult>;
  abstract isAvailable(): Promise<boolean>;

  /**
   * Initialize the provider (e.g., fetch dynamic models).
   * Default implementation does nothing.
   */
  async initialize(): Promise<void> {
    // No-op by default
  }

  /**
   * Default implementation of resume calls invoke with resumeSessionId in options
   */
  async resume(sessionId: string, prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    return this.invoke(prompt, { ...options, resumeSessionId: sessionId });
  }

  abstract listModels(): string[];
  abstract getModelInfo(): ModelInfo[];
  abstract getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string | undefined;
  abstract getDefaultInvocationTemplate(): string;

  /**
   * Classify an error based on exit code and stderr
   * Subclasses can override for provider-specific error detection
   */
  classifyError(exitCode: number, stderr: string): ProviderError | null {
    if (exitCode === 0) {
      return null;
    }

    const stderrLower = stderr.toLowerCase();

    // Credit / quota exhaustion — check BEFORE rate_limit (more specific)
    // 1. Try structured JSON parsing for error codes
    const creditFromJson = this.detectCreditExhaustionFromJson(stderr);
    if (creditFromJson) {
      return creditFromJson;
    }

    // 2. Special handling for Gemini RESOURCE_EXHAUSTED (can be rate_limit or credit_exhaustion)
    if (stderr.includes('RESOURCE_EXHAUSTED')) {
      if (/per.?minute|per.?second|retry after/i.test(stderr)) {
        return {
          type: 'rate_limit',
          message: 'Rate limit exceeded',
          retryable: true,
          retryAfterMs: 60000,
        };
      }
      if (/demand|compute|pressure|busy|wait/i.test(stderr)) {
        return {
          type: 'rate_limit',
          message: 'High compute demand, waiting for capacity',
          retryable: true,
          retryAfterMs: 300000, // 5 minutes
        };
      }
      if (/billing|budget|hard limit/i.test(stderr)) {
        return {
          type: 'credit_exhaustion',
          message: stderr.slice(0, 500) || 'Credit/quota exhausted',
          retryable: false,
        };
      }
    }

    // 3. Regex fallback for credit/quota patterns
    if (/insufficient.?(credit|fund|balance|quota)|quota.?exceed|billing|payment.?(required|failed)|out of (credits|tokens)|usage.?limit|hit.+usage.?limit|plan.?limit|subscription.?(expired|inactive)|exceeded your current quota|purchase more credits/i.test(stderr)) {
      return {
        type: 'credit_exhaustion',
        message: stderr.slice(0, 500) || 'Credit/quota exhausted',
        retryable: false,
      };
    }

    if (stderrLower.includes('rate limit') || stderr.includes('429') ||
        stderrLower.includes('overloaded') || stderrLower.includes('capacity') ||
        stderrLower.includes('busy')) {
      return {
        type: 'rate_limit',
        message: 'Provider is overloaded or rate limited',
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

    if (/does not support tool|tool.?calling.+not supported|missing required tool call|function.?calling.+not supported/i.test(stderr)) {
      return {
        type: 'model_capability_error',
        message: 'Model capability mismatch',
        retryable: false,
      };
    }

    return {
      type: 'unknown',
      message: stderr.slice(0, 200) || 'Unknown error',
      retryable: true,
    };
  }

  /**
   * Classify a full invocation result, checking both stderr and stdout
   */
  classifyResult(result: InvokeResult): ProviderError | null {
    if (result.success) {
      return null;
    }

    const stderrClassification = this.classifyError(result.exitCode, result.stderr);
    if (stderrClassification && stderrClassification.type !== 'unknown') {
      return stderrClassification;
    }

    // Some providers put JSON errors in stdout
    const stdoutClassification = this.classifyError(result.exitCode, result.stdout);
    if (stdoutClassification && stdoutClassification.type !== 'unknown') {
      return stdoutClassification;
    }

    // Fallback to stderr classification (unknown)
    return stderrClassification;
  }

  /**
   * Try to detect credit exhaustion from structured JSON error responses
   */
  private detectCreditExhaustionFromJson(output: string): ProviderError | null {
    try {
      const parsed = JSON.parse(output);
      const errorObj = parsed?.error ?? parsed;
      const code = errorObj?.code ?? '';
      const type = errorObj?.type ?? '';
      const combined = `${code} ${type}`.toLowerCase();

      if (/insufficient_quota|billing_hard_limit_reached/.test(combined)) {
        return {
          type: 'credit_exhaustion',
          message: errorObj?.message ?? output.slice(0, 500) ?? 'Credit/quota exhausted',
          retryable: false,
        };
      }
    } catch {
      // Not valid JSON — fall through to regex patterns
    }
    return null;
  }

  getCliPath(): string | undefined {
    return this.cliPath;
  }

  setCliPath(path: string): void {
    this.cliPath = path;
  }

  setInvocationTemplate(template: string): void {
    this.invocationTemplate = template;
  }

  getInvocationTemplate(): string {
    return this.invocationTemplate ?? this.getDefaultInvocationTemplate();
  }

  /**
   * Build the command from the invocation template
   * @param promptFile Path to the prompt file
   * @param model Model identifier
   * @param sessionId Optional session ID for resumption
   * @returns Command string ready for execution
   */
  protected buildCommand(promptFile: string, model: string, sessionId?: string): string {
    const template = this.getInvocationTemplate();
    const cli = this.cliPath ?? this.name;

    return template
      .replace('{cli}', cli)
      .replace('{prompt_file}', promptFile)
      .replace('{model}', model)
      .replace('{session_id}', sessionId ?? '');
  }

  /**
   * Build child process env for provider CLI invocation.
   *
   * Strips known provider API-key env vars so the spawned CLI
   * falls back to its own OAuth / login credentials instead of
   * accidentally using Steroids' internal keys (e.g.
   * STEROIDS_ANTHROPIC leaking as ANTHROPIC_API_KEY).
   */
  protected getSanitizedCliEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Remove raw provider API keys — CLIs should use their own auth
    // Also remove session nesting markers (CLAUDECODE) so spawned CLIs don't refuse to run
    const keysToStrip = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_CLOUD_API_KEY',
      'MISTRAL_API_KEY',
      'HF_TOKEN',
      'OLLAMA_API_KEY',
      'CLAUDECODE',
    ];
    for (const key of keysToStrip) {
      delete env[key];
    }

    // When HOME is overridden (isolated provider home), redirect cache directories
    // back to the real user's cache locations. Without this, tools like pnpm,
    // Playwright, and Prisma cache hundreds of MB into each project's provider-home.
    if (overrides?.HOME && overrides.HOME !== homedir()) {
      const realHome = homedir();
      const isDarwin = process.platform === 'darwin';
      const pnpmHome = isDarwin
        ? join(realHome, 'Library', 'pnpm')
        : join(realHome, '.local', 'share', 'pnpm');
      const cacheOverrides: Record<string, string> = {
        // XDG standard — covers most Linux/cross-platform tools
        XDG_CACHE_HOME: join(realHome, '.cache'),
        // Playwright: macOS uses ~/Library/Caches/, Linux uses ~/.cache/
        PLAYWRIGHT_BROWSERS_PATH: isDarwin
          ? join(realHome, 'Library', 'Caches', 'ms-playwright')
          : join(realHome, '.cache', 'ms-playwright'),
        // npm cache redirection
        npm_config_cache: join(realHome, '.npm'),
        // pnpm: share the binary home AND content-addressable store so provider
        // CLIs (Codex, Claude) don't re-download/install pnpm on every invocation.
        PNPM_HOME: pnpmHome,
        PNPM_STORE_DIR: join(pnpmHome, 'store'),
        // Prisma engine cache directory (PRISMA_ENGINES_DIR, not PRISMA_ENGINES_MIRROR)
        PRISMA_ENGINES_DIR: join(realHome, '.cache', 'prisma', 'engines'),
      };
      // Only set cache overrides if not already explicitly set by caller
      for (const [key, value] of Object.entries(cacheOverrides)) {
        if (!overrides[key]) {
          env[key] = value;
        }
      }

      // Prepend real user's pnpm and npm global bin dirs to PATH so provider
      // CLIs find already-installed tools (pnpm, npx, etc.) without re-installing.
      const realBinDirs = [
        pnpmHome,                                      // pnpm global bin
        join(realHome, '.npm', 'bin'),                  // npm global bin
        isDarwin ? '/opt/homebrew/bin' : '/usr/local/bin', // system package managers
      ].filter((d) => existsSync(d));
      if (realBinDirs.length > 0) {
        const currentPath = env.PATH ?? process.env.PATH ?? '';
        env.PATH = [...realBinDirs, currentPath].join(':');
      }
    }

    // Prevent git from invoking the macOS Keychain credential helper inside isolated
    // home dirs. The real .gitconfig is symlinked in (so git finds it), but its
    // credential.helper = osxkeychain setting causes macOS to show "Keychain Not
    // Found" dialogs when the spawned process has no keychain session (e.g. when
    // launched from launchd as a detached child). Override via git env vars so the
    // helper is disabled for all child processes without touching the real gitconfig.
    if (overrides?.HOME && overrides.HOME !== homedir()) {
      env.GIT_TERMINAL_PROMPT = '0';
      // GIT_CONFIG_COUNT/KEY/VALUE overrides take precedence over all gitconfig files
      const existingCount = parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
      env.GIT_CONFIG_COUNT = String(existingCount + 1);
      env[`GIT_CONFIG_KEY_${existingCount}`] = 'credential.helper';
      env[`GIT_CONFIG_VALUE_${existingCount}`] = '';
    }

    // Cap Node.js heap for child processes to prevent runaway memory consumption.
    // Provider CLIs (Codex, Claude) spawn sub-processes (pnpm, tsc, etc.) that
    // can each balloon to GBs and trigger massive macOS swap on constrained systems.
    if (!overrides?.NODE_OPTIONS?.includes('max-old-space-size')) {
      const existing = env.NODE_OPTIONS ?? '';
      env.NODE_OPTIONS = `${existing} --max-old-space-size=1536`.trim();
    }

    // HF proxy: if caller signals an HF model, inject proxy URL into env
    // so the CLI connects to the local proxy instead of its native API.
    if (overrides?.STEROIDS_HF_PROXY_URL) {
      env.OPENAI_BASE_URL = overrides.STEROIDS_HF_PROXY_URL;
      env.OPENAI_API_KEY = 'hf-proxy';
      env.ANTHROPIC_BASE_URL = overrides.STEROIDS_HF_PROXY_URL;
      env.ANTHROPIC_API_KEY = 'hf-proxy';
    }

    // Apply caller overrides (excluding internal signal vars)
    const { STEROIDS_HF_PROXY_URL: _hfSignal, ...cleanOverrides } = overrides ?? {};
    return { ...env, ...cleanOverrides };
  }

  /**
   * Set up a minimal isolated home directory for a provider CLI.
   *
   * Only used by providers that store session state locally and need isolation
   * between parallel invocations (Gemini, Codex). Providers that don't write
   * local session state (Claude with -p flag, Mistral via VIBE_HOME) should
   * NOT use this — they should run with the real HOME or a targeted env var.
   *
   * Creates a minimal dir with:
   *  - an isolated providerDir containing only auth-file symlinks
   *  - symlinks for .gitconfig, .ssh, and any extra rootFiles
   *
   * @param providerDir Provider-specific config/state dir (e.g. '.gemini', '.config/gcloud')
   * @param authFiles Auth/config filenames to symlink into the isolated providerDir
   * @param baseDir Optional pre-existing dir to use (e.g. per-project persistent home)
   * @param rootFiles Extra HOME-root files to symlink (e.g. ['.npmrc'])
   */
  protected setupIsolatedHome(providerDir: string, authFiles: string[], baseDir?: string, rootFiles?: string[]): string {
    const uuid = randomUUID();
    const isolatedHome = baseDir ?? join(tmpdir(), `steroids-${this.name}-${uuid}`);
    const realHome = homedir();

    try {
      if (!baseDir) {
        mkdirSync(isolatedHome, { recursive: true });
      }

      // Create isolated provider dir with auth-file symlinks
      const realProviderPath = join(realHome, providerDir);
      const isolatedProviderPath = join(isolatedHome, providerDir);

      if (existsSync(realProviderPath)) {
        mkdirSync(isolatedProviderPath, { recursive: true });

        for (const file of authFiles) {
          const src = join(realProviderPath, file);
          const dest = join(isolatedProviderPath, file);
          if (existsSync(src)) {
            try {
              mkdirSync(dirname(dest), { recursive: true });
              symlinkSync(src, dest);
            } catch {
              // Fallback to copy if symlink fails (e.g. cross-device)
              try {
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, readFileSync(src));
              } catch { /* best effort */ }
            }
          }
        }
      }

      // Essential HOME-root symlinks so git and SSH work from the isolated home
      [...(rootFiles ?? []), '.gitconfig', '.ssh'].forEach(file => {
        const src = join(realHome, file);
        const dest = join(isolatedHome, file);
        if (existsSync(src) && !existsSync(dest)) {
          try { symlinkSync(src, dest); } catch { /* best effort */ }
        }
      });

    } catch (e) {
      console.warn(`Failed to set up isolated ${this.name} home: ${e}`);
    }

    return isolatedHome;
  }
}
