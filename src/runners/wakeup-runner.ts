/**
 * Runner management for wakeup
 */

import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config/loader.js';
import type { WorkstreamToRestart } from './wakeup-reconcile.js';

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

/**
 * Restart a specific workstream runner after a crash.
 * Spawns a detached daemon pointing at the workstream's clone directory
 * with the correct section filter and parallel session context.
 */
export function restartWorkstreamRunner(ws: WorkstreamToRestart): number | null {
  try {
    const logsDir = join(homedir(), '.steroids', 'runners', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFd = openSync(join(logsDir, `daemon-${Date.now()}.log`), 'a');

    const child = spawn(
      process.execPath,
      [
        process.argv[1],
        'runners',
        'start',
        '--project', ws.clonePath,
        '--parallel',
        '--section-ids', ws.sectionIds,
        '--branch', ws.branchName,
        '--parallel-session-id', ws.sessionId,
      ],
      {
        cwd: ws.clonePath,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      }
    );
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}
