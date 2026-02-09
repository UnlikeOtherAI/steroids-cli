/**
 * Task detail types for task pages
 */

export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'completed' | 'skipped' | 'failed';

export interface AuditEntry {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  actor_type: 'human' | 'coder' | 'reviewer' | 'orchestrator' | null;
  model: string | null;
  notes: string | null;
  commit_sha: string | null;
  created_at: string;
  duration_seconds?: number;
}

export interface TaskInvocation {
  id: number;
  task_id: string;
  role: 'coder' | 'reviewer';
  provider: string;
  model: string;
  exit_code: number;
  duration_ms: number;
  success: number;
  timed_out: number;
  rejection_number: number | null;
  created_at: string;
}

export interface TaskDuration {
  total_seconds: number;
  in_progress_seconds: number;
  review_seconds: number;
}

export interface TaskDetails {
  id: string;
  title: string;
  status: TaskStatus;
  section_id: string | null;
  section_name: string | null;
  source_file: string | null;
  rejection_count: number;
  created_at: string;
  updated_at: string;
  duration: TaskDuration;
  audit_trail: AuditEntry[];
  invocations: TaskInvocation[];
  github_url: string | null;
}

export interface TaskDetailsResponse {
  success: boolean;
  task: TaskDetails;
}

export interface TaskLogsResponse {
  success: boolean;
  task_id: string;
  task_title: string;
  task_status: string;
  logs: AuditEntry[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  section_id: string | null;
  section_name: string | null;
  source_file: string | null;
  rejection_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskListResponse {
  success: boolean;
  project: string;
  tasks: TaskListItem[];
  count: number;
  status_counts: Record<string, number>;
}
