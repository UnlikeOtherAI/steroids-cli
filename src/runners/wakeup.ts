/**
 * Cron wake-up command for restarting stale/dead runners
 */

import { withGlobalDatabase, getDaemonActiveStatus } from './global-db.js';
import { getRegisteredProjects } from './projects.js';
import {
  hasActiveRunnerForProject,
  hasActiveParallelSessionForProject,
} from './wakeup-checks.js';
import { getLastWakeupTime, recordWakeupTime } from './wakeup-timing.js';
import { performWakeupGlobalMaintenance } from './wakeup-global-cleanup.js';
import { processWakeupProject } from './wakeup-project.js';
import { checkWakeupNeeded } from './wakeup-needed.js';
import type { WakeupOptions, WakeupResult } from './wakeup-types.js';

export { getLastWakeupTime, hasActiveRunnerForProject, hasActiveParallelSessionForProject };
export type { WakeupOptions, WakeupResult };

// In-memory mutex to prevent concurrent wakeup cycles in the same process
let isWakeupRunning = false;

/**
 * Main wake-up function
 * Called by cron every minute to ensure runners are healthy
 * Iterates over ALL registered projects and starts runners as needed
 * Returns per-project results
 */
export async function wakeup(options: WakeupOptions = {}): Promise<WakeupResult[]> {
  const { quiet = false, dryRun = false } = options;
  const results: WakeupResult[] = [];

  const log = (msg: string): void => {
    if (!quiet) console.log(msg);
  };

  if (isWakeupRunning) {
    log('Wakeup cycle already running (in-memory lock), skipping.');
    return [{ action: 'skipped', reason: 'Wakeup cycle already running' }];
  }
  isWakeupRunning = true;

  try {
    if (!getDaemonActiveStatus()) {
      log('Daemon paused (is_active=false), skipping wakeup logic.');
      return [{ action: 'skipped', reason: 'Daemon is paused' }];
    }

    // Record wakeup invocation time (even for dry runs)
    if (!dryRun) {
      recordWakeupTime();
    }

    return withGlobalDatabase(async (globalDb) => {
      results.push(
        ...(await performWakeupGlobalMaintenance({
          globalDb,
          dryRun,
          log,
        }))
      );

      const registeredProjects = getRegisteredProjects(false);

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

      for (const project of registeredProjects) {
        results.push(
          await processWakeupProject({
            globalDb,
            projectPath: project.path,
            dryRun,
            log,
          })
        );
      }

      if (results.length === 0) {
        results.push({
          action: 'none',
          reason: 'No action needed',
        });
      }

      return results;
    });
  } finally {
    isWakeupRunning = false;
  }
}
export { checkWakeupNeeded };
