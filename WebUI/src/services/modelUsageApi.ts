import { ModelUsageResponse } from '../types';
import { API_BASE_URL, ApiError } from './api';

async function fetchModelUsageJson<T>(url: string, options?: RequestInit): Promise<T> {
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

export const modelUsageApi = {
  async getUsage(hours = 24, projectPath?: string): Promise<ModelUsageResponse> {
    let url = `/api/model-usage?hours=${hours}`;

    if (projectPath) {
      url += `&project=${encodeURIComponent(projectPath)}`;
    }

    return fetchModelUsageJson<ModelUsageResponse>(url);
  },
};
