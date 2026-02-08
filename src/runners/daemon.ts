/**
 * Runner daemon - background process that executes tasks
 */

import { v4 as uuidv4 } from 'uuid';
import { openGlobalDatabase } from './global-db.js';
import { acquireLock, releaseLock, checkLockStatus } from './lock.js';
import { createHeartbeatManager } from './heartbeat.js';
import { hasActiveRunnerForProject } from './wakeup.js';

export type RunnerStatus = 'idle' | 'running' | 'stopping';

export interface Runner {
  id: string;
  status: RunnerStatus;
  pid: number | null;
  project_path: string | null;
  current_task_id: string | null;
  started_at: string | null;
  heartbeat_at: string;
}

export interface DaemonOptions {
  projectPath?: string;
  onTaskStart?: (taskId: string) => void;
  onTaskComplete?: (taskId: string) => void;
  onShutdown?: () => void;
}

/**
 * Register a new runner in the database
 */
export function registerRunner(
  projectPath?: string
): { runnerId: string; close: () => void } {
  const { db, close } = openGlobalDatabase();
  const runnerId = uuidv4();

  db.prepare(
    `INSERT INTO runners (id, status, pid, project_path, started_at, heartbeat_at)
     VALUES (?, 'idle', ?, ?, datetime('now'), datetime('now'))`
  ).run(runnerId, process.pid, projectPath ?? null);

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
  const effectiveProjectPath = options.projectPath ?? process.cwd();

  // Check if there's already an active runner for this specific project
  if (hasActiveRunnerForProject(effectiveProjectPath)) {
    console.error(
      `A runner is already active for project: ${effectiveProjectPath}`
    );
    console.error('Only one runner per project is allowed.');
    process.exit(6); // Resource locked exit code
  }

  // Try to acquire lock
  const lockResult = acquireLock();

  if (!lockResult.acquired) {
    if (lockResult.isZombie) {
      console.error('Found zombie lock, cleaned up. Retry starting.');
    } else {
      console.error(
        `Another runner is already active (PID: ${lockResult.existingPid})`
      );
    }
    process.exit(6); // Resource locked exit code
  }

  // Register runner with effective project path
  const { runnerId, close: closeDb } = registerRunner(effectiveProjectPath);
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
    releaseLock();
    closeDb();

    console.log('Runner stopped.');
    process.exit(0);
  };

  // Register signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(`Runner started (ID: ${runnerId}, PID: ${process.pid})`);
  updateRunnerStatus(runnerId, 'running');

  // The actual task processing loop would be implemented here
  // For now, we just keep the daemon alive
  console.log('Runner is idle, waiting for tasks...');

  // Keep process alive
  // In real implementation, this would be the task processing loop
  await new Promise(() => {
    // This promise never resolves - daemon runs until killed
  });
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
  const effectivePath = projectPath ?? process.cwd();

  // Check for project-specific runner first
  if (hasActiveRunnerForProject(effectivePath)) {
    return {
      canStart: false,
      reason: `A runner is already active for project: ${effectivePath}`,
    };
  }

  const status = checkLockStatus();

  if (status.locked) {
    return {
      canStart: false,
      reason: 'Another runner is already active',
      existingPid: status.pid ?? undefined,
    };
  }

  if (status.isZombie) {
    return {
      canStart: true,
      reason: 'Found zombie lock (will be cleaned)',
      existingPid: status.pid ?? undefined,
    };
  }

  return { canStart: true };
}
