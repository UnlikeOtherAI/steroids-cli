/**
 * Interactive mode detection for Steroids CLI
 *
 * Detects whether the CLI is running in an interactive terminal
 * or in a non-interactive environment (CI, piped output, etc.)
 */

import { CliError, ErrorCode } from './errors.js';

/**
 * Check if the CLI is running in interactive mode
 *
 * Interactive mode requires:
 * - stdin is a TTY (not piped input)
 * - stdout is a TTY (not piped output)
 * - Not running in CI environment
 *
 * @returns true if interactive, false otherwise
 */
export function isInteractive(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    !process.env.CI
  );
}

/**
 * Check if running in CI environment
 *
 * Checks for common CI environment variables:
 * - CI (most CI systems)
 * - CONTINUOUS_INTEGRATION (legacy)
 * - GITHUB_ACTIONS
 * - GITLAB_CI
 * - CIRCLECI
 * - TRAVIS
 * - JENKINS_URL
 *
 * @returns true if in CI, false otherwise
 */
export function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.CONTINUOUS_INTEGRATION ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.JENKINS_URL
  );
}

/**
 * Require interactive mode or throw an error
 *
 * Use this for commands that cannot run in non-interactive mode
 * without explicit flags.
 *
 * @param message - The error message to show
 * @throws CliError with INVALID_ARGUMENTS code
 *
 * @example
 * ```typescript
 * requireInteractive('Cannot prompt for migration confirmation');
 * // If in CI, throws: Error: Cannot prompt for migration confirmation
 * //                   This operation requires interactive mode or explicit flags.
 * ```
 */
export function requireInteractive(message: string): void {
  if (!isInteractive()) {
    throw new CliError(
      ErrorCode.INVALID_ARGUMENTS,
      `${message}\nThis operation requires interactive mode or explicit flags.`
    );
  }
}

/**
 * Warn if running in non-interactive mode
 *
 * Use this for commands that work better in interactive mode
 * but can still function non-interactively.
 *
 * @param message - Warning message to show
 */
export function warnNonInteractive(message: string): void {
  if (!isInteractive() && !process.env.STEROIDS_QUIET) {
    console.warn(`Warning: ${message}`);
    if (isCI()) {
      console.warn('Detected CI environment. Use explicit flags to avoid interactive prompts.');
    }
  }
}

/**
 * Get a descriptive string about the current environment
 *
 * Useful for debugging and verbose output.
 *
 * @returns Environment description
 */
export function getEnvironmentInfo(): {
  interactive: boolean;
  ci: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  ciSystem?: string;
} {
  const info = {
    interactive: isInteractive(),
    ci: isCI(),
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    ciSystem: undefined as string | undefined,
  };

  // Detect specific CI system
  if (process.env.GITHUB_ACTIONS) {
    info.ciSystem = 'GitHub Actions';
  } else if (process.env.GITLAB_CI) {
    info.ciSystem = 'GitLab CI';
  } else if (process.env.CIRCLECI) {
    info.ciSystem = 'CircleCI';
  } else if (process.env.TRAVIS) {
    info.ciSystem = 'Travis CI';
  } else if (process.env.JENKINS_URL) {
    info.ciSystem = 'Jenkins';
  } else if (process.env.CI) {
    info.ciSystem = 'Generic CI';
  }

  return info;
}
