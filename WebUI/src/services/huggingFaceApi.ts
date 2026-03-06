import type {
  HFAccountStatus,
  HFModelListResponse,
  HFReadyModelsResponse,
  HFRuntime,
  HFUsageDashboardResponse,
} from '../types';
import { API_BASE_URL, ApiError } from './api';

async function fetchHfJson<T>(url: string, options?: RequestInit): Promise<T> {
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

export const huggingFaceApi = {
  async getAccount(): Promise<HFAccountStatus> {
    return fetchHfJson<HFAccountStatus>('/api/hf/account');
  },

  async connect(token: string): Promise<void> {
    await fetchHfJson('/api/hf/account/connect', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },

  async disconnect(): Promise<void> {
    await fetchHfJson('/api/hf/account/disconnect', {
      method: 'POST',
    });
  },

  async getModels(search?: string): Promise<HFModelListResponse> {
    const params = new URLSearchParams();
    if (search && search.trim()) {
      params.set('search', search.trim());
    }
    const query = params.toString();
    return fetchHfJson<HFModelListResponse>(`/api/hf/models${query ? `?${query}` : ''}`);
  },

  async getReadyModels(): Promise<HFReadyModelsResponse> {
    return fetchHfJson<HFReadyModelsResponse>('/api/hf/ready-models');
  },

  async getUsage(): Promise<HFUsageDashboardResponse> {
    return fetchHfJson<HFUsageDashboardResponse>('/api/hf/usage');
  },

  async pairModel(input: {
    modelId: string;
    runtime: HFRuntime;
    routingPolicy?: string;
    supportsTools?: boolean;
  }): Promise<void> {
    await fetchHfJson('/api/hf/ready-models', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateRoutingPolicy(input: {
    modelId: string;
    runtime: HFRuntime;
    routingPolicy: string;
  }): Promise<void> {
    await fetchHfJson('/api/hf/ready-models', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  async unpairModel(input: { modelId: string; runtime: HFRuntime }): Promise<void> {
    await fetchHfJson('/api/hf/ready-models', {
      method: 'DELETE',
      body: JSON.stringify(input),
    });
  },

  async changeRuntime(input: {
    modelId: string;
    runtime: HFRuntime;
    nextRuntime: HFRuntime;
  }): Promise<void> {
    await fetchHfJson('/api/hf/ready-models/runtime', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};
