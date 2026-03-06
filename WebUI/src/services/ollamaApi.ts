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

  async pullModel(modelName: string): Promise<void> {
    await fetchOllamaJson('/api/ollama/pull', {
      method: 'POST',
      body: JSON.stringify({ modelName }),
    });
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
