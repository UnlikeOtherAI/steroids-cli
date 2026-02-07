/**
 * Cron wake-up command for restarting stale/dead runners
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { checkLockStatus, removeLock, isProcessAlive } from './lock.js';
import { openGlobalDatabase } from './global-db.js';
import { findStaleRunners } from './heartbeat.js';

export interface WakeupOptions {
  quiet?: boolean;
  dryRun?: boolean;
  projectPaths?: string[];
}

export interface WakeupResult {
  action: 'none' | 'started' | 'restarted' | 'cleaned';
  reason: string;
  runnerId?: string;
  pid?: number;
  staleRunners?: number;
  pendingTasks?: number;
}

/**
 * Check if a project has pending work
 */
function projectHasPendingWork(projectPath: string): boolean {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    // Dynamic import to avoid loading better-sqlite3 if not needed
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status IN ('pending', 'in_progress', 'review')`
      )
      .get() as { count: number };

    db.close();
    return result.count > 0;
  } catch {
    return false;
  }
}

/**
 * Scan directories for projects with pending work
 */
function findProjectsWithWork(basePaths: string[]): string[] {
  const projects: string[] = [];

  for (const basePath of basePaths) {
    const expandedPath = basePath.replace(/^~/, homedir());
    if (!existsSync(expandedPath)) continue;

    // Check if base path itself is a project
    if (projectHasPendingWork(expandedPath)) {
      projects.push(expandedPath);
    }

    // Check subdirectories (1 level deep)
    try {
      const entries = readdirSync(expandedPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subPath = join(expandedPath, entry.name);
          if (projectHasPendingWork(subPath)) {
            projects.push(subPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  return projects;
}

/**
 * Kill a process by PID
 */
function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a new runner daemon
 */
function startRunner(projectPath?: string): { pid: number } | null {
  try {
    // Start steroids loop in background
    const args = ['loop'];
    if (projectPath) {
      args.push('--project', projectPath);
    }

    const child = spawn('steroids', args, {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    return { pid: child.pid ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Main wake-up function
 * Called by cron every minute to ensure runners are healthy
 */
export function wakeup(options: WakeupOptions = {}): WakeupResult {
  const { quiet = false, dryRun = false, projectPaths = [] } = options;

  const log = (msg: string): void => {
    if (!quiet) console.log(msg);
  };

  // Step 1: Check lock status
  const lockStatus = checkLockStatus();

  if (lockStatus.locked && lockStatus.pid) {
    // Step 2: Check if runner is healthy (has recent heartbeat)
    const { db, close } = openGlobalDatabase();
    try {
      const staleRunners = findStaleRunners(db);

      if (staleRunners.length === 0) {
        // Runner is active and healthy
        log(`Runner is healthy (PID: ${lockStatus.pid})`);
        return {
          action: 'none',
          reason: 'Runner is active and healthy',
          pid: lockStatus.pid,
        };
      }

      // Step 3: Runner is stale - kill it
      log(`Found ${staleRunners.length} stale runner(s), cleaning up...`);

      if (!dryRun) {
        for (const runner of staleRunners) {
          if (runner.pid) {
            killProcess(runner.pid);
          }
          db.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
        }
        removeLock();
      }

      return {
        action: 'cleaned',
        reason: `Cleaned ${staleRunners.length} stale runner(s)`,
        staleRunners: staleRunners.length,
      };
    } finally {
      close();
    }
  }

  // Step 4: No active runner - check for pending work
  if (lockStatus.isZombie && lockStatus.pid) {
    log(`Found zombie lock (PID: ${lockStatus.pid}), cleaning...`);
    if (!dryRun) {
      removeLock();
    }
  }

  // Determine project paths to check
  const pathsToCheck =
    projectPaths.length > 0 ? projectPaths : [process.cwd()];

  const projectsWithWork = findProjectsWithWork(pathsToCheck);

  if (projectsWithWork.length === 0) {
    log('No projects with pending tasks found');
    return {
      action: 'none',
      reason: 'No pending tasks',
      pendingTasks: 0,
    };
  }

  // Step 5: Start a new runner
  log(`Found ${projectsWithWork.length} project(s) with work`);
  log(`Starting runner for: ${projectsWithWork[0]}`);

  if (dryRun) {
    return {
      action: 'started',
      reason: `Would start runner for ${projectsWithWork[0]} (dry-run)`,
      pendingTasks: projectsWithWork.length,
    };
  }

  const result = startRunner(projectsWithWork[0]);
  if (result) {
    return {
      action: 'started',
      reason: `Started runner for ${projectsWithWork[0]}`,
      pid: result.pid,
      pendingTasks: projectsWithWork.length,
    };
  }

  return {
    action: 'none',
    reason: 'Failed to start runner',
  };
}

/**
 * Check if wake-up is needed without taking action
 */
export function checkWakeupNeeded(projectPaths: string[] = []): {
  needed: boolean;
  reason: string;
} {
  const lockStatus = checkLockStatus();

  if (lockStatus.locked && lockStatus.pid) {
    const { db, close } = openGlobalDatabase();
    try {
      const staleRunners = findStaleRunners(db);
      if (staleRunners.length > 0) {
        return {
          needed: true,
          reason: `${staleRunners.length} stale runner(s) need cleanup`,
        };
      }
      return { needed: false, reason: 'Runner is healthy' };
    } finally {
      close();
    }
  }

  if (lockStatus.isZombie) {
    return { needed: true, reason: 'Zombie lock needs cleanup' };
  }

  const pathsToCheck =
    projectPaths.length > 0 ? projectPaths : [process.cwd()];
  const projectsWithWork = findProjectsWithWork(pathsToCheck);

  if (projectsWithWork.length > 0) {
    return {
      needed: true,
      reason: `${projectsWithWork.length} project(s) have pending tasks`,
    };
  }

  return { needed: false, reason: 'No pending tasks' };
}
