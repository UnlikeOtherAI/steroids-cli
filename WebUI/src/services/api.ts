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
  TaskDetails,
  TaskDetailsResponse,
  TaskLogsResponse,
  TaskListResponse,
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

export interface CronStatus {
  installed: boolean;
  entry?: string;
  error?: string;
}

export interface CronStatusResponse {
  success: boolean;
  cron: CronStatus;
  last_wakeup_at: string | null;
}

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

  /**
   * Get cron status and last wakeup time
   */
  async getCronStatus(): Promise<CronStatusResponse> {
    return fetchJson<CronStatusResponse>('/api/runners/cron');
  },

  /**
   * Start cron (install cron job)
   */
  async startCron(): Promise<void> {
    await fetchJson('/api/runners/cron/start', { method: 'POST' });
  },

  /**
   * Stop cron (uninstall cron job)
   */
  async stopCron(): Promise<void> {
    await fetchJson('/api/runners/cron/stop', { method: 'POST' });
  },
};

export const tasksApi = {
  /**
   * Get task details with full audit trail
   */
  async getDetails(taskId: string, projectPath: string): Promise<TaskDetails> {
    const url = `/api/tasks/${encodeURIComponent(taskId)}?project=${encodeURIComponent(projectPath)}`;
    const response = await fetchJson<TaskDetailsResponse>(url);
    return response.task;
  },

  /**
   * Get task logs (audit trail) with pagination
   */
  async getLogs(
    taskId: string,
    projectPath: string,
    options?: { limit?: number; offset?: number }
  ): Promise<TaskLogsResponse> {
    let url = `/api/tasks/${encodeURIComponent(taskId)}/logs?project=${encodeURIComponent(projectPath)}`;
    if (options?.limit) {
      url += `&limit=${options.limit}`;
    }
    if (options?.offset) {
      url += `&offset=${options.offset}`;
    }
    return fetchJson<TaskLogsResponse>(url);
  },

  /**
   * List all tasks for a project
   */
  async listForProject(
    projectPath: string,
    options?: { status?: string; section?: string; limit?: number }
  ): Promise<TaskListResponse> {
    let url = `/api/projects/${encodeURIComponent(projectPath)}/tasks`;
    const params = new URLSearchParams();
    if (options?.status) {
      params.set('status', options.status);
    }
    if (options?.section) {
      params.set('section', options.section);
    }
    if (options?.limit) {
      params.set('limit', options.limit.toString());
    }
    const queryString = params.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
    return fetchJson<TaskListResponse>(url);
  },

  /**
   * Restart a failed task
   */
  async restart(taskId: string, projectPath: string): Promise<void> {
    await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/restart`, {
      method: 'POST',
      body: JSON.stringify({ project: projectPath }),
    });
  },
};

export interface ConfigSchema {
  $schema?: string;
  type: string;
  description?: string;
  properties?: Record<string, ConfigSchema>;
  items?: ConfigSchema;
  enum?: (string | number | boolean)[];
  default?: unknown;
}

export interface ConfigResponse {
  success: boolean;
  data: {
    scope: string;
    project: string | null;
    config: Record<string, unknown>;
  };
}

export interface ConfigSchemaResponse {
  success: boolean;
  data: ConfigSchema;
}

export const configApi = {
  /**
   * Get full configuration schema
   */
  async getSchema(): Promise<ConfigSchema> {
    const response = await fetchJson<ConfigSchemaResponse>('/api/config/schema');
    return response.data;
  },

  /**
   * Get schema for a specific category
   */
  async getCategorySchema(category: string): Promise<ConfigSchema> {
    const response = await fetchJson<ConfigSchemaResponse>(
      `/api/config/schema/${encodeURIComponent(category)}`
    );
    return response.data;
  },

  /**
   * Get configuration values
   */
  async getConfig(
    scope: 'global' | 'project' | 'merged' = 'merged',
    projectPath?: string
  ): Promise<Record<string, unknown>> {
    let url = `/api/config?scope=${scope}`;
    if (projectPath) {
      url += `&project=${encodeURIComponent(projectPath)}`;
    }
    const response = await fetchJson<ConfigResponse>(url);
    return response.data.config;
  },

  /**
   * Update configuration values
   */
  async setConfig(
    updates: Record<string, unknown>,
    scope: 'global' | 'project' = 'global',
    projectPath?: string
  ): Promise<void> {
    await fetchJson('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        scope,
        project: projectPath,
        updates,
      }),
    });
  },
};
