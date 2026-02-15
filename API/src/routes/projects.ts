/**
 * Projects API routes
 * Manages global project registry
 */

import { Router, Request, Response } from 'express';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getRegisteredProjects,
  registerProject,
  unregisterProject,
  enableProject,
  disableProject,
  pruneProjects,
  getRegisteredProject,
} from '../../../dist/runners/projects.js';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';
import { isValidProjectPath, validatePathRequest } from '../utils/validation.js';
import { openSqliteForRead } from '../utils/sqlite.js';
import { getCachedListStorage } from '../utils/storage-cache.js';

const router = Router();

interface ProjectLiveData {
  stats: { pending: number; in_progress: number; review: number; completed: number };
  last_task_added_at: string | null;
}

/**
 * Query live task stats and last task added from a project's local database
 */
function getProjectLiveData(projectPath: string): ProjectLiveData {
  const empty: ProjectLiveData = {
    stats: { pending: 0, in_progress: 0, review: 0, completed: 0 },
    last_task_added_at: null,
  };
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return empty;

  try {
    const projectDb = openSqliteForRead(dbPath);
    try {
      const row = projectDb
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
            COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) as review,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
            MAX(created_at) as last_task_added_at
          FROM tasks`
        )
        .get() as { pending: number; in_progress: number; review: number; completed: number; last_task_added_at: string | null } | undefined;

      return {
        stats: {
          pending: row?.pending ?? 0,
          in_progress: row?.in_progress ?? 0,
          review: row?.review ?? 0,
          completed: row?.completed ?? 0,
        },
        last_task_added_at: row?.last_task_added_at ?? null,
      };
    } finally {
      projectDb.close();
    }
  } catch {
    return empty;
  }
}

interface ProjectResponse {
  path: string;
  name: string | null;
  enabled: boolean;
  registered_at: string;
  last_seen_at: string;
  last_activity_at: string | null;  // Runner heartbeat or null if no active runner
  last_task_added_at: string | null;  // Most recent task created_at
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
  storage_bytes: number | null;
  storage_human: string | null;
  storage_warning: 'orange' | 'red' | null;
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

        // Get live stats + last task added from project-local database
        const liveData = getProjectLiveData(project.path);

        // Lightweight storage info (non-blocking, 5-min cache)
        const storageInfo = getCachedListStorage(project.path);

        const response: ProjectResponse = {
          path: project.path,
          name: project.name,
          enabled: project.enabled,
          registered_at: project.registered_at,
          last_seen_at: project.last_seen_at,
          last_activity_at: runner?.heartbeat_at || null,
          last_task_added_at: liveData.last_task_added_at,
          stats: liveData.stats,
          runner: runner
            ? {
                id: runner.id,
                status: runner.status,
                pid: runner.pid,
                current_task_id: runner.current_task_id,
                heartbeat_at: runner.heartbeat_at,
              }
            : null,
          storage_bytes: storageInfo?.storage_bytes ?? null,
          storage_human: storageInfo?.storage_human ?? null,
          storage_warning: storageInfo?.storage_warning ?? null,
        };

        return response;
      });

      // Sort by most recently modified: last task added or project enabled, most recent first
      projectsWithData.sort((a, b) => {
        const aTime = a.last_task_added_at || a.last_seen_at || a.registered_at;
        const bTime = b.last_task_added_at || b.last_seen_at || b.registered_at;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
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

      const storageInfo = getCachedListStorage(project.path);
      const liveData = getProjectLiveData(project.path);

      const response: ProjectResponse = {
        path: project.path,
        name: project.name,
        enabled: project.enabled,
        registered_at: project.registered_at,
        last_seen_at: project.last_seen_at,
        last_activity_at: runner?.heartbeat_at || null,
        last_task_added_at: liveData.last_task_added_at,
        runner: runner
          ? {
              id: runner.id,
              status: runner.status,
              pid: runner.pid,
              current_task_id: runner.current_task_id,
              heartbeat_at: runner.heartbeat_at,
            }
          : null,
        storage_bytes: storageInfo?.storage_bytes ?? null,
        storage_human: storageInfo?.storage_human ?? null,
        storage_warning: storageInfo?.storage_warning ?? null,
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

/** POST /api/projects/open - Open project folder in Finder */
router.post('/projects/open', (req: Request, res: Response) => {
  try {
    const validation = validatePathRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({ success: false, error: validation.error });
      return;
    }
    const { path } = validation;
    if (!existsSync(path!)) {
      res.status(404).json({ success: false, error: 'Path does not exist' });
      return;
    }
    execSync(`open "${path}"`, { encoding: 'utf-8' });
    res.json({ success: true, message: 'Folder opened in Finder' });
  } catch (error) {
    console.error('Error opening project folder:', error);
    res.status(500).json({
      success: false, error: 'Failed to open project folder',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
