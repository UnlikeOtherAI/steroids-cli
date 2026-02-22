/**
 * Runner management for wakeup
 */

import { spawn } from 'node:child_process';
import { loadConfig } from '../config/loader.js';

/**
 * Kill a process by PID
 */
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a new runner daemon
 * Uses 'steroids runners start --detach' so the runner registers in the global DB
 * and updates heartbeat, allowing hasActiveRunnerForProject() to detect it.
 * When runners.parallel.enabled is true, launches a parallel session instead.
 */
export function startRunner(projectPath: string): { pid: number; parallel?: boolean } | null {
  try {
    const config = loadConfig(projectPath);
    const parallelEnabled = config.runners?.parallel?.enabled === true;

    const args = parallelEnabled
      ? ['runners', 'start', '--parallel', '--project', projectPath]
      : ['runners', 'start', '--detach', '--project', projectPath];

    const child = spawn('steroids', args, {
      cwd: projectPath,
      detached: true,
      stdio: 'ignore',
    });

    child.unref();
    return { pid: child.pid ?? 0, parallel: parallelEnabled };
  } catch {
    return null;
  }
}
