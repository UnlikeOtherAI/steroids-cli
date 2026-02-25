/**
 * Runner management for wakeup
 */

import { spawn } from 'node:child_process';
import { existsSync, openSync, mkdirSync } from 'node:fs';
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

function resolveCliEntrypoint(): string | null {
  // Dist runtime: dist/runners/wakeup-runner.js -> dist/index.js
  const distCliPath = join(__dirname, '..', 'index.js');
  if (existsSync(distCliPath)) {
    return distCliPath;
  }
  return null;
}

/**
 * Start a new runner daemon
 * Uses 'steroids runners start --detach' so the runner registers in the global DB
 * and updates heartbeat, allowing hasActiveRunnerForProject() to detect it.
 * Mode (single vs parallel) is resolved by runners start from project config.
 */
export function startRunner(projectPath: string): { pid: number; parallel?: boolean } | null {
  try {
    const config = loadConfig(projectPath);
    const parallelEnabled = config.runners?.parallel?.enabled === true;
    const cliEntrypoint = resolveCliEntrypoint();
    if (!cliEntrypoint) {
      return null;
    }

    const args = ['runners', 'start', '--detach', '--project', projectPath];

    const child = spawn(process.execPath, [cliEntrypoint, ...args], {
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
    const cliEntrypoint = resolveCliEntrypoint();
    if (!cliEntrypoint) {
      return null;
    }

    const logsDir = join(homedir(), '.steroids', 'runners', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFd = openSync(join(logsDir, `daemon-${Date.now()}.log`), 'a');

    const child = spawn(
      process.execPath,
      [
        cliEntrypoint,
        'runners',
        'start',
        '--project', ws.clonePath,
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
