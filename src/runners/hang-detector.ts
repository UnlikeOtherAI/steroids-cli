/**
 * Subprocess hang detection
 * Monitors log output and kills processes that appear stuck
 */

import type { ChildProcess } from 'node:child_process';

const DEFAULT_HANG_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface HangDetectorOptions {
  timeoutMs?: number;
  onHang?: (lastOutput: Date, elapsedMs: number) => void;
  onOutput?: () => void;
}

export interface HangDetector {
  recordOutput: () => void;
  isHung: () => boolean;
  getLastOutputTime: () => Date;
  getElapsedSinceOutput: () => number;
  stop: () => void;
}

/**
 * Create a hang detector for a subprocess
 * Monitors output activity and detects when a process appears stuck
 */
export function createHangDetector(
  options: HangDetectorOptions = {}
): HangDetector {
  const { timeoutMs = DEFAULT_HANG_TIMEOUT_MS, onHang, onOutput } = options;

  let lastOutputTime = new Date();
  let checkInterval: NodeJS.Timeout | null = null;
  let hasNotifiedHang = false;

  const recordOutput = (): void => {
    lastOutputTime = new Date();
    hasNotifiedHang = false;
    if (onOutput) {
      onOutput();
    }
  };

  const getElapsedSinceOutput = (): number => {
    return Date.now() - lastOutputTime.getTime();
  };

  const isHung = (): boolean => {
    return getElapsedSinceOutput() > timeoutMs;
  };

  const getLastOutputTime = (): Date => {
    return lastOutputTime;
  };

  // Start periodic check
  checkInterval = setInterval(() => {
    if (isHung() && !hasNotifiedHang) {
      hasNotifiedHang = true;
      if (onHang) {
        onHang(lastOutputTime, getElapsedSinceOutput());
      }
    }
  }, 60 * 1000); // Check every minute

  const stop = (): void => {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  };

  return {
    recordOutput,
    isHung,
    getLastOutputTime,
    getElapsedSinceOutput,
    stop,
  };
}

/**
 * Attach hang detection to a child process
 * Monitors stdout/stderr for output activity
 */
export function attachHangDetector(
  child: ChildProcess,
  options: HangDetectorOptions & { killOnHang?: boolean } = {}
): HangDetector {
  const { killOnHang = true, ...detectorOptions } = options;

  const detector = createHangDetector({
    ...detectorOptions,
    onHang: (lastOutput, elapsed) => {
      const minutes = Math.floor(elapsed / 60000);
      console.error(
        `Process appears hung (no output for ${minutes} minutes)`
      );

      if (killOnHang && child.pid) {
        console.error(`Killing hung process (PID: ${child.pid})`);
        try {
          child.kill('SIGTERM');

          // Force kill after 10 seconds if still alive
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // Process already dead
            }
          }, 10000);
        } catch {
          // Process already dead
        }
      }

      if (detectorOptions.onHang) {
        detectorOptions.onHang(lastOutput, elapsed);
      }
    },
  });

  // Monitor stdout
  if (child.stdout) {
    child.stdout.on('data', () => {
      detector.recordOutput();
    });
  }

  // Monitor stderr
  if (child.stderr) {
    child.stderr.on('data', () => {
      detector.recordOutput();
    });
  }

  // Clean up on process exit
  child.on('exit', () => {
    detector.stop();
  });

  child.on('error', () => {
    detector.stop();
  });

  return detector;
}

/**
 * Get default hang timeout in milliseconds
 */
export function getDefaultHangTimeout(): number {
  return DEFAULT_HANG_TIMEOUT_MS;
}

/**
 * Format elapsed time for display
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
