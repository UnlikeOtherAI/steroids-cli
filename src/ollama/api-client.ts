import { TextDecoder } from 'node:util';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface OllamaClientConfig {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface RequestOptions {
  timeoutMs?: number;
  operation?: string;
}

export interface OllamaVersionResponse {
  version: string;
}

export interface OllamaPsModel {
  name: string;
  size: number;
  size_vram: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  expires_at?: string;
  model?: string;
  context_length?: number;
}

export interface OllamaPsResponse {
  models: OllamaPsModel[];
}

export interface OllamaTagModel {
  name: string;
  model?: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaTagsResponse {
  models: OllamaTagModel[];
}

export interface OllamaShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  system?: string;
  license?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
  percent?: number | null;
  phase?: 'starting' | 'downloading' | 'verifying' | 'complete' | 'error' | 'unknown';
  done?: boolean;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  options?: Record<string, unknown>;
}

export interface OllamaChatResponse {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: unknown[];
  };
  done?: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  [key: string]: unknown;
}

export interface OllamaOpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface OllamaOpenAIModelsResponse {
  object: string;
  data: OllamaOpenAIModel[];
}

export class OllamaApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly url: string;

  constructor(message: string, status: number, responseBody: string, url: string) {
    super(message);
    this.name = 'OllamaApiError';
    this.status = status;
    this.responseBody = responseBody;
    this.url = url;
  }
}

export class OllamaApiClient {
  private endpoint: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(config: OllamaClientConfig) {
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setConfig(config: Partial<OllamaClientConfig>): void {
    if (config.endpoint) {
      this.endpoint = normalizeEndpoint(config.endpoint);
    }
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey;
    }
    if (config.timeoutMs !== undefined) {
      this.timeoutMs = config.timeoutMs;
    }
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  async healthCheck(): Promise<{ status: number; body: string }> {
    const response = await this.requestRaw('/');
    const body = await response.text();
    return { status: response.status, body };
  }

  async getVersion(): Promise<OllamaVersionResponse> {
    return this.requestJson<OllamaVersionResponse>('/api/version');
  }

  async listRunningModels(): Promise<OllamaPsResponse> {
    return this.requestJson<OllamaPsResponse>('/api/ps');
  }

  async listInstalledModels(): Promise<OllamaTagsResponse> {
    return this.requestJson<OllamaTagsResponse>('/api/tags');
  }

  async showModel(name: string): Promise<OllamaShowResponse> {
    return this.requestJson<OllamaShowResponse>('/api/show', {
      method: 'POST',
      body: JSON.stringify({ name }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async pullModel(
    name: string,
    onProgress?: (progress: OllamaPullProgress) => void,
    options?: { timeoutMs?: number },
  ): Promise<OllamaPullProgress[]> {
    const response = await this.requestRaw('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ name, stream: true }),
      headers: {
        'Content-Type': 'application/json',
      },
    }, {
      timeoutMs: options?.timeoutMs,
      operation: 'pull model',
    });

    if (!response.body) {
      return [];
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const updates: OllamaPullProgress[] = [];
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = this.consumePullBuffer(buffer, updates, onProgress);
    }

    buffer += decoder.decode();
    buffer = this.consumePullBuffer(buffer, updates, onProgress);
    const tail = buffer.trim();
    if (tail) {
      const progress = this.normalizePullProgress(JSON.parse(tail) as OllamaPullProgress);
      updates.push(progress);
      onProgress?.(progress);
    }

    return updates;
  }

  async deleteModel(name: string): Promise<void> {
    await this.requestRaw('/api/delete', {
      method: 'DELETE',
      body: JSON.stringify({ name }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(payload: OllamaChatRequest): Promise<OllamaChatResponse> {
    return this.requestJson<OllamaChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async listOpenAIModels(): Promise<OllamaOpenAIModelsResponse> {
    return this.requestJson<OllamaOpenAIModelsResponse>('/v1/models');
  }

  async getOpenAIModel(model: string): Promise<OllamaOpenAIModel> {
    return this.requestJson<OllamaOpenAIModel>(`/v1/models/${encodeURIComponent(model)}`);
  }

  private consumePullBuffer(
    buffer: string,
    updates: OllamaPullProgress[],
    onProgress?: (progress: OllamaPullProgress) => void,
  ): string {
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      const progress = this.normalizePullProgress(JSON.parse(line) as OllamaPullProgress);
      updates.push(progress);
      onProgress?.(progress);
    }

    return buffer;
  }

  private normalizePullProgress(progress: OllamaPullProgress): OllamaPullProgress {
    const total = typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total > 0
      ? progress.total
      : null;
    const completed = typeof progress.completed === 'number' && Number.isFinite(progress.completed)
      ? Math.max(0, progress.completed)
      : null;
    const percent = total !== null && completed !== null
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : null;
    const status = (progress.status || '').toLowerCase();
    const done = status.includes('success') || status.includes('complete') || status.includes('finished');
    const phase: OllamaPullProgress['phase'] = progress.error
      ? 'error'
      : done
        ? 'complete'
        : status.includes('download')
          ? 'downloading'
          : status.includes('verify') || status.includes('digest')
            ? 'verifying'
            : status.includes('pull') || status.includes('resolve')
              ? 'starting'
              : 'unknown';

    return {
      ...progress,
      percent,
      phase,
      done,
    };
  }

  private async requestJson<T>(path: string, init?: RequestInit, requestOptions?: RequestOptions): Promise<T> {
    const response = await this.requestRaw(path, init, requestOptions);
    return response.json() as Promise<T>;
  }

  private async requestRaw(path: string, init: RequestInit = {}, requestOptions: RequestOptions = {}): Promise<Response> {
    const url = buildUrl(this.endpoint, path);
    const headers = new Headers(init.headers);
    const timeoutMs = requestOptions.timeoutMs ?? this.timeoutMs;
    const operation = requestOptions.operation ?? 'request';

    if (this.apiKey) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new OllamaApiError(
          `Ollama API request failed: ${response.status}`,
          response.status,
          body,
          url,
        );
      }

      return response;
    } catch (error) {
      if (error instanceof OllamaApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama API ${operation} timed out after ${timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function buildUrl(endpoint: string, path: string): string {
  const base = normalizeEndpoint(endpoint);
  if (!path) {
    return base;
  }

  if (path.startsWith('/')) {
    return `${base}${path}`;
  }

  return `${base}/${path}`;
}
