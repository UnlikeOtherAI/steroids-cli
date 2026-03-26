export interface ProjectRecoveryCounts {
  failed: number;
  disputed: number;
  blocked_error: number;
  blocked_conflict: number;
  orphaned_in_progress: number;
}

export interface LastActiveTaskSummary {
  id: string;
  title: string;
  status: string;
  role: string | null;
  last_activity_at: string;
  dependent_task_count: number;
}

export interface ProjectRecoverySummary {
  can_reset_project: boolean;
  reset_reason_counts: ProjectRecoveryCounts;
  last_active_task: LastActiveTaskSummary | null;
}

export interface ProjectRecoveryResponse {
  success: boolean;
  recovery: ProjectRecoverySummary;
}
