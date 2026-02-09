/**
 * Global activity log for task completions
 * Tracks task terminal states across all projects
 */

import { openGlobalDatabase } from './global-db.js';

export type ActivityStatus =
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'partial'
  | 'disputed';

export interface ActivityLogEntry {
  id: number;
  project_path: string;
  runner_id: string;
  task_id: string;
  task_title: string;
  section_name: string | null;
  final_status: ActivityStatus;
  commit_message: string | null;
  created_at: string;
}

/**
 * Log a task reaching a terminal state
 */
export function logActivity(
  projectPath: string,
  runnerId: string,
  taskId: string,
  taskTitle: string,
  sectionName: string | null,
  finalStatus: ActivityStatus,
  commitMessage?: string | null
): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO activity_log
        (project_path, runner_id, task_id, task_title, section_name, final_status, commit_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(projectPath, runnerId, taskId, taskTitle, sectionName, finalStatus, commitMessage ?? null);
  } finally {
    close();
  }
}

/**
 * Query activity log for entries since a given time
 */
export function getActivitySince(hoursAgo: number = 12): ActivityLogEntry[] {
  const { db, close } = openGlobalDatabase();
  try {
    return db
      .prepare(
        `SELECT * FROM activity_log
         WHERE created_at >= datetime('now', ? || ' hours')
         ORDER BY created_at DESC`
      )
      .all(`-${hoursAgo}`) as ActivityLogEntry[];
  } finally {
    close();
  }
}

/**
 * Query activity log with optional filters
 */
export function getActivityFiltered(options: {
  hoursAgo?: number;
  status?: ActivityStatus;
  projectPath?: string;
  limit?: number;
}): ActivityLogEntry[] {
  const { db, close } = openGlobalDatabase();
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.hoursAgo) {
      conditions.push(`created_at >= datetime('now', ? || ' hours')`);
      params.push(`-${options.hoursAgo}`);
    }

    if (options.status) {
      conditions.push(`final_status = ?`);
      params.push(options.status);
    }

    if (options.projectPath) {
      conditions.push(`project_path = ?`);
      params.push(options.projectPath);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? `LIMIT ${options.limit}` : '';

    return db
      .prepare(
        `SELECT * FROM activity_log
         ${whereClause}
         ORDER BY created_at DESC
         ${limitClause}`
      )
      .all(...params) as ActivityLogEntry[];
  } finally {
    close();
  }
}

/**
 * Stats aggregated by project
 */
export interface ProjectActivityStats {
  project_path: string;
  project_name: string | null;
  completed: number;
  failed: number;
  skipped: number;
  partial: number;
  disputed: number;
  total: number;
  first_activity: string | null;
  last_activity: string | null;
}

/**
 * Get stats aggregated by project for a time range
 */
export function getActivityStatsByProject(
  hoursAgo: number = 12
): ProjectActivityStats[] {
  const { db, close } = openGlobalDatabase();
  try {
    return db
      .prepare(
        `SELECT
          a.project_path,
          p.name as project_name,
          SUM(CASE WHEN a.final_status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN a.final_status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN a.final_status = 'skipped' THEN 1 ELSE 0 END) as skipped,
          SUM(CASE WHEN a.final_status = 'partial' THEN 1 ELSE 0 END) as partial,
          SUM(CASE WHEN a.final_status = 'disputed' THEN 1 ELSE 0 END) as disputed,
          COUNT(*) as total,
          MIN(a.created_at) as first_activity,
          MAX(a.created_at) as last_activity
         FROM activity_log a
         LEFT JOIN projects p ON a.project_path = p.path
         WHERE a.created_at >= datetime('now', ? || ' hours')
         GROUP BY a.project_path
         ORDER BY a.project_path`
      )
      .all(`-${hoursAgo}`) as ProjectActivityStats[];
  } finally {
    close();
  }
}

/**
 * Get total count of activity entries
 */
export function getActivityCount(): number {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM activity_log')
      .get() as { count: number };
    return row.count;
  } finally {
    close();
  }
}

/**
 * Purge activity log entries older than a given time
 * @param keepHours If provided, delete entries older than this many hours
 *                  If undefined, delete ALL entries
 * @returns Number of entries deleted
 */
export function purgeActivity(keepHours?: number): number {
  const { db, close } = openGlobalDatabase();
  try {
    if (keepHours === undefined) {
      // Delete all
      const result = db.prepare('DELETE FROM activity_log').run();
      return result.changes;
    } else {
      // Delete older than threshold
      const result = db
        .prepare(
          `DELETE FROM activity_log
           WHERE created_at < datetime('now', ? || ' hours')`
        )
        .run(`-${keepHours}`);
      return result.changes;
    }
  } finally {
    close();
  }
}
