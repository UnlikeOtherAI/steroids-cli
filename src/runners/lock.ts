/**
 * Singleton lock for runner daemon
 * Uses directory-based locking with PID file
 */

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalSteroidsDir } from './global-db.js';

const LOCK_DIR = 'runners/lock';
const PID_FILE = 'pid';

export interface LockResult {
  acquired: boolean;
  existingPid?: number;
  isZombie?: boolean;
}

/**
 * Get the lock directory path
 */
export function getLockDir(): string {
  return join(getGlobalSteroidsDir(), LOCK_DIR);
}

/**
 * Get the PID file path
 */
export function getPidFilePath(): string {
  return join(getLockDir(), PID_FILE);
}

/**
 * Check if a process with given PID is running
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PID from lock file
 */
export function readLockPid(): number | null {
  const pidPath = getPidFilePath();
  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const content = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Remove the lock directory
 */
export function removeLock(): void {
  const lockDir = getLockDir();
  if (existsSync(lockDir)) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Attempt to acquire the singleton lock
 * Returns result indicating success or existing lock holder
 */
export function acquireLock(): LockResult {
  const lockDir = getLockDir();
  const pidPath = getPidFilePath();

  // Check if lock exists
  if (existsSync(lockDir)) {
    const existingPid = readLockPid();

    if (existingPid !== null) {
      if (isProcessAlive(existingPid)) {
        // Another runner is active
        return {
          acquired: false,
          existingPid,
          isZombie: false,
        };
      }

      // Zombie lock - process is dead
      removeLock();
      // Fall through to acquire
    } else {
      // Lock dir exists but no valid PID - clean up
      removeLock();
    }
  }

  // Create lock directory
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch (err) {
    // Race condition - another process may have created it
    if (existsSync(lockDir)) {
      const existingPid = readLockPid();
      if (existingPid !== null && isProcessAlive(existingPid)) {
        return {
          acquired: false,
          existingPid,
          isZombie: false,
        };
      }
    }
    throw err;
  }

  // Write our PID
  writeFileSync(pidPath, String(process.pid));

  return { acquired: true };
}

/**
 * Release the lock (should be called on shutdown)
 */
export function releaseLock(): void {
  const existingPid = readLockPid();

  // Only release if we own the lock
  if (existingPid === process.pid) {
    removeLock();
  }
}

/**
 * Check lock status without acquiring
 */
export function checkLockStatus(): {
  locked: boolean;
  pid: number | null;
  isZombie: boolean;
} {
  const lockDir = getLockDir();

  if (!existsSync(lockDir)) {
    return { locked: false, pid: null, isZombie: false };
  }

  const pid = readLockPid();
  if (pid === null) {
    return { locked: false, pid: null, isZombie: false };
  }

  const alive = isProcessAlive(pid);
  return {
    locked: alive,
    pid,
    isZombie: !alive,
  };
}
