/**
 * Hugging Face Provider
 * Routes prompts through Hugging Face's OpenAI-compatible router API.
 */

import {
  BaseAIProvider,
  type InvokeOptions,
  type InvokeResult,
  type ModelInfo,
  type TokenUsage,
} from './interface.js';
import { HuggingFaceTokenAuth } from '../huggingface/auth.js';
import { HuggingFaceModelRegistry } from '../huggingface/model-registry.js';
import {
  extractInferenceProviderFromHeaders,
  HuggingFaceUsageMetrics,
} from '../huggingface/metrics.js';

const HF_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 900_000;

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-ai/DeepSeek-V3',
    name: 'DeepSeek V3',
    recommendedFor: ['coder', 'reviewer'],
    supportsStreaming: true,
  },
  {
    id: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    name: 'Qwen 2.5 Coder 32B Instruct',
    recommendedFor: ['coder'],
    supportsStreaming: true,
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    name: 'Llama 3.3 70B Instruct',
    recommendedFor: ['orchestrator', 'reviewer'],
    supportsStreaming: true,
  },
];

const DEFAULT_MODELS_BY_ROLE: Record<'orchestrator' | 'coder' | 'reviewer', string> = {
  orchestrator: 'deepseek-ai/DeepSeek-V3',
  coder: 'deepseek-ai/DeepSeek-V3',
  reviewer: 'Qwen/Qwen2.5-Coder-32B-Instruct',
};

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface HFProviderDeps {
  auth?: Pick<HuggingFaceTokenAuth, 'getToken'>;
  registry?: Pick<HuggingFaceModelRegistry, 'getCuratedModels' | 'getCachedModel'>;
  metrics?: Pick<HuggingFaceUsageMetrics, 'recordInvocationUsage'>;
  fetchImpl?: FetchFn;
}

interface OpenAISSEChunk {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string | number;
    type?: string;
  };
}

interface SSEEvent {
  event: string;
  data: string;
}

export class HuggingFaceProvider extends BaseAIProvider {
  readonly name = 'hf';
  readonly displayName = 'Hugging Face Router';

  private readonly auth: Pick<HuggingFaceTokenAuth, 'getToken'>;
  private readonly registry: Pick<HuggingFaceModelRegistry, 'getCuratedModels' | 'getCachedModel'>;
  private readonly metrics: Pick<HuggingFaceUsageMetrics, 'recordInvocationUsage'>;
  private readonly fetchImpl: FetchFn;
  private dynamicModels: ModelInfo[] = [];

  constructor(deps: HFProviderDeps = {}) {
    super();
    this.auth = deps.auth ?? new HuggingFaceTokenAuth();
    this.registry = deps.registry ?? new HuggingFaceModelRegistry();
    this.metrics = deps.metrics ?? new HuggingFaceUsageMetrics({ registry: this.registry });
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async initialize(): Promise<void> {
    try {
      const token = this.auth.getToken() ?? undefined;
      const curated = await this.registry.getCuratedModels({ token });
      this.dynamicModels = curated.map((model) => ({
        id: model.id,
        name: model.id,
        supportsStreaming: true,
      }));
    } catch {
      this.dynamicModels = [];
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.auth.getToken());
  }

  listModels(): string[] {
    const models = this.dynamicModels.length > 0 ? this.dynamicModels : DEFAULT_MODELS;
    return models.map((model) => model.id);
  }

  getModelInfo(): ModelInfo[] {
    return this.dynamicModels.length > 0 ? [...this.dynamicModels] : [...DEFAULT_MODELS];
  }

  getDefaultModel(role: 'orchestrator' | 'coder' | 'reviewer'): string {
    return DEFAULT_MODELS_BY_ROLE[role];
  }

  getDefaultInvocationTemplate(): string {
    return '';
  }

  async invoke(prompt: string, options: InvokeOptions): Promise<InvokeResult> {
    const startedAt = Date.now();
    const token = this.auth.getToken();
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

    if (!token) {
      return {
        success: false,
        exitCode: 401,
        stdout: '',
        stderr: 'Hugging Face token not configured',
        duration: Date.now() - startedAt,
        timedOut: false,
      };
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestBody = {
        model: this.applyRoutingPolicy(options.model),
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      };

      const response = await this.fetchImpl(HF_ROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await safeReadText(response);
        const mappedError = mapHfRouterError({
          status: response.status,
          statusText: response.statusText,
          bodyText: errorText,
        });
        return {
          success: false,
          exitCode: response.status,
          stdout: '',
          stderr: mappedError,
          duration: Date.now() - startedAt,
          timedOut: false,
        };
      }

      if (!response.body) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: 'Hugging Face router returned empty body',
          duration: Date.now() - startedAt,
          timedOut: false,
        };
      }

      const result = await this.parseSSEStream(response.body, startedAt);
      this.recordMetrics(requestBody.model, options.role, result.tokenUsage, response.headers);
      return result;
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: timedOut
          ? 'Hugging Face router request timed out'
          : `Hugging Face router request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        duration: Date.now() - startedAt,
        timedOut,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private applyRoutingPolicy(model: string): string {
    return model.includes(':') ? model : `${model}:fastest`;
  }

  private async parseSSEStream(body: ReadableStream<Uint8Array>, startedAt: number): Promise<InvokeResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let rawBuffer = '';
    let stdout = '';
    let tokenUsage: TokenUsage | undefined;
    let seenDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const parts = rawBuffer.split('\n\n');
      rawBuffer = parts.pop() ?? '';

      for (const part of parts) {
        const event = parseSSEEvent(part);
        if (!event) continue;

        const eventResult = this.handleSSEEvent(event);
        if (eventResult.done) {
          seenDone = true;
          return {
            success: true,
            exitCode: 0,
            stdout,
            stderr: '',
            duration: Date.now() - startedAt,
            timedOut: false,
            tokenUsage,
          };
        }

        if (eventResult.error) {
          return {
            success: false,
            exitCode: 1,
            stdout,
            stderr: eventResult.error,
            duration: Date.now() - startedAt,
            timedOut: false,
          };
        }

        if (eventResult.text) {
          stdout += eventResult.text;
        }
        if (eventResult.usage) {
          tokenUsage = eventResult.usage;
        }
      }
    }

    if (!seenDone) {
      return {
        success: false,
        exitCode: 1,
        stdout,
        stderr: 'Hugging Face SSE stream ended before [DONE]',
        duration: Date.now() - startedAt,
        timedOut: false,
        tokenUsage,
      };
    }

    return {
      success: true,
      exitCode: 0,
      stdout,
      stderr: '',
      duration: Date.now() - startedAt,
      timedOut: false,
      tokenUsage,
    };
  }

  private handleSSEEvent(
    event: SSEEvent
  ): { done?: boolean; text?: string; usage?: TokenUsage; error?: string } {
    if (event.data === '[DONE]') {
      return { done: true };
    }

    if (event.event === 'error') {
      const parsed = safeParseJson<OpenAISSEChunk>(event.data);
      const code = parsed?.error?.code;
      const message = parsed?.error?.message ?? event.data;
      return {
        error: mapHfRouterError({
          status: codeToStatusCode(code),
          bodyText: message,
          source: 'sse',
        }),
      };
    }

    const chunk = safeParseJson<OpenAISSEChunk>(event.data);
    if (!chunk) return {};

    if (chunk.error?.message) {
      return {
        error: mapHfRouterError({
          status: codeToStatusCode(chunk.error.code),
          bodyText: chunk.error.message,
          source: 'sse',
        }),
      };
    }

    const text =
      chunk.choices?.[0]?.delta?.content ??
      chunk.choices?.[0]?.message?.content ??
      '';

    const usage = chunk.usage
      ? {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      : undefined;

    return { text, usage };
  }

  private recordMetrics(
    requestedModel: string,
    role: 'orchestrator' | 'coder' | 'reviewer' | undefined,
    tokenUsage: TokenUsage | undefined,
    headers: Headers
  ): void {
    if (!tokenUsage) return;

    try {
      this.metrics.recordInvocationUsage({
        requestedModel,
        role,
        tokenUsage,
        providerHint: extractInferenceProviderFromHeaders(headers),
      });
    } catch {
      // Metrics are best-effort and must not fail model invocation.
    }
  }
}

function parseSSEEvent(rawBlock: string): SSEEvent | null {
  const lines = rawBlock.split('\n');
  let event = 'message';
  const dataParts: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
      continue;
    }
    if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trimStart());
    }
  }

  if (dataParts.length === 0) return null;
  return { event, data: dataParts.join('\n') };
}

function safeParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export function createHuggingFaceProvider(): HuggingFaceProvider {
  return new HuggingFaceProvider();
}

function mapHfRouterError(input: {
  status?: number;
  statusText?: string;
  bodyText?: string;
  source?: 'http' | 'sse';
}): string {
  const source = input.source ?? 'http';
  const status = input.status;
  const statusText = input.statusText ?? '';
  const bodyText = (input.bodyText ?? '').trim();
  const message = `${status ?? ''} ${statusText} ${bodyText}`.toLowerCase();

  if (status === 402 || /insufficient|credit|quota|payment required/.test(message)) {
    return `Hugging Face ${source} error: credits exhausted. Add credits in https://huggingface.co/settings/billing.`;
  }

  if (status === 429 || /rate.?limit|too many requests/.test(message)) {
    return `Hugging Face ${source} error: rate limit exceeded (429). Retry after a short backoff.`;
  }

  if (
    status === 401 ||
    status === 403 ||
    /gated|access denied|forbidden|not authorized|authorization required|request access/.test(message)
  ) {
    return `Hugging Face ${source} error: gated model access denied. Request model access and verify token read/inference scopes.`;
  }

  if (status === 503 || /unavailable|overloaded|provider down|capacity/.test(message)) {
    return `Hugging Face ${source} error: provider outage or temporary unavailability (503).`;
  }

  if (bodyText) {
    return `Hugging Face ${source} error (${status ?? 'unknown'}): ${bodyText}`;
  }

  return `Hugging Face ${source} error (${status ?? 'unknown'})`;
}

function codeToStatusCode(code: string | number | undefined): number | undefined {
  if (typeof code === 'number' && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === 'string') {
    const parsed = Number.parseInt(code, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
