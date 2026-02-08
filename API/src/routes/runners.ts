/**
 * Runners API routes
 * Get runner status and current tasks
 */

import { Router, Request, Response } from 'express';
import { openGlobalDatabase } from '../../../src/runners/global-db.js';

const router = Router();

interface RunnerInfo {
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

/**
 * GET /api/runners
 * List all runners with their current tasks
 */
router.get('/runners', (_req: Request, res: Response) => {
  try {
    const { db, close } = openGlobalDatabase();
    try {
      const runners = db
        .prepare(
          `SELECT
            r.id,
            r.status,
            r.pid,
            r.project_path,
            r.current_task_id,
            r.started_at,
            r.heartbeat_at,
            r.section_id,
            p.name as project_name
          FROM runners r
          LEFT JOIN projects p ON r.project_path = p.path
          ORDER BY r.heartbeat_at DESC`
        )
        .all() as Array<{
        id: string;
        status: string;
        pid: number | null;
        project_path: string | null;
        current_task_id: string | null;
        started_at: string | null;
        heartbeat_at: string;
        section_id: string | null;
        project_name: string | null;
      }>;

      const runnersWithTasks: RunnerInfo[] = runners.map((runner) => ({
        id: runner.id,
        status: runner.status,
        pid: runner.pid,
        project_path: runner.project_path,
        project_name: runner.project_name,
        current_task_id: runner.current_task_id,
        current_task_title: null,
        started_at: runner.started_at,
        heartbeat_at: runner.heartbeat_at,
        section_id: runner.section_id,
      }));

      const activeCount = runners.filter(
        (r) => r.status === 'running' || r.status === 'active'
      ).length;

      res.json({
        success: true,
        runners: runnersWithTasks,
        count: runners.length,
        active_count: activeCount,
      });
    } finally {
      close();
    }
  } catch (error) {
    console.error('Error listing runners:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list runners',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/runners/active-tasks
 * List all tasks currently being worked on by runners
 */
router.get('/runners/active-tasks', (_req: Request, res: Response) => {
  try {
    const { db, close } = openGlobalDatabase();
    try {
      const activeTasks = db
        .prepare(
          `SELECT
            r.id as runner_id,
            r.status,
            r.project_path,
            r.current_task_id,
            r.started_at,
            p.name as project_name
          FROM runners r
          LEFT JOIN projects p ON r.project_path = p.path
          WHERE r.current_task_id IS NOT NULL
          ORDER BY r.started_at DESC`
        )
        .all() as Array<{
        runner_id: string;
        status: string;
        project_path: string;
        current_task_id: string;
        started_at: string | null;
        project_name: string | null;
      }>;

      res.json({
        success: true,
        tasks: activeTasks,
        count: activeTasks.length,
      });
    } finally {
      close();
    }
  } catch (error) {
    console.error('Error listing active tasks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list active tasks',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
