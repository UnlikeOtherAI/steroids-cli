import { API_BASE_URL, ApiError } from './api';

export type ReloadSelfHealSource = 'runners_page' | 'task_page' | 'project_tasks_page';

interface ReloadSelfHealResponse {
  success: boolean;
  scheduled: boolean;
  reason: string;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.error || error.message || `HTTP ${response.status}`,
      response.status,
    );
  }

  return response.json();
}

export const selfHealApi = {
  async scheduleReloadSweep(
    source: ReloadSelfHealSource,
    projectPath?: string,
  ): Promise<ReloadSelfHealResponse> {
    return fetchJson<ReloadSelfHealResponse>('/api/self-heal/reload', {
      method: 'POST',
      body: JSON.stringify({ source, projectPath }),
    });
  },
};
