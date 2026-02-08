/**
 * Activity API routes
 * Exposes activity log statistics for the dashboard
 */

import { Router, Request, Response } from 'express';
import {
  getActivityStatsByProject,
  getActivityFiltered,
  ProjectActivityStats,
  ActivityStatus,
  ActivityLogEntry,
} from '../../../src/runners/activity-log.js';

const router = Router();

interface ActivityStatsResponse {
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
  tasks_per_hour: number;
  success_rate: number;
}

/**
 * GET /api/activity
 * Get activity statistics for a time range
 * Query params:
 *   - hours: number (default: 24) - hours to look back
 *   - project: string (optional) - filter by project path
 */
router.get('/activity', (req: Request, res: Response) => {
  try {
    const hoursParam = req.query.hours;
    const projectPath = req.query.project as string | undefined;

    // Parse hours parameter (default: 24)
    let hours = 24;
    if (hoursParam !== undefined) {
      const parsed = parseInt(hoursParam as string, 10);
      if (isNaN(parsed) || parsed <= 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid hours parameter - must be a positive integer',
        });
        return;
      }
      hours = parsed;
    }

    // Get stats from the activity log
    const stats: ProjectActivityStats[] = getActivityStatsByProject(hours);

    // Filter by project if specified
    const filteredStats = projectPath
      ? stats.filter((s) => s.project_path === projectPath)
      : stats;

    // Calculate derived metrics for each project
    const enrichedStats: ActivityStatsResponse[] = filteredStats.map((s) => {
      // Calculate hours between first and last activity for rate
      let tasksPerHour = 0;
      if (s.first_activity && s.last_activity && s.total > 0) {
        const firstTime = new Date(s.first_activity).getTime();
        const lastTime = new Date(s.last_activity).getTime();
        const hoursDiff = Math.max((lastTime - firstTime) / (1000 * 60 * 60), 1);
        tasksPerHour = Math.round((s.total / hoursDiff) * 100) / 100;
      }

      // Calculate success rate (completed / total)
      const successRate =
        s.total > 0 ? Math.round((s.completed / s.total) * 1000) / 10 : 0;

      return {
        project_path: s.project_path,
        project_name: s.project_name,
        completed: s.completed,
        failed: s.failed,
        skipped: s.skipped,
        partial: s.partial,
        disputed: s.disputed,
        total: s.total,
        first_activity: s.first_activity,
        last_activity: s.last_activity,
        tasks_per_hour: tasksPerHour,
        success_rate: successRate,
      };
    });

    // If filtering by a single project, return just that project's stats
    // Otherwise return all projects
    if (projectPath) {
      const projectStats = enrichedStats[0] || {
        project_path: projectPath,
        project_name: null,
        completed: 0,
        failed: 0,
        skipped: 0,
        partial: 0,
        disputed: 0,
        total: 0,
        first_activity: null,
        last_activity: null,
        tasks_per_hour: 0,
        success_rate: 0,
      };

      res.json({
        success: true,
        hours,
        stats: projectStats,
      });
    } else {
      // Aggregate all projects for global stats
      const totals = enrichedStats.reduce(
        (acc, s) => ({
          completed: acc.completed + s.completed,
          failed: acc.failed + s.failed,
          skipped: acc.skipped + s.skipped,
          partial: acc.partial + s.partial,
          disputed: acc.disputed + s.disputed,
          total: acc.total + s.total,
        }),
        { completed: 0, failed: 0, skipped: 0, partial: 0, disputed: 0, total: 0 }
      );

      // Calculate global metrics
      const globalSuccessRate =
        totals.total > 0
          ? Math.round((totals.completed / totals.total) * 1000) / 10
          : 0;
      const globalTasksPerHour =
        hours > 0 ? Math.round((totals.total / hours) * 100) / 100 : 0;

      res.json({
        success: true,
        hours,
        stats: {
          ...totals,
          tasks_per_hour: globalTasksPerHour,
          success_rate: globalSuccessRate,
        },
        by_project: enrichedStats,
      });
    }
  } catch (error) {
    console.error('Error getting activity stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get activity stats',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/activity/list
 * Get activity log entries with optional filters
 * Query params:
 *   - hours: number (default: 24) - hours to look back
 *   - status: string (optional) - filter by status (completed, failed, skipped, partial, disputed)
 *   - project: string (optional) - filter by project path
 *   - limit: number (optional) - max entries to return
 */
router.get('/activity/list', (req: Request, res: Response) => {
  try {
    const hoursParam = req.query.hours;
    const statusParam = req.query.status as string | undefined;
    const projectPath = req.query.project as string | undefined;
    const limitParam = req.query.limit;

    // Parse hours parameter (default: 24)
    let hours = 24;
    if (hoursParam !== undefined) {
      const parsed = parseInt(hoursParam as string, 10);
      if (isNaN(parsed) || parsed <= 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid hours parameter - must be a positive integer',
        });
        return;
      }
      hours = parsed;
    }

    // Validate status if provided
    const validStatuses: ActivityStatus[] = ['completed', 'failed', 'skipped', 'partial', 'disputed'];
    if (statusParam && !validStatuses.includes(statusParam as ActivityStatus)) {
      res.status(400).json({
        success: false,
        error: `Invalid status - must be one of: ${validStatuses.join(', ')}`,
      });
      return;
    }

    // Parse limit
    let limit: number | undefined;
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam as string, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    const entries = getActivityFiltered({
      hoursAgo: hours,
      status: statusParam as ActivityStatus | undefined,
      projectPath,
      limit,
    });

    res.json({
      success: true,
      hours,
      status: statusParam || 'all',
      entries,
      count: entries.length,
    });
  } catch (error) {
    console.error('Error getting activity list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get activity list',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
