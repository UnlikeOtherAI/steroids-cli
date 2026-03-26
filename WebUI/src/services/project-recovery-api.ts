import { API_BASE_URL, ApiError } from './api';
import type { ProjectRecoveryResponse, ProjectRecoverySummary } from '../types';

async function fetchProjectRecovery(url: string): Promise<ProjectRecoverySummary | null> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.error || error.message || `HTTP ${response.status}`,
      response.status
    );
  }

  const body = await response.json() as ProjectRecoveryResponse;
  return body.recovery;
}

export const projectRecoveryApi = {
  async get(projectPath: string): Promise<ProjectRecoverySummary | null> {
    return fetchProjectRecovery(`/api/projects/recovery?path=${encodeURIComponent(projectPath)}`);
  },
};
