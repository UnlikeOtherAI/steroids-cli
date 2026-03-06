import { ModelUsageResponse } from '../types';
import { API_BASE_URL, ApiError } from './api';

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

  async streamOllamaPull(
    model: string,
    onProgress: (progress: OllamaPullProgress) => void,
  ): Promise<void> {
    const encoded = encodeURIComponent(model.trim());
    const response = await fetch(`${API_BASE_URL}/api/ollama/pull-stream?model=${encoded}`, {
      method: 'GET',
      headers: {
        Accept: 'application/x-ndjson',
      },
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
      buffer = consumeNdjsonBuffer(buffer, onProgress);
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      onProgress(JSON.parse(tail) as OllamaPullProgress);
    }
  },
};

function consumeNdjsonBuffer(
  buffer: string,
  onProgress: (progress: OllamaPullProgress) => void,
): string {
  let remaining = buffer;
  while (true) {
    const newline = remaining.indexOf('\n');
    if (newline === -1) break;
    const line = remaining.slice(0, newline).trim();
    remaining = remaining.slice(newline + 1);
    if (!line) continue;
    onProgress(JSON.parse(line) as OllamaPullProgress);
  }
  return remaining;
}
