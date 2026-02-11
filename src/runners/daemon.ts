/**
 * Runner daemon - background process that executes tasks
 */

import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { openGlobalDatabase } from './global-db.js';
import { createHeartbeatManager } from './heartbeat.js';
import { hasActiveRunnerForProject } from './wakeup.js';
import { runOrchestratorLoop } from './orchestrator-loop.js';
import { updateProjectStats, getRegisteredProject } from './projects.js';
import { openDatabase } from '../database/connection.js';
import { getTaskCountsByStatus } from '../database/queries.js';

export type RunnerStatus = 'idle' | 'running' | 'stopping';

export interface Runner {
  id: string;
  status: RunnerStatus;
  pid: number | null;
  project_path: string | null;
  section_id: string | null;
  current_task_id: string | null;
  started_at: string | null;
  heartbeat_at: string;
}

export interface DaemonOptions {
  projectPath?: string;
  sectionId?: string;  // Focus on this section only
  onTaskStart?: (taskId: string) => void;
  onTaskComplete?: (taskId: string) => void;
  onShutdown?: () => void;
}

/**
 * Register a new runner in the database
 */
export function registerRunner(
  projectPath?: string,
  sectionId?: string
): { runnerId: string; close: () => void } {
  const { db, close } = openGlobalDatabase();
  const runnerId = uuidv4();

  db.prepare(
    `INSERT INTO runners (id, status, pid, project_path, section_id, started_at, heartbeat_at)
     VALUES (?, 'idle', ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(runnerId, process.pid, projectPath ?? null, sectionId ?? null);

  return { runnerId, close };
}

/**
 * Update runner status
 */
export function updateRunnerStatus(
  runnerId: string,
  status: RunnerStatus,
  currentTaskId?: string | null
): void {
  const { db, close } = openGlobalDatabase();
  try {
    if (currentTaskId !== undefined) {
      db.prepare(
        `UPDATE runners SET status = ?, current_task_id = ?, heartbeat_at = datetime('now')
         WHERE id = ?`
      ).run(status, currentTaskId, runnerId);
    } else {
      db.prepare(
        `UPDATE runners SET status = ?, heartbeat_at = datetime('now')
         WHERE id = ?`
      ).run(status, runnerId);
    }
  } finally {
    close();
  }
}

/**
 * Update runner heartbeat timestamp
 */
export function updateRunnerHeartbeat(runnerId: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `UPDATE runners SET heartbeat_at = datetime('now') WHERE id = ?`
    ).run(runnerId);
  } finally {
    close();
  }
}

/**
 * Sync project stats to global database
 * Called during heartbeat to cache stats for API/WebUI
 */
export function syncProjectStats(projectPath: string): void {
  try {
    const { db, close } = openDatabase(projectPath);
    try {
      const stats = getTaskCountsByStatus(db);
      updateProjectStats(projectPath, stats);
    } finally {
      close();
    }
  } catch (error) {
    // Silently fail if project DB is unavailable
    // (e.g., during initialization or corruption)
    console.error(`Failed to sync stats for ${projectPath}:`, error);
  }
}

/**
 * Update runner's current task
 */
export function updateRunnerCurrentTask(
  runnerId: string,
  taskId: string | null
): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `UPDATE runners SET current_task_id = ?, heartbeat_at = datetime('now') WHERE id = ?`
    ).run(taskId, runnerId);
  } finally {
    close();
  }
}

/**
 * Remove runner from database
 */
export function unregisterRunner(runnerId: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('DELETE FROM runners WHERE id = ?').run(runnerId);
  } finally {
    close();
  }
}

/**
 * Get all runners
 */
export function listRunners(): Runner[] {
  const { db, close } = openGlobalDatabase();
  try {
    return db.prepare('SELECT * FROM runners').all() as Runner[];
  } finally {
    close();
  }
}

/**
 * Get runner by ID
 */
export function getRunner(runnerId: string): Runner | null {
  const { db, close } = openGlobalDatabase();
  try {
    return db
      .prepare('SELECT * FROM runners WHERE id = ?')
      .get(runnerId) as Runner | null;
  } finally {
    close();
  }
}

/**
 * Start the runner daemon
 * This is the main entry point for background task processing
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<void> {
  // Compute effective project path - default to cwd if not specified
  // Always resolve to absolute path for consistent tracking
  const effectiveProjectPath = resolve(options.projectPath ?? process.cwd());

  // Check if project is disabled in the global registry
  const registeredProject = getRegisteredProject(effectiveProjectPath);
  if (registeredProject && !registeredProject.enabled) {
    console.error(`Project is disabled: ${effectiveProjectPath}`);
    console.error('Run "steroids projects enable" to enable it.');
    process.exit(7); // Project disabled exit code
  }

  // Check if there's already an active runner for this specific project
  if (hasActiveRunnerForProject(effectiveProjectPath)) {
    console.error(
      `A runner is already active for project: ${effectiveProjectPath}`
    );
    console.error('Only one runner per project is allowed.');
    process.exit(6); // Resource locked exit code
  }

  // Register runner with effective project path and section ID
  // Note: Per-project isolation is enforced by hasActiveRunnerForProject() above
  const { runnerId, close: closeDb } = registerRunner(effectiveProjectPath, options.sectionId);
  const { db } = openGlobalDatabase();

  // Start heartbeat
  const heartbeat = createHeartbeatManager(db, runnerId);
  heartbeat.start();

  let isShuttingDown = false;

  // Graceful shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    // Stop heartbeat
    heartbeat.stop();

    // Update status
    updateRunnerStatus(runnerId, 'stopping');

    // Call shutdown callback
    if (options.onShutdown) {
      options.onShutdown();
    }

    // Clean up
    unregisterRunner(runnerId);
    closeDb();

    console.log('Runner stopped.');
    process.exit(0);
  };

  // Register signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(`Runner started (ID: ${runnerId}, PID: ${process.pid})`);
  updateRunnerStatus(runnerId, 'running');

  // Track if shutdown was requested
  let shutdownRequested = false;

  // Run the orchestrator loop
  try {
    await runOrchestratorLoop({
      projectPath: effectiveProjectPath,
      sectionId: options.sectionId,
      runnerId,  // Pass runner ID for activity logging
      shouldStop: () => shutdownRequested,
      onIteration: (iteration) => {
        // Update heartbeat on each iteration
        updateRunnerHeartbeat(runnerId);

        // Sync project stats to global DB for API/WebUI access
        syncProjectStats(effectiveProjectPath);
      },
      onHeartbeat: () => {
        updateRunnerHeartbeat(runnerId);
      },
      onTaskStart: (taskId) => {
        updateRunnerCurrentTask(runnerId, taskId);
      },
      onTaskComplete: () => {
        updateRunnerCurrentTask(runnerId, null);
      },
    });
  } catch (error) {
    console.error('Loop error:', error);
  }

  // Cleanup and exit
  shutdown('completed');
}

/**
 * Check if daemon can be started (no existing lock or project-specific runner)
 */
export function canStartDaemon(projectPath?: string): {
  canStart: boolean;
  reason?: string;
  existingPid?: number;
} {
  // Default to cwd if not specified for consistent per-project tracking
  // Always resolve to absolute path
  const effectivePath = resolve(projectPath ?? process.cwd());

  // Check if project is disabled
  const registeredProject = getRegisteredProject(effectivePath);
  if (registeredProject && !registeredProject.enabled) {
    return {
      canStart: false,
      reason: `Project is disabled: ${effectivePath}. Run "steroids projects enable" to enable it.`,
    };
  }

  // Check for project-specific runner (one runner per project allowed)
  if (hasActiveRunnerForProject(effectivePath)) {
    return {
      canStart: false,
      reason: `A runner is already active for project: ${effectivePath}`,
    };
  }

  // Multiple projects can run in parallel - no global lock check
  return { canStart: true };
}
