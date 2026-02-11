/**
 * Steroids WebUI TypeScript Types
 */

export * from './activity';
export * from './runner';
export * from './task';

export interface Project {
  path: string;
  name: string | null;
  enabled: boolean;
  registered_at: string;
  last_seen_at: string;
  last_activity_at: string | null;
  storage_bytes?: number | null;
  storage_human?: string | null;
  storage_warning?: 'orange' | 'red' | null;
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
    heartbeat_at: string | null;
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

export interface StorageSize {
  bytes: number;
  human: string;
  file_count?: number;
  backup_count?: number;
}

export interface StorageInfo {
  total_bytes: number;
  total_human: string;
  breakdown: {
    database: StorageSize;
    invocations: StorageSize;
    logs: StorageSize;
    backups: StorageSize;
    other: StorageSize;
  };
  clearable_bytes: number;
  clearable_human: string;
  threshold_warning: 'orange' | 'red' | null;
}

export interface ClearLogsResult {
  ok: boolean;
  deleted_files: number;
  freed_bytes: number;
  freed_human: string;
}

export interface Section {
  id: string;
  name: string;
  priority: number;
  created_at: string;
  total_tasks: number;
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface SectionsListResponse {
  success: boolean;
  project: string;
  sections: Section[];
  unassigned: {
    total_tasks: number;
    pending: number;
    in_progress: number;
    review: number;
    completed: number;
    failed: number;
    skipped: number;
  } | null;
}
