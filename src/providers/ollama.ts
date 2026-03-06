/**
 * Ollama Provider
 * Native /api/chat inference with NDJSON streaming, plus /v1/models discovery.
 */

import { TextDecoder } from 'node:util';
import { loadConfig } from '../config/loader.js';
import {
  createOllamaApiClient,
  getCloudApiKey,
  getResolvedConnectionConfig,
  type OllamaConnectionMode,
} from '../ollama/connection.js';
import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type ProviderError,
  type TokenUsage,
} from './interface.js';
import {
  EndpointSemaphore,
  type SemaphoreRelease,
  extractContextLength,
  normalizePositiveInt,
  OLLAMA_FALLBACK_MODELS,
  recommendRoles,
} from './ollama-utils.js';

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_LOCAL_MAX_CONCURRENT = 1;
const DEFAULT_CLOUD_MAX_CONCURRENT = 3;
const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;
const DEFAULT_NUM_CTX = 32_768;
const MIN_NUM_CTX = 8_192;
const MAX_ERROR_BODY = 4_000;

const DEFAULT_MODELS: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'llama3.3:70b',
  coder: 'qwen2.5-coder:32b',
  reviewer: 'llama3.3:70b',
};

interface EndpointConfig {
  endpoint: string;
  mode: OllamaConnectionMode;
  apiKey?: string;
  maxConcurrent: number;
  queueTimeoutMs: number;
}

interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: unknown[];
  };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

/**
 * Ollama AI Provider implementation
 */
export class OllamaProvider extends BaseAIProvider {
  readonly name = 'ollama';
  readonly displayName = 'Ollama';

  private dynamicModels: ModelInfo[] = [];
  private modelContextCache: Map<string, number> = new Map();
  private static semaphores: Map<string, EndpointSemaphore> = new Map();

  async isAvailable(): Promise<boolean> {
    try {
      const client = createOllamaApiClient(getResolvedConnectionConfig());
      await client.listInstalledModels();
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    await this.fetchModels();
  }

  async fetchModels(): Promise<void> {
    const client = createOllamaApiClient(getResolvedConnectionConfig());

    try {
      const result = await client.listOpenAIModels();
      const models = result.data ?? [];

      this.dynamicModels = models.map((model) => {
        const id = model.id;
        return {
          id,
          name: id,
          recommendedFor: recommendRoles(id),
          supportsStreaming: true,
          contextWindow: this.modelContextCache.get(id) ?? DEFAULT_NUM_CTX,
        };
      });
    } catch {
      try {
        const tags = await client.listInstalledModels();
        this.dynamicModels = (tags.models ?? []).map((model) => ({
          id: model.name,
          name: model.name,
          recommendedFor: recommendRoles(model.name),
          supportsStreaming: true,
          contextWindow: this.modelContextCache.get(model.name) ?? DEFAULT_NUM_CTX,
        }));
      } catch {
        this.dynamicModels = [];
      }
    }
  }

  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const startTime = Date.now();
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const onActivity = options.onActivity;
    const model = options.model;
    const endpointConfig = this.resolveEndpointConfig();

    let release: SemaphoreRelease | undefined;
    try {
      release = await this.acquireEndpointSlot(endpointConfig);
    } catch (error) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : 'All Ollama slots busy',
        duration: Date.now() - startTime,
        timedOut: true,
      };
    }

    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), timeout);

    try {
      const numCtx = await this.resolveContextWindow(model, endpointConfig);
      const payload = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        options: {
          temperature: 0.8,
          top_p: 0.9,
          num_predict: -1,
          num_ctx: numCtx,
          seed: 0,
        },
      };

      const response = await fetch(`${endpointConfig.endpoint}/api/chat`, {
        method: 'POST',
        headers: this.buildHeaders(endpointConfig.apiKey),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = (await response.text()).slice(0, MAX_ERROR_BODY);
        return {
          success: false,
          exitCode: response.status || 1,
          stdout: '',
          stderr: errorBody || `Ollama API request failed: ${response.status}`,
          duration: Date.now() - startTime,
          timedOut: false,
        };
      }

      if (!response.body) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: 'Ollama response did not include a body stream',
          duration: Date.now() - startTime,
          timedOut: false,
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stdout = '';
      let finalChunk: OllamaStreamChunk | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const consumed = this.consumeBuffer(buffer, (chunk) => {
          if (chunk.error) {
            throw new Error(chunk.error);
          }

          const delta = chunk.message?.content ?? '';
          if (delta) {
            stdout += delta;
            onActivity?.({
              type: 'output',
              text: delta,
            });
          }

          if (chunk.done) {
            finalChunk = chunk;
          }
        });
        buffer = consumed;
      }

      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) {
        const chunk = JSON.parse(tail) as OllamaStreamChunk;
        if (chunk.error) {
          throw new Error(chunk.error);
        }
        const delta = chunk.message?.content ?? '';
        if (delta) {
          stdout += delta;
          onActivity?.({
            type: 'output',
            text: delta,
          });
        }
        if (chunk.done) {
          finalChunk = chunk;
        }
      }

      if (!finalChunk?.done) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: 'Ollama stream ended before final done:true chunk',
          duration: Date.now() - startTime,
          timedOut: false,
        };
      }

      const tokenUsage = this.extractTokenUsage(finalChunk);
      return {
        success: true,
        exitCode: 0,
        stdout,
        stderr: '',
        duration: Date.now() - startTime,
        timedOut: false,
        tokenUsage,
      };
    } catch (error) {
      const timedOut = this.isAbortError(error);
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: this.mapInvocationError(error, timeout),
        duration: Date.now() - startTime,
        timedOut,
      };
    } finally {
      clearTimeout(requestTimeout);
      release();
    }
  }

  listModels(): string[] {
    const models = this.dynamicModels.length > 0 ? this.dynamicModels : OLLAMA_FALLBACK_MODELS;
    return models.map((model) => model.id);
  }

  getModelInfo(): ModelInfo[] {
    if (this.dynamicModels.length > 0) {
      return [...this.dynamicModels];
    }
    return [...OLLAMA_FALLBACK_MODELS];
  }

  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS[role];
  }

  getDefaultInvocationTemplate(): string {
    return '';
  }

  override classifyError(exitCode: number, stderr: string): ProviderError | null {
    const lowered = stderr.toLowerCase();
    if (exitCode !== 0 && (lowered.includes('out of memory') || lowered.includes('insufficient memory'))) {
      return {
        type: 'unknown',
        message: 'Ollama out of memory',
        retryable: false,
      };
    }
    return super.classifyError(exitCode, stderr);
  }

  static resetSemaphoresForTests(): void {
    this.semaphores.clear();
  }

  private consumeBuffer(buffer: string, onChunk: (chunk: OllamaStreamChunk) => void): string {
    let working = buffer;
    while (true) {
      const newlineIndex = working.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = working.slice(0, newlineIndex).trim();
      working = working.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      const chunk = JSON.parse(line) as OllamaStreamChunk;
      onChunk(chunk);
    }

    return working;
  }

  private extractTokenUsage(chunk?: OllamaStreamChunk): TokenUsage | undefined {
    const inputTokens = chunk?.prompt_eval_count;
    const outputTokens = chunk?.eval_count;
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
      return undefined;
    }
    return {
      inputTokens,
      outputTokens,
    };
  }

  private resolveEndpointConfig(): EndpointConfig {
    const resolved = getResolvedConnectionConfig();
    const configured = this.readProviderConfig();
    const maxConcurrent =
      normalizePositiveInt(configured.maxConcurrent) ??
      (resolved.mode === 'cloud' ? DEFAULT_CLOUD_MAX_CONCURRENT : DEFAULT_LOCAL_MAX_CONCURRENT);
    const queueTimeoutMs =
      normalizePositiveInt(configured.queueTimeoutMs) ??
      DEFAULT_QUEUE_TIMEOUT_MS;

    return {
      endpoint: resolved.endpoint,
      mode: resolved.mode,
      apiKey: resolved.mode === 'cloud' ? getCloudApiKey() : undefined,
      maxConcurrent,
      queueTimeoutMs,
    };
  }

  private readProviderConfig(): { maxConcurrent?: number; queueTimeoutMs?: number } {
    const config = loadConfig() as { ollama?: { maxConcurrent?: number; queueTimeoutMs?: number } };

    const envMaxConcurrent = normalizePositiveInt(process.env.STEROIDS_OLLAMA_MAX_CONCURRENT);
    const envQueueTimeoutMs = normalizePositiveInt(process.env.STEROIDS_OLLAMA_QUEUE_TIMEOUT_MS);

    return {
      maxConcurrent: envMaxConcurrent ?? config.ollama?.maxConcurrent,
      queueTimeoutMs: envQueueTimeoutMs ?? config.ollama?.queueTimeoutMs,
    };
  }

  private acquireEndpointSlot(config: EndpointConfig): Promise<SemaphoreRelease> {
    const key = config.endpoint;
    const existing = OllamaProvider.semaphores.get(key);
    if (existing) {
      existing.setMaxConcurrent(config.maxConcurrent);
      return existing.acquire(config.queueTimeoutMs);
    }

    const semaphore = new EndpointSemaphore(config.maxConcurrent);
    OllamaProvider.semaphores.set(key, semaphore);
    return semaphore.acquire(config.queueTimeoutMs);
  }

  private buildHeaders(apiKey?: string): Headers {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson, application/json',
    });
    if (apiKey) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    return headers;
  }

  private async resolveContextWindow(model: string, config: EndpointConfig): Promise<number> {
    const cached = this.modelContextCache.get(model);
    if (cached) {
      return cached;
    }

    let contextWindow = DEFAULT_NUM_CTX;
    try {
      const client = createOllamaApiClient({
        endpoint: config.endpoint,
        mode: config.mode,
        cloudTier: null,
      });
      const details = await client.showModel(model);
      const fromModelInfo = extractContextLength(details.model_info);
      if (fromModelInfo) {
        contextWindow = Math.max(MIN_NUM_CTX, fromModelInfo);
      }
    } catch {
      // Fall back to sane default when metadata lookup fails.
    }

    this.modelContextCache.set(model, contextWindow);
    return contextWindow;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private mapInvocationError(error: unknown, timeoutMs: number): string {
    if (this.isAbortError(error)) {
      return `Ollama request timed out after ${timeoutMs}ms`;
    }

    if (error instanceof Error) {
      if (error.message.toLowerCase().includes('econnrefused')) {
        return `Ollama connection refused: ${error.message}`;
      }
      return error.message;
    }
    return String(error);
  }
}

export function createOllamaProvider(): OllamaProvider {
  return new OllamaProvider();
}
