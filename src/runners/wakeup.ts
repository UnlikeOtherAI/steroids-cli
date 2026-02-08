/**
 * Cron wake-up command for restarting stale/dead runners
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { checkLockStatus, removeLock } from './lock.js';
import { openGlobalDatabase } from './global-db.js';
import { findStaleRunners } from './heartbeat.js';
import { getRegisteredProjects } from './projects.js';

export interface WakeupOptions {
  quiet?: boolean;
  dryRun?: boolean;
}

export interface WakeupResult {
  action: 'none' | 'started' | 'restarted' | 'cleaned' | 'would_start';
  reason: string;
  runnerId?: string;
  pid?: number;
  staleRunners?: number;
  pendingTasks?: number;
  projectPath?: string;
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
 * Check if there's an active runner for a specific project
 * Exported for use in daemon startup checks
 */
export function hasActiveRunnerForProject(projectPath: string): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM runners
         WHERE project_path = ?
         AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes')`
      )
      .get(projectPath) as { 1: number } | undefined;

    return row !== undefined;
  } finally {
    close();
  }
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
 * Iterates over ALL registered projects and starts runners as needed
 * Returns per-project results
 */
export function wakeup(options: WakeupOptions = {}): WakeupResult[] {
  const { quiet = false, dryRun = false } = options;
  const results: WakeupResult[] = [];

  const log = (msg: string): void => {
    if (!quiet) console.log(msg);
  };

  // Step 1: Clean up stale runners first
  const { db, close } = openGlobalDatabase();
  try {
    const staleRunners = findStaleRunners(db);
    if (staleRunners.length > 0) {
      log(`Found ${staleRunners.length} stale runner(s), cleaning up...`);
      if (!dryRun) {
        for (const runner of staleRunners) {
          if (runner.pid) {
            killProcess(runner.pid);
          }
          db.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
        }
      }
      results.push({
        action: 'cleaned',
        reason: `Cleaned ${staleRunners.length} stale runner(s)`,
        staleRunners: staleRunners.length,
      });
    }
  } finally {
    close();
  }

  // Step 2: Clean zombie lock if present
  const lockStatus = checkLockStatus();
  if (lockStatus.isZombie && lockStatus.pid) {
    log(`Found zombie lock (PID: ${lockStatus.pid}), cleaning...`);
    if (!dryRun) {
      removeLock();
    }
  }

  // Step 3: Get all registered projects from global registry
  const registeredProjects = getRegisteredProjects(false); // enabled only

  if (registeredProjects.length === 0) {
    log('No registered projects found');
    log('Run "steroids projects add <path>" to register a project');
    results.push({
      action: 'none',
      reason: 'No registered projects',
      pendingTasks: 0,
    });
    return results;
  }

  log(`Checking ${registeredProjects.length} registered project(s)...`);

  // Step 4: Check each project and start runners as needed
  for (const project of registeredProjects) {
    // Skip if project directory doesn't exist
    if (!existsSync(project.path)) {
      log(`Skipping ${project.path}: directory not found`);
      results.push({
        action: 'none',
        reason: 'Directory not found',
        projectPath: project.path,
      });
      continue;
    }

    // Skip if project already has an active runner
    if (hasActiveRunnerForProject(project.path)) {
      log(`Skipping ${project.path}: runner already active`);
      results.push({
        action: 'none',
        reason: 'Runner already active',
        projectPath: project.path,
      });
      continue;
    }

    // Check for pending work
    if (!projectHasPendingWork(project.path)) {
      log(`Skipping ${project.path}: no pending tasks`);
      results.push({
        action: 'none',
        reason: 'No pending tasks',
        projectPath: project.path,
      });
      continue;
    }

    // Start runner for this project
    log(`Starting runner for: ${project.path}`);

    if (dryRun) {
      results.push({
        action: 'would_start',
        reason: `Would start runner (dry-run)`,
        projectPath: project.path,
      });
      continue;
    }

    const startResult = startRunner(project.path);
    if (startResult) {
      results.push({
        action: 'started',
        reason: `Started runner`,
        pid: startResult.pid,
        projectPath: project.path,
      });
    } else {
      results.push({
        action: 'none',
        reason: 'Failed to start runner',
        projectPath: project.path,
      });
    }
  }

  // If no specific results, add a summary
  if (results.length === 0) {
    results.push({
      action: 'none',
      reason: 'No action needed',
    });
  }

  return results;
}

/**
 * Check if wake-up is needed without taking action
 */
export function checkWakeupNeeded(): {
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

  // Check registered projects
  const registeredProjects = getRegisteredProjects(false);
  let projectsWithWork = 0;

  for (const project of registeredProjects) {
    if (existsSync(project.path) && projectHasPendingWork(project.path)) {
      projectsWithWork++;
    }
  }

  if (projectsWithWork > 0) {
    return {
      needed: true,
      reason: `${projectsWithWork} project(s) have pending tasks`,
    };
  }

  return { needed: false, reason: 'No pending tasks' };
}
