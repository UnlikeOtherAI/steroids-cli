/**
 * Environment variable support for Steroids CLI
 *
 * Provides centralized access to environment variables and their mappings
 * to CLI flags and configuration options.
 *
 * Environment variables override defaults but are themselves overridden by
 * explicit CLI flags.
 */

/**
 * All supported environment variables for Steroids CLI
 */
export const ENV_VARS = {
  /** Custom config path (maps to --config) */
  STEROIDS_CONFIG: 'STEROIDS_CONFIG',

  /** Output as JSON (maps to --json) */
  STEROIDS_JSON: 'STEROIDS_JSON',

  /** Minimal output (maps to --quiet) */
  STEROIDS_QUIET: 'STEROIDS_QUIET',

  /** Detailed output (maps to --verbose) */
  STEROIDS_VERBOSE: 'STEROIDS_VERBOSE',

  /** Skip hook execution (maps to --no-hooks) */
  STEROIDS_NO_HOOKS: 'STEROIDS_NO_HOOKS',

  /** Disable colors (maps to --no-color) */
  STEROIDS_NO_COLOR: 'STEROIDS_NO_COLOR',

  /** Auto-migrate database without prompting */
  STEROIDS_AUTO_MIGRATE: 'STEROIDS_AUTO_MIGRATE',

  /** Command timeout duration (maps to --timeout) */
  STEROIDS_TIMEOUT: 'STEROIDS_TIMEOUT',

  /** Standard NO_COLOR env var (also maps to --no-color) */
  NO_COLOR: 'NO_COLOR',

  /** CI environment detection (various systems set this) */
  CI: 'CI',

  /** Continuous Integration (legacy) */
  CONTINUOUS_INTEGRATION: 'CONTINUOUS_INTEGRATION',

  /** GitHub Actions */
  GITHUB_ACTIONS: 'GITHUB_ACTIONS',

  /** GitLab CI */
  GITLAB_CI: 'GITLAB_CI',

  /** CircleCI */
  CIRCLECI: 'CIRCLECI',

  /** Travis CI */
  TRAVIS: 'TRAVIS',

  /** Jenkins */
  JENKINS_URL: 'JENKINS_URL',
} as const;

/**
 * Check if a value is truthy for boolean environment variables
 *
 * Accepts: '1', 'true' (case-insensitive), 'yes', 'on'
 * Rejects: '0', 'false', 'no', 'off', undefined, empty string
 */
export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Check if a value is falsy for boolean environment variables
 *
 * Accepts: '0', 'false' (case-insensitive), 'no', 'off'
 * Empty string and undefined are treated as "not set" (returns false)
 */
export function isFalsy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

/**
 * Get environment variable value
 */
export function getEnv(key: keyof typeof ENV_VARS): string | undefined {
  return process.env[ENV_VARS[key]];
}

/**
 * Check if environment variable is set to truthy value
 */
export function isEnvTrue(key: keyof typeof ENV_VARS): boolean {
  return isTruthy(getEnv(key));
}

/**
 * Check if environment variable is set to falsy value
 */
export function isEnvFalse(key: keyof typeof ENV_VARS): boolean {
  return isFalsy(getEnv(key));
}

/**
 * Get environment variable as string or default
 */
export function getEnvString(key: keyof typeof ENV_VARS, defaultValue: string): string {
  return getEnv(key) ?? defaultValue;
}

/**
 * Detect if running in CI environment
 */
export function isCI(): boolean {
  return !!(
    getEnv('CI') ||
    getEnv('CONTINUOUS_INTEGRATION') ||
    getEnv('GITHUB_ACTIONS') ||
    getEnv('GITLAB_CI') ||
    getEnv('CIRCLECI') ||
    getEnv('TRAVIS') ||
    getEnv('JENKINS_URL')
  );
}

/**
 * Detect which CI system is running (if any)
 */
export function getCISystem(): string | null {
  if (getEnv('GITHUB_ACTIONS')) return 'GitHub Actions';
  if (getEnv('GITLAB_CI')) return 'GitLab CI';
  if (getEnv('CIRCLECI')) return 'CircleCI';
  if (getEnv('TRAVIS')) return 'Travis CI';
  if (getEnv('JENKINS_URL')) return 'Jenkins';
  if (getEnv('CI')) return 'Generic CI';
  return null;
}

/**
 * Check if colors should be disabled based on env vars
 */
export function shouldDisableColors(): boolean {
  return !!(
    getEnv('NO_COLOR') !== undefined ||
    isEnvTrue('STEROIDS_NO_COLOR')
  );
}

/**
 * Check if auto-migration is enabled
 */
export function isAutoMigrateEnabled(): boolean {
  return isEnvTrue('STEROIDS_AUTO_MIGRATE');
}

/**
 * Get all relevant environment variables for debugging
 */
export function getEnvSnapshot(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(ENV_VARS) as Array<keyof typeof ENV_VARS>) {
    const value = getEnv(key);
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

/**
 * Environment variable documentation for help text
 */
export const ENV_VAR_DOCS = {
  [ENV_VARS.STEROIDS_CONFIG]: {
    description: 'Custom config file path',
    values: 'Path to config file',
    mapsTo: '--config',
  },
  [ENV_VARS.STEROIDS_JSON]: {
    description: 'Output as JSON',
    values: '1, true',
    mapsTo: '--json',
  },
  [ENV_VARS.STEROIDS_QUIET]: {
    description: 'Minimal output',
    values: '1, true',
    mapsTo: '--quiet',
  },
  [ENV_VARS.STEROIDS_VERBOSE]: {
    description: 'Detailed output',
    values: '1, true',
    mapsTo: '--verbose',
  },
  [ENV_VARS.STEROIDS_NO_HOOKS]: {
    description: 'Skip hook execution',
    values: '1, true',
    mapsTo: '--no-hooks',
  },
  [ENV_VARS.STEROIDS_NO_COLOR]: {
    description: 'Disable colored output',
    values: '1, true',
    mapsTo: '--no-color',
  },
  [ENV_VARS.STEROIDS_AUTO_MIGRATE]: {
    description: 'Auto-migrate database without prompting',
    values: '1, true',
    mapsTo: 'auto-migrate behavior',
  },
  [ENV_VARS.STEROIDS_TIMEOUT]: {
    description: 'Command timeout duration',
    values: 'Duration (e.g., 30s, 5m, 1h)',
    mapsTo: '--timeout',
  },
  [ENV_VARS.NO_COLOR]: {
    description: 'Standard no-color.org variable',
    values: 'Any value',
    mapsTo: '--no-color',
  },
  [ENV_VARS.CI]: {
    description: 'Detected CI environment',
    values: 'Any value',
    mapsTo: 'Non-interactive mode',
  },
} as const;
