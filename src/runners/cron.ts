/**
 * Cron management for runner wake-up
 * Uses launchd on macOS (no permissions needed), cron on Linux
 */

import { execSync, spawnSync } from 'node:child_process';
import { platform, homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CRON_COMMENT = '# steroids-runners-wakeup';
const CRON_ENTRY = '* * * * * steroids runners wakeup --quiet';
const LAUNCHD_LABEL = 'com.unlikeotherai.steroids.wakeup';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

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
 * Generate launchd plist content
 */
function generateLaunchdPlist(): string {
  const steroidsPath = findSteroidsPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${steroidsPath}</string>
        <string>runners</string>
        <string>wakeup</string>
        <string>--quiet</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${homedir()}/Library/Logs/steroids-wakeup.log</string>
    <key>StandardErrorPath</key>
    <string>${homedir()}/Library/Logs/steroids-wakeup-error.log</string>
</dict>
</plist>`;
}

/**
 * Check launchd installation status (macOS)
 */
function launchdStatus(): CronStatus {
  try {
    // Check if plist file exists
    if (!existsSync(LAUNCHD_PLIST)) {
      return { installed: false };
    }

    // Check if loaded
    const result = spawnSync('launchctl', ['list', LAUNCHD_LABEL], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const isLoaded = result.status === 0;

    return {
      installed: isLoaded,
      entry: isLoaded ? `launchd: ${LAUNCHD_LABEL}` : undefined,
    };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Install launchd job (macOS)
 */
function launchdInstall(): CronResult {
  try {
    // Check if already installed and loaded
    const status = launchdStatus();
    if (status.installed) {
      return {
        success: true,
        message: 'Launchd job already installed',
      };
    }

    // Generate and write plist
    const plistContent = generateLaunchdPlist();
    writeFileSync(LAUNCHD_PLIST, plistContent, 'utf-8');

    // Load the job
    const result = spawnSync('launchctl', ['load', LAUNCHD_PLIST], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      return {
        success: false,
        message: 'Failed to load launchd job',
        error: result.stderr || 'Unknown error',
      };
    }

    return {
      success: true,
      message: 'Launchd job installed. Wake-up runs every minute.',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to install launchd job',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Uninstall launchd job (macOS)
 */
function launchdUninstall(): CronResult {
  try {
    // Unload if loaded
    const status = launchdStatus();
    if (status.installed) {
      const result = spawnSync('launchctl', ['unload', LAUNCHD_PLIST], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.status !== 0 && !result.stderr?.includes('Could not find')) {
        return {
          success: false,
          message: 'Failed to unload launchd job',
          error: result.stderr || 'Unknown error',
        };
      }
    }

    // Remove plist file
    if (existsSync(LAUNCHD_PLIST)) {
      unlinkSync(LAUNCHD_PLIST);
    }

    return {
      success: true,
      message: 'Launchd job removed',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to uninstall launchd job',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check cron/launchd installation status
 * Uses launchd on macOS, cron on Linux
 */
export function cronStatus(): CronStatus {
  if (platform() === 'win32') {
    return {
      installed: false,
      error: 'Cron is not supported on Windows. Use Task Scheduler instead.',
    };
  }

  // Use launchd on macOS (no permissions needed)
  if (platform() === 'darwin') {
    return launchdStatus();
  }

  // Use cron on Linux
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
 * Install cron/launchd job for runner wake-up
 * Uses launchd on macOS (no permissions needed), cron on Linux
 */
export function cronInstall(): CronResult {
  if (platform() === 'win32') {
    return {
      success: false,
      message: 'Cron not supported on Windows',
      error: 'Use Task Scheduler to run: steroids runners wakeup --quiet',
    };
  }

  // Use launchd on macOS (no permissions needed)
  if (platform() === 'darwin') {
    return launchdInstall();
  }

  // Use cron on Linux
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
 * Uninstall cron/launchd job
 * Uses launchd on macOS, cron on Linux
 */
export function cronUninstall(): CronResult {
  if (platform() === 'win32') {
    return {
      success: false,
      message: 'Cron not supported on Windows',
      error: 'Remove the Task Scheduler entry manually.',
    };
  }

  // Use launchd on macOS
  if (platform() === 'darwin') {
    return launchdUninstall();
  }

  // Use cron on Linux
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
      !line.includes(CRON_COMMENT) &&
      !line.includes('steroids runners wakeup')
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
