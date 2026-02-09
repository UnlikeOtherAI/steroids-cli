/**
 * Projects API routes
 * Manages global project registry
 */

import { Router, Request, Response } from 'express';
import {
  getRegisteredProjects,
  registerProject,
  unregisterProject,
  enableProject,
  disableProject,
  pruneProjects,
  getRegisteredProject,
} from '../../../src/runners/projects.js';
import { openGlobalDatabase } from '../../../src/runners/global-db.js';
import { isValidProjectPath, validatePathRequest } from '../utils/validation.js';

const router = Router();

interface ProjectResponse {
  path: string;
  name: string | null;
  enabled: boolean;
  registered_at: string;
  last_seen_at: string;
  last_activity_at: string | null;  // Runner heartbeat or null if no active runner
  stats?: {
    pending: number;
    in_progress: number;
    review: number;
    completed: number;
  };
  runner?: {
    id: string;
    status: string;
    pid: number | null;
    current_task_id: string | null;
    heartbeat_at: string | null;
  } | null;
}

/**
 * GET /api/projects
 * List all registered projects with stats and runner info
 */
router.get('/projects', (req: Request, res: Response) => {
  try {
    const includeDisabled = req.query.include_disabled === 'true';
    const projects = getRegisteredProjects(includeDisabled);

    // Get runner info and stats for each project
    const { db, close } = openGlobalDatabase();
    try {
      const projectsWithData: ProjectResponse[] = projects.map((project) => {
        // Get runner info (including heartbeat)
        const runner = db
          .prepare('SELECT id, status, pid, current_task_id, heartbeat_at FROM runners WHERE project_path = ?')
          .get(project.path) as {
          id: string;
          status: string;
          pid: number | null;
          current_task_id: string | null;
          heartbeat_at: string | null;
        } | undefined;

        // Get stats (if available from cached stats)
        // Check if stats columns exist first
        type StatsResult = {
          pending_count: number | null;
          in_progress_count: number | null;
          review_count: number | null;
          completed_count: number | null;
        };

        let stats: StatsResult | undefined = undefined;

        try {
          stats = db
            .prepare(
              'SELECT pending_count, in_progress_count, review_count, completed_count FROM projects WHERE path = ?'
            )
            .get(project.path) as StatsResult | undefined;
        } catch {
          // Stats columns don't exist yet - that's ok, they're optional
        }

        const response: ProjectResponse = {
          path: project.path,
          name: project.name,
          enabled: project.enabled,
          registered_at: project.registered_at,
          last_seen_at: project.last_seen_at,
          last_activity_at: runner?.heartbeat_at || null,
          runner: runner
            ? {
                id: runner.id,
                status: runner.status,
                pid: runner.pid,
                current_task_id: runner.current_task_id,
                heartbeat_at: runner.heartbeat_at,
              }
            : null,
        };

        // Add stats if available
        if (
          stats &&
          stats.pending_count !== null &&
          stats.in_progress_count !== null &&
          stats.review_count !== null &&
          stats.completed_count !== null
        ) {
          response.stats = {
            pending: stats.pending_count,
            in_progress: stats.in_progress_count,
            review: stats.review_count,
            completed: stats.completed_count,
          };
        }

        return response;
      });

      res.json({
        success: true,
        projects: projectsWithData,
        count: projectsWithData.length,
      });
    } finally {
      close();
    }
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list projects',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/projects
 * Register a new project
 * Body: { path: string, name?: string }
 */
router.post('/projects', (req: Request, res: Response) => {
  try {
    const validation = validatePathRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error,
      });
      return;
    }

    const { path } = validation;
    const { name } = req.body as { name?: string };

    // Validate path is a valid project
    if (!isValidProjectPath(path!)) {
      res.status(400).json({
        success: false,
        error: 'Invalid project path - must contain .steroids/steroids.db and not be a system directory',
      });
      return;
    }

    registerProject(path!, name);

    // Fetch the registered project to return
    const project = getRegisteredProject(path!);

    res.status(201).json({
      success: true,
      message: 'Project registered successfully',
      project,
    });
  } catch (error) {
    console.error('Error registering project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register project',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/projects/remove
 * Unregister a project
 * Body: { path: string }
 */
router.post('/projects/remove', (req: Request, res: Response) => {
  try {
    const validation = validatePathRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error,
      });
      return;
    }

    const { path } = validation;

    // Check if project exists
    const project = getRegisteredProject(path!);
    if (!project) {
      res.status(404).json({
        success: false,
        error: 'Project not found in registry',
      });
      return;
    }

    unregisterProject(path!);

    res.json({
      success: true,
      message: 'Project unregistered successfully',
    });
  } catch (error) {
    console.error('Error unregistering project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unregister project',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/projects/enable
 * Enable a project for wakeup
 * Body: { path: string }
 */
router.post('/projects/enable', (req: Request, res: Response) => {
  try {
    const validation = validatePathRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error,
      });
      return;
    }

    const { path } = validation;

    // Check if project exists
    const project = getRegisteredProject(path!);
    if (!project) {
      res.status(404).json({
        success: false,
        error: 'Project not found in registry',
      });
      return;
    }

    enableProject(path!);

    res.json({
      success: true,
      message: 'Project enabled successfully',
    });
  } catch (error) {
    console.error('Error enabling project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to enable project',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/projects/disable
 * Disable a project (skip in wakeup)
 * Body: { path: string }
 */
router.post('/projects/disable', (req: Request, res: Response) => {
  try {
    const validation = validatePathRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error,
      });
      return;
    }

    const { path } = validation;

    // Check if project exists
    const project = getRegisteredProject(path!);
    if (!project) {
      res.status(404).json({
        success: false,
        error: 'Project not found in registry',
      });
      return;
    }

    disableProject(path!);

    res.json({
      success: true,
      message: 'Project disabled successfully',
    });
  } catch (error) {
    console.error('Error disabling project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disable project',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/projects/prune
 * Remove stale projects (directories that no longer exist)
 */
router.post('/projects/prune', (req: Request, res: Response) => {
  try {
    const removedCount = pruneProjects();

    res.json({
      success: true,
      message: `Pruned ${removedCount} stale project(s)`,
      removed_count: removedCount,
    });
  } catch (error) {
    console.error('Error pruning projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to prune projects',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/projects/status
 * Get a single project's status by path (query param)
 */
router.get('/projects/status', (req: Request, res: Response) => {
  try {
    const path = req.query.path as string;

    if (!path) {
      res.status(400).json({
        success: false,
        error: 'Path query parameter is required',
      });
      return;
    }

    const project = getRegisteredProject(path);
    if (!project) {
      res.status(404).json({
        success: false,
        error: 'Project not found in registry',
      });
      return;
    }

    // Get runner info
    const { db, close } = openGlobalDatabase();
    try {
      const runner = db
        .prepare('SELECT id, status, pid, current_task_id, heartbeat_at FROM runners WHERE project_path = ?')
        .get(path) as {
        id: string;
        status: string;
        pid: number | null;
        current_task_id: string | null;
        heartbeat_at: string | null;
      } | undefined;

      const response: ProjectResponse = {
        path: project.path,
        name: project.name,
        enabled: project.enabled,
        registered_at: project.registered_at,
        last_seen_at: project.last_seen_at,
        last_activity_at: runner?.heartbeat_at || null,
        runner: runner
          ? {
              id: runner.id,
              status: runner.status,
              pid: runner.pid,
              current_task_id: runner.current_task_id,
              heartbeat_at: runner.heartbeat_at,
            }
          : null,
      };

      res.json({
        success: true,
        project: response,
      });
    } finally {
      close();
    }
  } catch (error) {
    console.error('Error getting project status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
