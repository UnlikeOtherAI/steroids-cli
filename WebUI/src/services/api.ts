/**
 * API service for communicating with Steroids API
 */

import {
  Project,
  ProjectsListResponse,
  ActivityStats,
  ActivityStatsResponse,
  ActivityListResponse,
  ActivityStatusType,
  Runner,
  RunnersListResponse,
  ActiveTask,
  ActiveTasksResponse,
} from '../types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3501';

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
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
      response.status
    );
  }

  return response.json();
}

export const projectsApi = {
  /**
   * List all registered projects
   */
  async list(includeDisabled = false): Promise<Project[]> {
    const url = includeDisabled ? '/api/projects?include_disabled=true' : '/api/projects';
    const response = await fetchJson<ProjectsListResponse>(url);
    return response.projects;
  },

  /**
   * Register a new project
   */
  async register(path: string, name?: string): Promise<Project> {
    const response = await fetchJson<{ success: boolean; project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    });
    return response.project;
  },

  /**
   * Remove a project from registry
   */
  async remove(path: string): Promise<void> {
    await fetchJson('/api/projects/remove', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  /**
   * Enable a project for wakeup
   */
  async enable(path: string): Promise<void> {
    await fetchJson('/api/projects/enable', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  /**
   * Disable a project (skip in wakeup)
   */
  async disable(path: string): Promise<void> {
    await fetchJson('/api/projects/disable', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  /**
   * Prune stale projects
   */
  async prune(): Promise<number> {
    const response = await fetchJson<{ success: boolean; removed_count: number }>(
      '/api/projects/prune',
      {
        method: 'POST',
      }
    );
    return response.removed_count;
  },
};

export const activityApi = {
  /**
   * Get activity statistics for a time range
   */
  async getStats(hours: number, projectPath?: string): Promise<ActivityStats> {
    let url = `/api/activity?hours=${hours}`;
    if (projectPath) {
      url += `&project=${encodeURIComponent(projectPath)}`;
    }
    const response = await fetchJson<ActivityStatsResponse>(url);
    return response.stats;
  },

  /**
   * Get filtered activity log entries
   */
  async list(options: {
    hours: number;
    status?: ActivityStatusType;
    projectPath?: string;
    limit?: number;
  }): Promise<ActivityListResponse> {
    let url = `/api/activity/list?hours=${options.hours}`;
    if (options.status) {
      url += `&status=${options.status}`;
    }
    if (options.projectPath) {
      url += `&project=${encodeURIComponent(options.projectPath)}`;
    }
    if (options.limit) {
      url += `&limit=${options.limit}`;
    }
    return fetchJson<ActivityListResponse>(url);
  },
};

export const runnersApi = {
  /**
   * List all runners
   */
  async list(): Promise<Runner[]> {
    const response = await fetchJson<RunnersListResponse>('/api/runners');
    return response.runners;
  },

  /**
   * Get active tasks being worked on by runners
   */
  async getActiveTasks(): Promise<ActiveTask[]> {
    const response = await fetchJson<ActiveTasksResponse>('/api/runners/active-tasks');
    return response.tasks;
  },
};
