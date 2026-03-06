import type {
  OllamaConnectionConfig,
  OllamaConnectionStatus,
  OllamaCachedModel,
  OllamaPairedModel,
} from '../types';
import { API_BASE_URL, ApiError } from './api';

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

  return response.json();
}

export const ollamaApi = {
  async getConnection(): Promise<OllamaConnectionConfig> {
    return fetchOllamaJson<OllamaConnectionConfig>('/api/ollama/connection');
  },

  async setConnection(input: {
    mode: 'local' | 'cloud';
    endpoint?: string;
    apiKey?: string;
  }): Promise<OllamaConnectionConfig> {
    return fetchOllamaJson<OllamaConnectionConfig>('/api/ollama/connection', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async testConnection(): Promise<OllamaConnectionStatus> {
    return fetchOllamaJson<OllamaConnectionStatus>('/api/ollama/connection/test', {
      method: 'POST',
    });
  },

  async getModels(): Promise<OllamaCachedModel[]> {
    return fetchOllamaJson<OllamaCachedModel[]>('/api/ollama/models');
  },

  async deleteModel(name: string): Promise<void> {
    await fetchOllamaJson('/api/ollama/models', {
      method: 'DELETE',
      body: JSON.stringify({ name }),
    });
  },

  async getPairedModels(): Promise<OllamaPairedModel[]> {
    return fetchOllamaJson<OllamaPairedModel[]>('/api/ollama/paired-models');
  },

  async pairModel(input: {
    model_name: string;
    runtime: string;
    endpoint: string;
    supports_tools?: boolean;
  }): Promise<void> {
    await fetchOllamaJson('/api/ollama/paired-models', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async unpairModel(id: number): Promise<void> {
    await fetchOllamaJson('/api/ollama/paired-models', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
  },
};
