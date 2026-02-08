/**
 * Steroids WebUI TypeScript Types
 */

export * from './activity';
export * from './runner';

export interface Project {
  path: string;
  name: string | null;
  enabled: boolean;
  registered_at: string;
  last_seen_at: string;
  stats?: {
    pending: number;
    in_progress: number;
    review: number;
    completed: number;
  };
  runner?: {
    id: string;
    status: string;
    pid: number | null;
    current_task_id: string | null;
  } | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ProjectsListResponse {
  success: boolean;
  projects: Project[];
  count: number;
}
