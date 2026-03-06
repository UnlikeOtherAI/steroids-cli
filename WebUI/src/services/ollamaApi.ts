import type {
  OllamaConnectionMode,
  OllamaConnectionStatus,
  OllamaInstalledModelsResponse,
  OllamaLibraryResponse,
  OllamaReadyModelsResponse,
  OllamaRuntime,
} from '../types';
import { API_BASE_URL, ApiError } from './api';

interface UpdateOllamaConnectionInput {
  mode: OllamaConnectionMode;
  endpoint: string;
  apiKey?: string;
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

async function fetchOllamaJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(error.error || error.message || `HTTP ${response.status}`, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const ollamaApi = {
  async getConnection(): Promise<OllamaConnectionStatus> {
    return fetchOllamaJson<OllamaConnectionStatus>('/api/ollama/connection');
  },

  async updateConnection(input: UpdateOllamaConnectionInput): Promise<OllamaConnectionStatus> {
    return fetchOllamaJson<OllamaConnectionStatus>('/api/ollama/connection', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async testConnection(input: UpdateOllamaConnectionInput): Promise<OllamaConnectionStatus> {
    return fetchOllamaJson<OllamaConnectionStatus>('/api/ollama/connection/test', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async getInstalledModels(): Promise<OllamaInstalledModelsResponse> {
    return fetchOllamaJson<OllamaInstalledModelsResponse>('/api/ollama/models/installed');
  },

  async deleteInstalledModel(modelName: string): Promise<void> {
    await fetchOllamaJson('/api/ollama/models/installed', {
      method: 'DELETE',
      body: JSON.stringify({ modelName }),
    });
  },

  async pairInstalledModel(modelName: string, runtime: OllamaRuntime): Promise<void> {
    await fetchOllamaJson('/api/ollama/ready-models', {
      method: 'POST',
      body: JSON.stringify({ modelName, runtime }),
    });
  },

  async getLibraryModels(search?: string): Promise<OllamaLibraryResponse> {
    const params = new URLSearchParams();
    if (search?.trim()) {
      params.set('search', search.trim());
    }
    const query = params.toString();
    return fetchOllamaJson<OllamaLibraryResponse>(`/api/ollama/models/library${query ? `?${query}` : ''}`);
  },

  async pullModel(modelName: string, onProgress?: (progress: OllamaPullProgress) => void): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api/ollama/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ model: modelName.trim() }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(error.error || error.message || `HTTP ${response.status}`, response.status);
    }
    if (!response.body) {
      throw new ApiError('Pull progress stream is unavailable', response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumePullProgressBuffer(buffer, onProgress);
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      consumePullProgressBuffer(tail, onProgress);
    }
  },

  async getReadyModels(): Promise<OllamaReadyModelsResponse> {
    return fetchOllamaJson<OllamaReadyModelsResponse>('/api/ollama/ready-models');
  },

  async removeReadyModel(modelName: string, runtime: OllamaRuntime): Promise<void> {
    await fetchOllamaJson('/api/ollama/ready-models', {
      method: 'DELETE',
      body: JSON.stringify({ modelName, runtime }),
    });
  },

  async changeRuntime(modelName: string, runtime: OllamaRuntime, nextRuntime: OllamaRuntime): Promise<void> {
    await fetchOllamaJson('/api/ollama/ready-models/runtime', {
      method: 'POST',
      body: JSON.stringify({ modelName, runtime, nextRuntime }),
    });
  },

  async getAccount(): Promise<OllamaConnectionStatus> {
    return fetchOllamaJson<OllamaConnectionStatus>('/api/ollama/account');
  },
};

function consumePullProgressBuffer(
  buffer: string,
  onProgress?: (progress: OllamaPullProgress) => void,
): string {
  let remaining = buffer;
  while (true) {
    const nextEvent = remaining.indexOf('\n\n');
    if (nextEvent === -1) break;
    const chunk = remaining.slice(0, nextEvent).trim();
    remaining = remaining.slice(nextEvent + 2);
    if (!chunk) continue;
    const line = chunk
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    onProgress?.(JSON.parse(payload) as OllamaPullProgress);
  }

  while (true) {
    const newline = remaining.indexOf('\n');
    if (newline === -1) break;
    const line = remaining.slice(0, newline).trim();
    remaining = remaining.slice(newline + 1);
    if (!line) continue;
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length).trim();
      if (payload) {
        onProgress?.(JSON.parse(payload) as OllamaPullProgress);
      }
      continue;
    }
    onProgress?.(JSON.parse(line) as OllamaPullProgress);
  }
  return remaining;
}
