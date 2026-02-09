/**
 * Tasks API routes
 * Exposes task details and logs for individual tasks
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const router = Router();

interface TaskDetails {
  id: string;
  title: string;
  status: string;
  section_id: string | null;
  section_name: string | null;
  source_file: string | null;
  rejection_count: number;
  created_at: string;
  updated_at: string;
}

interface AuditEntry {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  notes: string | null;
  commit_sha: string | null;
  created_at: string;
  duration_seconds?: number;
}

interface TaskResponse extends TaskDetails {
  duration: {
    total_seconds: number;
    in_progress_seconds: number;
    review_seconds: number;
  };
  audit_trail: AuditEntry[];
  github_url: string | null;
}

/**
 * Get GitHub URL from git remote
 * @param projectPath - Path to project root
 * @returns GitHub base URL (e.g., https://github.com/owner/repo) or null
 */
function getGitHubUrl(projectPath: string): string | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: projectPath,
      encoding: 'utf-8',
    }).trim();

    // Convert SSH or HTTPS URL to web URL
    // SSH: git@github.com:owner/repo.git
    // HTTPS: https://github.com/owner/repo.git
    let webUrl: string | null = null;

    if (remoteUrl.startsWith('git@github.com:')) {
      // SSH format
      const path = remoteUrl.replace('git@github.com:', '').replace(/\.git$/, '');
      webUrl = `https://github.com/${path}`;
    } else if (remoteUrl.includes('github.com')) {
      // HTTPS format
      webUrl = remoteUrl.replace(/\.git$/, '');
    }

    return webUrl;
  } catch {
    return null;
  }
}

/**
 * Open project database
 * @param projectPath - Path to project root
 * @returns Database connection or null if not found
 */
function openProjectDatabase(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Calculate duration for each status from audit trail
 * @param auditTrail - Array of audit entries sorted by created_at
 * @returns Audit entries with duration_seconds added
 */
function calculateDurations(auditTrail: AuditEntry[]): AuditEntry[] {
  // Sort by created_at ascending for duration calculation
  const sorted = [...auditTrail].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return sorted.map((entry, index) => {
    // Duration is time until next status change
    if (index < sorted.length - 1) {
      const startTime = new Date(entry.created_at).getTime();
      const endTime = new Date(sorted[index + 1].created_at).getTime();
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      return { ...entry, duration_seconds: durationSeconds };
    }
    // Current/last status - duration from entry until now
    const startTime = new Date(entry.created_at).getTime();
    const now = Date.now();
    const durationSeconds = Math.round((now - startTime) / 1000);
    return { ...entry, duration_seconds: durationSeconds };
  });
}

/**
 * GET /api/tasks/:taskId
 * Get detailed information about a task including audit history
 * Query params:
 *   - project: string (required) - project path
 */
router.get('/tasks/:taskId', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const projectPath = req.query.project as string;

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required query parameter: project',
      });
      return;
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      // Get task details with section name
      const task = db
        .prepare(
          `SELECT
            t.id, t.title, t.status, t.section_id,
            s.name as section_name,
            t.source_file, t.rejection_count,
            t.created_at, t.updated_at
          FROM tasks t
          LEFT JOIN sections s ON t.section_id = s.id
          WHERE t.id = ?`
        )
        .get(taskId) as TaskDetails | undefined;

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found',
          task_id: taskId,
        });
        return;
      }

      // Get audit trail
      const auditTrail = db
        .prepare(
          `SELECT id, task_id, from_status, to_status, actor, notes, commit_sha, created_at
          FROM audit
          WHERE task_id = ?
          ORDER BY created_at ASC`
        )
        .all(taskId) as AuditEntry[];

      // Calculate durations for each status
      const auditWithDurations = calculateDurations(auditTrail);

      // Calculate total time in each status
      let inProgressSeconds = 0;
      let reviewSeconds = 0;

      for (const entry of auditWithDurations) {
        if (entry.to_status === 'in_progress' && entry.duration_seconds) {
          inProgressSeconds += entry.duration_seconds;
        } else if (entry.to_status === 'review' && entry.duration_seconds) {
          reviewSeconds += entry.duration_seconds;
        }
      }

      // Total time is just the sum of active work time (coding + review)
      const totalSeconds = inProgressSeconds + reviewSeconds;

      // Get GitHub URL for commit links
      const githubUrl = getGitHubUrl(projectPath);

      const response: TaskResponse = {
        ...task,
        duration: {
          total_seconds: totalSeconds,
          in_progress_seconds: inProgressSeconds,
          review_seconds: reviewSeconds,
        },
        audit_trail: auditWithDurations.reverse(), // Most recent first for display
        github_url: githubUrl,
      };

      res.json({
        success: true,
        task: response,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error getting task details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task details',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/tasks/:taskId/logs
 * Get execution logs/audit trail for a task
 * Query params:
 *   - project: string (required) - project path
 *   - limit: number (optional) - max entries to return (default: 50)
 *   - offset: number (optional) - offset for pagination (default: 0)
 */
router.get('/tasks/:taskId/logs', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const projectPath = req.query.project as string;
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required query parameter: project',
      });
      return;
    }

    // Parse limit and offset
    let limit = 50;
    let offset = 0;

    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam as string, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500); // Cap at 500
      }
    }

    if (offsetParam !== undefined) {
      const parsed = parseInt(offsetParam as string, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      // Check task exists
      const task = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(taskId) as
        | { id: string; title: string; status: string }
        | undefined;

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found',
          task_id: taskId,
        });
        return;
      }

      // Get total count
      const countResult = db
        .prepare('SELECT COUNT(*) as count FROM audit WHERE task_id = ?')
        .get(taskId) as { count: number };

      // Get audit entries with pagination
      const logs = db
        .prepare(
          `SELECT id, task_id, from_status, to_status, actor, notes, commit_sha, created_at
          FROM audit
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`
        )
        .all(taskId, limit, offset) as AuditEntry[];

      res.json({
        success: true,
        task_id: taskId,
        task_title: task.title,
        task_status: task.status,
        logs,
        pagination: {
          total: countResult.count,
          limit,
          offset,
          has_more: offset + logs.length < countResult.count,
        },
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error getting task logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/projects/:projectPath/tasks
 * List all tasks for a project
 * Query params:
 *   - status: string (optional) - filter by status
 *   - section: string (optional) - filter by section id
 *   - limit: number (optional) - max entries (default: 100)
 */
router.get('/projects/:projectPath(*)/tasks', (req: Request, res: Response) => {
  try {
    // projectPath comes URL-encoded, decode it
    const projectPath = decodeURIComponent(req.params.projectPath);
    const statusFilter = req.query.status as string | undefined;
    const sectionFilter = req.query.section as string | undefined;
    const limitParam = req.query.limit;

    let limit = 100;
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam as string, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      let query = `
        SELECT
          t.id, t.title, t.status, t.section_id,
          s.name as section_name,
          t.source_file, t.rejection_count,
          t.created_at, t.updated_at
        FROM tasks t
        LEFT JOIN sections s ON t.section_id = s.id
        WHERE 1=1
      `;
      const params: (string | number)[] = [];

      if (statusFilter) {
        query += ' AND t.status = ?';
        params.push(statusFilter);
      }

      if (sectionFilter) {
        query += ' AND t.section_id = ?';
        params.push(sectionFilter);
      }

      query += ' ORDER BY t.created_at DESC LIMIT ?';
      params.push(limit);

      const tasks = db.prepare(query).all(...params) as TaskDetails[];

      // Get task counts by status
      const statusCounts = db
        .prepare(
          `SELECT status, COUNT(*) as count
          FROM tasks
          GROUP BY status`
        )
        .all() as { status: string; count: number }[];

      const counts = statusCounts.reduce(
        (acc, { status, count }) => {
          acc[status] = count;
          return acc;
        },
        {} as Record<string, number>
      );

      res.json({
        success: true,
        project: projectPath,
        tasks,
        count: tasks.length,
        status_counts: counts,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error listing project tasks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list project tasks',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
