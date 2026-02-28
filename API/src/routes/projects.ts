/**
 * Projects API routes
 * Manages global project registry
 */

import { Router, Request, Response } from 'express';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join, relative, resolve, sep } from 'node:path';
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
import { hasActiveParallelSessionForProjectDb } from '../../../dist/runners/parallel-session-state.js';
import { isValidProjectPath, validatePathRequest } from '../utils/validation.js';
import { openSqliteForRead } from '../utils/sqlite.js';
import { getCachedListStorage } from '../utils/storage-cache.js';
import { fileURLToPath } from 'node:url';

const router = Router();

interface ProjectLiveData {
  stats: {
    pending: number;
    in_progress: number;
    review: number;
    completed: number;
    failed: number;
    disputed: number;
    skipped: number;
  };
  last_task_added_at: string | null;
  isBlocked: boolean;
  isUnreachable: boolean;
}

/**
 * Query live task stats and last task added from a project's local database
 */
function getProjectLiveData(projectPath: string): ProjectLiveData {
  const empty: ProjectLiveData = {
    stats: { pending: 0, in_progress: 0, review: 0, completed: 0, failed: 0, disputed: 0, skipped: 0 },
    last_task_added_at: null,
    isBlocked: false,
    isUnreachable: true,
  };
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return empty;

  try {
    const projectDb = openSqliteForRead(dbPath, { timeoutMs: 500 });
    try {
      const row = projectDb
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
            COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) as review,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
            COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) as skipped,
            COALESCE(SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END), 0) as disputed,
            COALESCE(SUM(CASE WHEN failure_count >= 3 THEN 1 ELSE 0 END), 0) as high_failures,
            MAX(created_at) as last_task_added_at
          FROM tasks`
        )
        .get() as {
          pending: number;
          in_progress: number;
          review: number;
          completed: number;
          failed: number;
          disputed: number;
          skipped: number;
          high_failures: number;
          last_task_added_at: string | null;
        } | undefined;

      const failedCount = row?.failed ?? 0;
      const disputedCount = row?.disputed ?? 0;
      const skippedCount = row?.skipped ?? 0;
      const highFailuresCount = row?.high_failures ?? 0;

      return {
        stats: {
          pending: row?.pending ?? 0,
          in_progress: row?.in_progress ?? 0,
          review: row?.review ?? 0,
          completed: row?.completed ?? 0,
          failed: failedCount,
          disputed: disputedCount,
          skipped: skippedCount,
        },
        last_task_added_at: row?.last_task_added_at ?? null,
        isBlocked: failedCount > 0 || disputedCount > 0 || skippedCount > 0 || highFailuresCount > 0,
        isUnreachable: false,
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
  isBlocked: boolean;
  isUnreachable: boolean;
  stats?: {
    pending: number;
    in_progress: number;
    review: number;
    completed: number;
    failed: number;
    disputed: number;
    skipped: number;
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
  orphaned_in_progress: number;
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

        // Inline SQL against the already-open db — no extra DB connections
        const hasStandaloneRunner = db.prepare(
          `SELECT 1 FROM runners WHERE project_path = ? AND status != 'stopped'
           AND heartbeat_at > datetime('now', '-5 minutes') AND parallel_session_id IS NULL`
        ).get(project.path) !== undefined;
        // Cast: DbLike's run signature uses unknown[] but better-sqlite3 uses {} — runtime-compatible
        const hasParallelSession = hasActiveParallelSessionForProjectDb(db as never, project.path);
        const orphanedInProgress = (hasStandaloneRunner || hasParallelSession)
          ? 0
          : (liveData.stats.in_progress ?? 0);

        const response: ProjectResponse = {
          path: project.path,
          name: project.name,
          enabled: project.enabled,
          registered_at: project.registered_at,
          last_seen_at: project.last_seen_at,
          last_activity_at: runner?.heartbeat_at || null,
          last_task_added_at: liveData.last_task_added_at,
          isBlocked: liveData.isBlocked,
          isUnreachable: liveData.isUnreachable,
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
          orphaned_in_progress: orphanedInProgress,
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
      project: { ...project, orphaned_in_progress: 0 },
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
 * POST /api/projects/reset
 * Reset failed, skipped, and disputed tasks for a project, and re-enable it.
 * Body: { path: string }
 */
router.post('/projects/reset', (req: Request, res: Response) => {
  try {
    const validation = validatePathRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: validation.error,
      });
      return;
    }

    const projectPath = validation.path!;

    if (!isValidProjectPath(projectPath)) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Invalid project path',
      });
      return;
    }

    // Re-enable project first
    enableProject(projectPath);

    // Run the CLI reset command
    const cliBin = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
    execSync(`node "${cliBin}" tasks reset --all`, { cwd: projectPath, stdio: 'pipe' });

    // Reset orphaned in_progress tasks — only when no active runner exists
    // Uses inline SQL against the already-open globalDb — same pattern as detection
    const { db: globalDb, close: closeGlobalDb } = openGlobalDatabase();
    try {
      const hasStandaloneRunner = globalDb.prepare(
        `SELECT 1 FROM runners WHERE project_path = ? AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes') AND parallel_session_id IS NULL`
      ).get(projectPath) !== undefined;
      // Cast: DbLike's run signature uses unknown[] but better-sqlite3 uses {} — runtime-compatible
      const hasParallelSession = hasActiveParallelSessionForProjectDb(globalDb as never, projectPath);

      if (!hasStandaloneRunner && !hasParallelSession) {
        const dbPath = join(projectPath, '.steroids', 'steroids.db');
        if (existsSync(dbPath)) {
          // Declare before try so finally can safely reference it (even if constructor throws)
          let projectDb: Database.Database | undefined;
          try {
            projectDb = new Database(dbPath, { fileMustExist: true });
            projectDb.transaction(() => {
              // Clear locks first — 60-min TTL would block new runner pickup otherwise
              projectDb!
                .prepare(`DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')`)
                .run();
              projectDb!
                .prepare(`UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'`)
                .run();
            })();
          } finally {
            projectDb?.close();
          }
        }
      }
      // No wakeup() call — its blast radius covers ALL projects, not just this one.
      // The cron daemon picks up newly-pending tasks on its next cycle.
      // Users wanting immediate pickup can hit "Start Daemon."
    } finally {
      closeGlobalDb();
    }

    res.json({
      success: true,
      message: 'Project tasks reset and project enabled successfully'
    });
  } catch (error) {
    console.error('Error resetting project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset project',
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

      // Inline SQL against the already-open db — no extra DB connections
      const hasStandaloneRunner = db.prepare(
        `SELECT 1 FROM runners WHERE project_path = ? AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes') AND parallel_session_id IS NULL`
      ).get(path) !== undefined;
      // Cast: DbLike's run signature uses unknown[] but better-sqlite3 uses {} — runtime-compatible
      const hasParallelSession = hasActiveParallelSessionForProjectDb(db as never, path);
      const orphanedInProgress = (hasStandaloneRunner || hasParallelSession)
        ? 0
        : (liveData.stats.in_progress ?? 0);

      const response: ProjectResponse = {
        path: project.path,
        name: project.name,
        enabled: project.enabled,
        registered_at: project.registered_at,
        last_seen_at: project.last_seen_at,
        last_activity_at: runner?.heartbeat_at || null,
        last_task_added_at: liveData.last_task_added_at,
        isBlocked: liveData.isBlocked,
        isUnreachable: liveData.isUnreachable,
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
        orphaned_in_progress: orphanedInProgress,
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

/**
 * GET /api/projects/logs
 * List all available log files for a project
 */
router.get('/projects/logs', (req: Request, res: Response) => {
  try {
    const projectPath = req.query.path as string;
    if (!projectPath) {
      res.status(400).json({ success: false, error: 'Path query parameter is required' });
      return;
    }
    
    if (!isValidProjectPath(projectPath)) {
      res.status(403).json({ success: false, error: 'Invalid project path' });
      return;
    }

    const logsDir = join(projectPath, '.steroids', 'logs');
    const invocationsDir = join(projectPath, '.steroids', 'invocations');
    
    const logs: { name: string; path: string; size: number; mtime: Date; type: 'log' | 'invocation' }[] = [];

    [ { dir: logsDir, type: 'log' as const }, { dir: invocationsDir, type: 'invocation' as const } ].forEach(({ dir, type }) => {
      if (existsSync(dir)) {
        const files = readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.log') || file.endsWith('.jsonl') || file.endsWith('.txt')) {
             const filePath = join(dir, file);
             const stats = statSync(filePath);
             if (stats.isFile()) {
               logs.push({
                 name: file,
                 path: relative(projectPath, filePath),
                 size: stats.size,
                 mtime: stats.mtime,
                 type
               });
             }
          }
        }
      }
    });

    // Sort by modified time, newest first
    logs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    res.json({ success: true, logs });
  } catch (error) {
    console.error('Error listing project logs:', error);
    res.status(500).json({ success: false, error: 'Failed to list project logs' });
  }
});

/**
 * GET /api/projects/logs/content
 * Get the content of a specific log file
 */
router.get('/projects/logs/content', (req: Request, res: Response) => {
  try {
    const projectPath = req.query.path as string;
    const logFile = req.query.file as string;

    if (!projectPath || !logFile) {
      res.status(400).json({ success: false, error: 'Path and file query parameters are required' });
      return;
    }

    if (!isValidProjectPath(projectPath)) {
      res.status(403).json({ success: false, error: 'Invalid project path' });
      return;
    }

    const realProjectPath = realpathSync(projectPath);
    let fullLogPath = resolve(realProjectPath, logFile);

    if (!existsSync(fullLogPath)) {
      res.status(404).json({ success: false, error: 'Log file not found' });
      return;
    }

    fullLogPath = realpathSync(fullLogPath);

    // Security (Path Traversal Guard): Strict canonicalization and root path verification
    if (!fullLogPath.startsWith(realProjectPath + sep)) {
       res.status(403).json({ success: false, error: 'Access denied: Path traversal detected' });
       return;
    }
    
    // Only allow access to .steroids/logs and .steroids/invocations
    const allowedLogsDir = join(realProjectPath, '.steroids', 'logs') + sep;
    const allowedInvocationsDir = join(realProjectPath, '.steroids', 'invocations') + sep;

    if (!fullLogPath.startsWith(allowedLogsDir) && !fullLogPath.startsWith(allowedInvocationsDir)) {
       res.status(403).json({ success: false, error: 'Access denied: Only log directories are allowed' });
       return;
    }

    // Since files can be large, we use sendFile
    res.sendFile(fullLogPath);
  } catch (error) {
    console.error('Error reading log file:', error);
    res.status(500).json({ success: false, error: 'Failed to read log file' });
  }
});

/**
 * GET /api/projects/instructions?path=<projectPath>
 * Returns instruction files (AGENTS.md, CLAUDE.md, GEMINI.md) with existence, enabled state, and content.
 * Also returns customInstructions string.
 */
router.get('/projects/instructions', (req: Request, res: Response) => {
  try {
    const projectPath = req.query.path as string;
    if (!projectPath) {
      res.status(400).json({ success: false, error: 'Path query parameter is required' });
      return;
    }
    if (!isValidProjectPath(projectPath)) {
      res.status(403).json({ success: false, error: 'Invalid project path' });
      return;
    }

    // Dynamically import from compiled dist to avoid circular build issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getInstructionFilesList, readInstructionOverrides } = require('../../../dist/prompts/instruction-files.js');
    const files = getInstructionFilesList(projectPath);
    const overrides = readInstructionOverrides(projectPath);

    res.json({
      success: true,
      files,
      customInstructions: overrides.customInstructions ?? '',
    });
  } catch (error) {
    console.error('Error getting project instructions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get project instructions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/projects/instructions
 * Toggle a specific instruction file on/off, or save custom instructions.
 * Body (file toggle): { path: string, key: "agentsMd" | "claudeMd" | "geminiMd", enabled: boolean }
 * Body (custom instructions): { path: string, customInstructions: string }
 */
router.post('/projects/instructions', (req: Request, res: Response) => {
  try {
    const { path: projectPath, key, enabled, customInstructions } = req.body as {
      path: string;
      key?: string;
      enabled?: boolean;
      customInstructions?: string;
    };

    if (!projectPath) {
      res.status(400).json({ success: false, error: 'path is required' });
      return;
    }
    if (!isValidProjectPath(projectPath)) {
      res.status(403).json({ success: false, error: 'Invalid project path' });
      return;
    }

    const validKeys = ['agentsMd', 'claudeMd', 'geminiMd'];
    const updatingFile = key !== undefined;
    const updatingCustom = customInstructions !== undefined;

    if (updatingFile && !validKeys.includes(key!)) {
      res.status(400).json({ success: false, error: `key must be one of: ${validKeys.join(', ')}` });
      return;
    }
    if (!updatingFile && !updatingCustom) {
      res.status(400).json({ success: false, error: 'Provide either key+enabled or customInstructions' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readInstructionOverrides, writeInstructionOverrides } = require('../../../dist/prompts/instruction-files.js');
    const overrides = readInstructionOverrides(projectPath);

    if (updatingFile) {
      overrides[key!] = enabled;
    }
    if (updatingCustom) {
      overrides.customInstructions = customInstructions;
    }

    writeInstructionOverrides(projectPath, overrides);

    res.json({ success: true, message: 'Instructions updated' });
  } catch (error) {
    console.error('Error updating project instructions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update project instructions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
