/**
 * Runners API routes
 * Get runner status and current tasks
 */

import { Router, Request, Response } from 'express';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';
import { getDaemonActiveStatus, setDaemonActiveStatus } from '../../../dist/runners/global-db.js';
import { cronStatus, cronInstall, cronUninstall } from '../../../dist/runners/cron.js';
import { getLastWakeupTime, wakeup } from '../../../dist/runners/wakeup.js';
import { listRunners, unregisterRunner } from '../../../dist/runners/daemon.js';

const router = Router();

interface RunnerInfo {
  id: string;
  status: string;
  pid: number | null;
  project_path: string | null;
  project_name: string | null;
  parallel_session_id: string | null;
  current_task_id: string | null;
  current_task_title: string | null;
  started_at: string | null;
  heartbeat_at: string;
  section_id: string | null;
}

function stopAllRunnersNow(): number {
  const runners = listRunners();
  let stopped = 0;

  for (const runner of runners) {
    if (runner.pid) {
      try {
        process.kill(runner.pid, 'SIGTERM');
        stopped += 1;
      } catch {
        // Runner already dead; still remove stale DB row.
      }
    }
    unregisterRunner(runner.id);
  }

  return stopped;
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
            r.parallel_session_id,
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
        parallel_session_id: string | null;
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
        parallel_session_id: runner.parallel_session_id,
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

/**
 * GET /api/runners/cron
 * Get cron status and last wakeup time
 */
router.get('/runners/cron', (_req: Request, res: Response) => {
  try {
    const status = cronStatus();
    const isActive = getDaemonActiveStatus();
    const lastWakeup = getLastWakeupTime();

    res.json({
      success: true,
      cron: {
        installed: status.installed && isActive,
        entry: status.entry,
        error: status.error,
      },
      last_wakeup_at: lastWakeup,
    });
  } catch (error) {
    console.error('Error getting cron status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cron status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/runners/cron/start
 * Install cron job
 */
router.post('/runners/cron/start', async (_req: Request, res: Response) => {
  try {
    const status = cronStatus();
    if (!status.installed) {
      const installResult = cronInstall();
      if (!installResult.success) {
        res.status(400).json({
          success: false,
          error: installResult.message,
          message: installResult.error,
        });
        return;
      }
    }
    
    setDaemonActiveStatus(true);

    // Make "Start Steroids" feel immediate: run one wakeup cycle now.
    const wakeupResults = await wakeup({ quiet: true });
    const activated = wakeupResults.filter(
      (item) => item.action === 'started' || item.action === 'restarted'
    ).length;

    res.json({
      success: true,
      message: `Daemon resumed. Immediate wakeup started/restarted ${activated} runner(s).`,
      wakeup: wakeupResults,
    });
  } catch (error) {
    console.error('Error installing cron:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to install cron',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/runners/cron/stop
 * Uninstall cron job
 */
router.post('/runners/cron/stop', (_req: Request, res: Response) => {
  try {
    setDaemonActiveStatus(false);
    const stopped = stopAllRunnersNow();
    res.json({
      success: true,
      message: `Daemon paused. Stopped ${stopped} active runner(s).`,
      stopped,
    });
  } catch (error) {
    console.error('Error uninstalling cron:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to uninstall cron',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/runners/:runnerId/kill
 * Kill a specific runner by ID
 */
router.post('/runners/:runnerId/kill', (req: Request, res: Response) => {
  try {
    const { runnerId } = req.params;
    const runners = listRunners();
    const runner = runners.find((r) => r.id === runnerId || r.id.startsWith(runnerId));

    if (!runner) {
      return res.status(404).json({
        success: false,
        error: 'Runner not found',
      });
    }

    if (!runner.pid) {
      return res.status(400).json({
        success: false,
        error: 'Runner has no PID (not running)',
      });
    }

    try {
      process.kill(runner.pid, 'SIGTERM');
      res.json({
        success: true,
        message: `Runner ${runner.id.slice(0, 8)} killed`,
        runner_id: runner.id,
        pid: runner.pid,
      });
    } catch (killError) {
      res.status(500).json({
        success: false,
        error: 'Failed to kill runner process',
        message: killError instanceof Error ? killError.message : 'Unknown error',
      });
    }
  } catch (error) {
    console.error('Error killing runner:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to kill runner',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/runners/wakeup/now
 * Force immediate execution of the wakeup cycle
 */
router.post('/runners/wakeup/now', async (_req: Request, res: Response) => {
  try {
    const wakeupResults = await wakeup({ quiet: true });
    
    if (wakeupResults.length > 0 && wakeupResults[0].action === 'skipped' && wakeupResults[0].reason === 'Wakeup cycle already running') {
      res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: 'A wakeup cycle is already running.',
      });
      return;
    }
    
    const activated = wakeupResults.filter(
      (item) => item.action === 'started' || item.action === 'restarted'
    ).length;

    res.json({
      success: true,
      message: `Immediate wakeup completed. Started/restarted ${activated} runner(s).`,
      wakeup: wakeupResults,
    });
  } catch (error) {
    console.error('Error forcing wakeup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to force wakeup',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
