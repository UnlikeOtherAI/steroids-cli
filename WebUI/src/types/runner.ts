/**
 * Runner types for WebUI
 */

export interface Runner {
  id: string;
  status: string;
  pid: number | null;
  project_path: string | null;
  project_name: string | null;
  current_task_id: string | null;
  current_task_title: string | null;
  started_at: string | null;
  heartbeat_at: string;
  section_id: string | null;
}

export interface RunnersListResponse {
  success: boolean;
  runners: Runner[];
  count: number;
  active_count: number;
}

export interface ActiveTask {
  runner_id: string;
  status: string;
  project_path: string;
  current_task_id: string;
  started_at: string | null;
  project_name: string | null;
}

export interface ActiveTasksResponse {
  success: boolean;
  tasks: ActiveTask[];
  count: number;
}
