export interface ProjectStats {
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
}

export interface ProjectRunner {
  id: string;
  status: string;
  pid: number | null;
  current_task_id: string | null;
  heartbeat_at: string | null;
}

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
  stats?: ProjectStats;
  runner?: ProjectRunner | null;
}

export interface ProjectsResponse {
  success: boolean;
  projects: Project[];
  count: number;
}
