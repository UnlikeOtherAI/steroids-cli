/**
 * Activity statistics types for dashboard filtering
 */

export interface ActivityStats {
  completed: number;
  failed: number;
  skipped: number;
  partial: number;
  disputed: number;
  total: number;
  tasks_per_hour: number;
  success_rate: number;
}

export interface ProjectActivityStats extends ActivityStats {
  project_path: string;
  project_name: string | null;
  first_activity: string | null;
  last_activity: string | null;
}

export interface ActivityStatsResponse {
  success: boolean;
  hours: number;
  stats: ActivityStats;
  by_project?: ProjectActivityStats[];
}

export interface TimeRangeOption {
  label: string;
  value: string;
  hours: number;
}

export const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { label: '12h', value: '12h', hours: 12 },
  { label: '24h', value: '24h', hours: 24 },
  { label: '1w', value: '1w', hours: 168 },
  { label: '1m', value: '1m', hours: 720 },
  { label: '1y', value: '1y', hours: 8760 },
];

export type ActivityStatusType = 'completed' | 'failed' | 'skipped' | 'partial' | 'disputed';

export interface ActivityLogEntry {
  id: number;
  project_path: string;
  runner_id: string;
  task_id: string;
  task_title: string;
  section_name: string | null;
  final_status: ActivityStatusType;
  commit_message: string | null;
  created_at: string;
}

export interface ActivityListResponse {
  success: boolean;
  hours: number;
  status: string;
  entries: ActivityLogEntry[];
  count: number;
}
