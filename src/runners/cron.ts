/**
 * Cron management for runner wake-up
 */

import { execSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const CRON_COMMENT = '# steroids-runners-wakeup';
const CRON_ENTRY = '* * * * * steroids runners wakeup --quiet';

export interface CronStatus {
  installed: boolean;
  entry?: string;
  error?: string;
}

export interface CronResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Get current crontab contents
 */
function getCrontab(): string | null {
  try {
    const result = spawnSync('crontab', ['-l'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      // "no crontab for user" is not an error for our purposes
      if (result.stderr?.includes('no crontab')) {
        return '';
      }
      return null;
    }

    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * Set crontab contents
 */
function setCrontab(contents: string): boolean {
  try {
    const result = spawnSync('crontab', ['-'], {
      input: contents,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Find the steroids binary path
 */
function findSteroidsPath(): string {
  try {
    const result = execSync('which steroids', { encoding: 'utf-8' }).trim();
    return result || 'steroids';
  } catch {
    return 'steroids';
  }
}

/**
 * Check cron installation status
 */
export function cronStatus(): CronStatus {
  if (platform() === 'win32') {
    return {
      installed: false,
      error: 'Cron is not supported on Windows. Use Task Scheduler instead.',
    };
  }

  const crontab = getCrontab();

  if (crontab === null) {
    return {
      installed: false,
      error: 'Failed to read crontab',
    };
  }

  const lines = crontab.split('\n');
  const steroidsLine = lines.find(
    (line) => line.includes(CRON_COMMENT) || line.includes('steroids runners wakeup')
  );

  if (steroidsLine) {
    return {
      installed: true,
      entry: steroidsLine,
    };
  }

  return { installed: false };
}

/**
 * Install cron job for runner wake-up
 */
export function cronInstall(): CronResult {
  if (platform() === 'win32') {
    return {
      success: false,
      message: 'Cron not supported on Windows',
      error: 'Use Task Scheduler to run: steroids runners wakeup --quiet',
    };
  }

  // Check if already installed
  const status = cronStatus();
  if (status.installed) {
    return {
      success: true,
      message: 'Cron job already installed',
    };
  }

  const crontab = getCrontab();
  if (crontab === null) {
    return {
      success: false,
      message: 'Failed to read crontab',
      error: 'Could not access crontab. Check permissions.',
    };
  }

  // Find steroids path for full path in crontab
  const steroidsPath = findSteroidsPath();
  const cronLine = `${CRON_COMMENT}\n* * * * * ${steroidsPath} runners wakeup --quiet`;

  // Append to existing crontab
  const newCrontab = crontab.trim()
    ? `${crontab.trim()}\n${cronLine}\n`
    : `${cronLine}\n`;

  if (!setCrontab(newCrontab)) {
    return {
      success: false,
      message: 'Failed to update crontab',
      error: 'Could not write to crontab. Check permissions.',
    };
  }

  return {
    success: true,
    message: `Cron job installed. Wake-up runs every minute.`,
  };
}

/**
 * Uninstall cron job
 */
export function cronUninstall(): CronResult {
  if (platform() === 'win32') {
    return {
      success: false,
      message: 'Cron not supported on Windows',
      error: 'Remove the Task Scheduler entry manually.',
    };
  }

  const crontab = getCrontab();
  if (crontab === null) {
    return {
      success: false,
      message: 'Failed to read crontab',
    };
  }

  // Remove lines containing steroids runners wakeup or our comment
  const lines = crontab.split('\n');
  const filteredLines = lines.filter(
    (line) =>
      !line.includes(CRON_COMMENT) && !line.includes('steroids runners wakeup')
  );

  if (lines.length === filteredLines.length) {
    return {
      success: true,
      message: 'No cron job found to remove',
    };
  }

  const newCrontab = filteredLines.join('\n');

  if (!setCrontab(newCrontab)) {
    return {
      success: false,
      message: 'Failed to update crontab',
    };
  }

  return {
    success: true,
    message: 'Cron job removed',
  };
}
