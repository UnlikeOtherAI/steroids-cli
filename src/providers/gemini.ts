import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, rmSync, mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type TokenUsage,
  SessionNotFoundError,
} from './interface.js';

const GEMINI_MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    recommendedFor: ['orchestrator', 'coder', 'reviewer'],
    supportsStreaming: true,
    contextWindow: 128000, // Safe default assuming wide window for gemini pro
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    recommendedFor: ['orchestrator', 'coder', 'reviewer'],
    supportsStreaming: true,
    contextWindow: 128000,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    recommendedFor: [],
    supportsStreaming: true,
    contextWindow: 128000,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    recommendedFor: [],
    supportsStreaming: true,
    contextWindow: 128000,
  },
];

const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'gemini-3.1-pro-preview',
  coder: 'gemini-3.1-pro-preview',
  reviewer: 'gemini-3.1-pro-preview',
};

const DEFAULT_TIMEOUT = 900_000;
const SESSION_MARKER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_INVOCATION_TEMPLATE = '{cli} --output-format=stream-json -m {model} {session_id} --prompt "$(cat {prompt_file})"';

export class GeminiProvider extends BaseAIProvider {
  readonly name = 'gemini';
  readonly displayName = 'Google (gemini)';
  private static readonly GEMINI_AUTH_FILES = [
    'settings.json',
    'oauth_creds.json',
    'google_accounts.json',
    'state.json',
    'projects.json',
    'trustedFolders.json',
  ];
  private static readonly GCLOUD_AUTH_FILES = [
    'active_config',
    'credentials.db',
    'configurations/config_default',
  ];

  protected getSanitizedCliEnv(overrides: Record<string, string> = {}): Record<string, string> {
    // Call base class to get API key stripping + cache directory redirection
    const env = super.getSanitizedCliEnv(overrides);

    // Gemini CLI can use GEMINI_API_KEY directly — restore it if it was in the
    // original environment (base class strips it along with other provider keys)
    if (process.env.GEMINI_API_KEY && !overrides.GEMINI_API_KEY) {
      env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    }

    // Filter out undefined values to satisfy Record<string, string> type
    const result: Record<string, string> = {};
    for (const key in env) {
      if (env[key] !== undefined) {
        result[key] = env[key] as string;
      }
    }

    return result;
  }

  private writePromptFile(prompt: string): string {
    const tempPath = join(tmpdir(), `steroids-gemini-${Date.now()}.txt`);
    writeFileSync(tempPath, prompt, { mode: 0o600 });
    return tempPath;
  }

  private cleanupPromptFile(path: string): void {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  getDefaultInvocationTemplate(): string {
    return DEFAULT_INVOCATION_TEMPLATE;
  }

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

  private parseStreamJsonLine(line: string): {
    text?: string;
    tool?: string;
    result?: string;
    sessionId?: string;
    tokenUsage?: TokenUsage;
  } {
    try {
      const event = JSON.parse(line);

      if (event.type === 'init' && event.session_id) {
        return { sessionId: event.session_id };
      }

      if (event.type === 'message' && event.role === 'assistant' && event.content) {
        return { text: event.content };
      }

      if (event.type === 'tool_call' || event.type === 'function_call') {
        return { tool: event.name || event.function?.name || 'tool' };
      }

      if (event.type === 'result') {
        const usage: TokenUsage | undefined = event.stats ? {
          inputTokens: event.stats.input_tokens,
          outputTokens: event.stats.output_tokens,
          cachedInputTokens: event.stats.cached,
        } : undefined;

        return {
          result: event.content || '',
          tokenUsage: usage,
        };
      }
    } catch {
      if (line.trim()) return { text: line };
    }
    return {};
  }

  private getPersistentHome(cwd: string): { home: string; isPersistent: boolean } {
    try {
      const steroidsDir = join(cwd, '.steroids');
      if (existsSync(steroidsDir)) {
        const realSteroidsDir = realpathSync(steroidsDir);
        const persistentHome = join(realSteroidsDir, 'provider-homes', 'gemini');
        mkdirSync(persistentHome, { recursive: true });
        this.setupIsolatedHome('.gemini', GeminiProvider.GEMINI_AUTH_FILES, persistentHome);
        this.setupIsolatedHome('.config/gcloud', GeminiProvider.GCLOUD_AUTH_FILES, persistentHome);
        return { home: persistentHome, isPersistent: true };
      }
    } catch {
      console.warn('Gemini persistent home unavailable, falling back to temporary home');
    }

    const fallbackHome = this.setupIsolatedHome('.gemini', GeminiProvider.GEMINI_AUTH_FILES);
    this.setupIsolatedHome('.config/gcloud', GeminiProvider.GCLOUD_AUTH_FILES, fallbackHome);
    return { home: fallbackHome, isPersistent: false };
  }

  private getSessionMarkerPath(home: string, sessionId: string): string {
    const safeSessionId = encodeURIComponent(sessionId);
    return join(home, '.steroids-gemini-sessions', `${safeSessionId}.marker`);
  }

  private rememberSession(home: string, sessionId: string): void {
    if (!sessionId) return;
    const markerPath = this.getSessionMarkerPath(home, sessionId);
    mkdirSync(join(home, '.steroids-gemini-sessions'), { recursive: true });
    writeFileSync(markerPath, `${Date.now()}\n`, { mode: 0o600 });
  }

  private forgetSession(home: string, sessionId: string): void {
    if (!sessionId) return;
    rmSync(this.getSessionMarkerPath(home, sessionId), { force: true });
  }

  private hasRememberedSession(home: string, sessionId: string): boolean {
    if (!sessionId) return false;
    return existsSync(this.getSessionMarkerPath(home, sessionId));
  }

  private hasNativeSessionArtifact(home: string, sessionId: string): boolean {
    if (!sessionId) return false;
    const candidates = [
      join(home, '.gemini', 'tmp'),
      join(home, '.gemini', 'chats'),
      join(home, '.gemini', 'sessions'),
      join(home, '.vibe', 'logs', 'session'),
    ];
    return candidates.some((dir) => existsSync(dir) && readdirSync(dir).some((name) => name.includes(sessionId)));
  }

  private pruneOldSessionMarkers(home: string): void {
    const markerDir = join(home, '.steroids-gemini-sessions');
    if (!existsSync(markerDir)) return;
    const now = Date.now();
    for (const entry of readdirSync(markerDir)) {
      const markerPath = join(markerDir, entry);
      try {
        const ageMs = now - statSync(markerPath).mtimeMs;
        if (ageMs > SESSION_MARKER_MAX_AGE_MS) rmSync(markerPath, { force: true });
      } catch {
        // Ignore marker cleanup failures
      }
    }
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
    const { home: geminiHome, isPersistent } = this.getPersistentHome(cwd);
    if (isPersistent) this.pruneOldSessionMarkers(geminiHome);

    if (
      resumeSessionId &&
      !this.hasRememberedSession(geminiHome, resumeSessionId) &&
      !this.hasNativeSessionArtifact(geminiHome, resumeSessionId)
    ) {
      return Promise.reject(
        new SessionNotFoundError(`Gemini session ${resumeSessionId} is not available in local session store`)
      );
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutLineBuffer = '';
      let sessionId: string | undefined = resumeSessionId;
      let tokenUsage: TokenUsage | undefined;
      const isStreamJson = this.getInvocationTemplate().includes('stream-json');

      const sessionIdFlag = resumeSessionId ? `--resume ${resumeSessionId}` : '';
      const command = this.buildCommand(promptFile, model, sessionIdFlag);

      const child = spawn(command, {
        shell: true,
        cwd,
        env: this.getSanitizedCliEnv({
          HOME: geminiHome,
          GEMINI_FORCE_FILE_STORAGE: 'true',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin?.end();

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

        if (!isPersistent) {
          try {
            rmSync(geminiHome, { recursive: true, force: true });
          } catch {
          }
        }

        const outputStr = (stdout + '\n' + stderr).toLowerCase();
        const resumeSessionNotFound =
          outputStr.includes('session not found') ||
          outputStr.includes('failed to resume') ||
          outputStr.includes('not found: session') ||
          outputStr.includes('error resuming session') ||
          outputStr.includes('no previous sessions found for this project');
        if (code !== 0 && resumeSessionId && resumeSessionNotFound) {
          this.forgetSession(geminiHome, resumeSessionId);
          reject(new SessionNotFoundError(`Failed to resume Gemini session ${resumeSessionId}`));
          return;
        }

        if (code === 0 && !timedOut) {
          const effectiveSessionId = sessionId ?? resumeSessionId;
          if (effectiveSessionId) {
            this.rememberSession(geminiHome, effectiveSessionId);
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

        if (!isPersistent) {
          try {
            rmSync(geminiHome, { recursive: true, force: true });
          } catch {
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

  async isAvailable(): Promise<boolean> {
    const cli = this.cliPath ?? 'gemini';

    const geminiAvailable = await this.checkCliAvailable(cli);
    if (geminiAvailable) {
      return true;
    }

    if (cli === 'gemini') {
      return this.checkCliAvailable('gcloud');
    }

    return false;
  }

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

      setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5000);
    });
  }

  listModels(): string[] {
    return GEMINI_MODELS.map((m) => m.id);
  }

  getModelInfo(): ModelInfo[] {
    return [...GEMINI_MODELS];
  }

  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }
}

export function createGeminiProvider(): GeminiProvider {
  return new GeminiProvider();
}
