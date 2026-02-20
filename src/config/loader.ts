/**
 * Configuration loader
 * Loads and merges global and project config files
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';

const STEROIDS_DIR = '.steroids';
const CONFIG_FILE = 'config.yaml';

export interface SteroidsConfig {
  ai?: {
    orchestrator?: {
      provider?: 'claude' | 'gemini' | 'openai' | 'codex' | 'mistral';
      model?: string;
      cli?: string;
    };
    coder?: {
      provider?: 'claude' | 'gemini' | 'openai' | 'codex' | 'mistral';
      model?: string;
      cli?: string;
    };
    reviewer?: {
      provider?: 'claude' | 'gemini' | 'openai' | 'codex' | 'mistral';
      model?: string;
      cli?: string;
    };
  };
  output?: {
    format?: 'table' | 'json';
    colors?: boolean;
    verbose?: boolean;
  };
  git?: {
    autoPush?: boolean;
    remote?: string;
    branch?: string;
    commitPrefix?: string;
    retryOnFailure?: boolean;
  };
  runners?: {
    heartbeatInterval?: string;
    staleTimeout?: string;
    subprocessHangTimeout?: string;
    maxConcurrent?: number;
    logRetention?: string;
    daemonLogs?: boolean;
    parallel?: {
      enabled?: boolean;
      maxClones?: number;
      workspaceRoot?: string;
      hydrationCommand?: string;
      allowSharedMutableDependencies?: boolean;
      autoDownshiftMaxClones?: boolean;
      minFreeMemoryMbPerClone?: number;
      minFreeDiskMbPerClone?: number;
      cleanupOnSuccess?: boolean;
      cleanupOnFailure?: boolean;
    };
  };
  health?: {
    threshold?: number;
    checks?: {
      git?: boolean;
      deps?: boolean;
      tests?: boolean;
      lint?: boolean;
    };
    // Stuck task detection/recovery (seconds unless otherwise noted)
    orphanedTaskTimeout?: number;
    maxCoderDuration?: number;
    maxReviewerDuration?: number;
    runnerHeartbeatTimeout?: number;
    invocationStaleness?: number;
    autoRecover?: boolean;
    maxRecoveryAttempts?: number;
    maxIncidentsPerHour?: number;
  };
  locking?: {
    taskTimeout?: string;
    sectionTimeout?: string;
    waitTimeout?: string;
    pollInterval?: string;
  };
  database?: {
    autoMigrate?: boolean;
    backupBeforeMigrate?: boolean;
  };
  logs?: {
    retention?: string;
    keepLogs?: boolean;
    level?: 'debug' | 'info' | 'warn' | 'error';
  };
  disputes?: {
    timeoutDays?: number;
    autoCreateOnMaxRejections?: boolean;
    majorBlocksLoop?: boolean;
    coordinatorCanDispute?: boolean;  // If true, coordinator can auto-dispute (stops loop). Default: false
  };
  projects?: {
    scanPaths?: string[];
    excludePatterns?: string[];
    allowedPaths?: string[];
    blockedPaths?: string[];
  };
  backup?: {
    enabled?: boolean;
    retention?: string;
    includeConfig?: boolean;
    includeLogs?: boolean;
  };
  build?: {
    timeout?: string;
  };
  test?: {
    timeout?: string;
  };
  webui?: {
    port?: number;
    host?: string;
    auth?: boolean;
  };
  quality?: {
    tests?: {
      required?: boolean;
      minCoverage?: number;
    };
  };
  sections?: {
    batchMode?: boolean;
    maxBatchSize?: number;
  };
  hooks?: unknown[]; // Array of hook configurations
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: SteroidsConfig = {
  ai: {
    orchestrator: {
      provider: 'claude',
      model: 'claude-sonnet-4',
    },
    coder: {
      provider: 'claude',
      model: 'claude-sonnet-4',
    },
    reviewer: {
      provider: 'claude',
      model: 'claude-sonnet-4',
    },
  },
  output: {
    format: 'table',
    colors: true,
    verbose: false,
  },
  git: {
    autoPush: true,
    remote: 'origin',
    branch: 'main',
    commitPrefix: '',
    retryOnFailure: true,
  },
  runners: {
    heartbeatInterval: '30s',
    staleTimeout: '5m',
    subprocessHangTimeout: '15m',
    maxConcurrent: 1,
    logRetention: '7d',
    parallel: {
      enabled: false,
      maxClones: 3,
      workspaceRoot: '',
      hydrationCommand: '',
      allowSharedMutableDependencies: false,
      autoDownshiftMaxClones: true,
      minFreeMemoryMbPerClone: 1024,
      minFreeDiskMbPerClone: 512,
      cleanupOnSuccess: true,
      cleanupOnFailure: false,
    },
  },
  health: {
    threshold: 80,
    checks: {
      git: true,
      deps: true,
      tests: true,
      lint: true,
    },
    orphanedTaskTimeout: 600,
    maxCoderDuration: 1800,
    maxReviewerDuration: 900,
    runnerHeartbeatTimeout: 300,
    invocationStaleness: 600,
    autoRecover: true,
    maxRecoveryAttempts: 3,
    maxIncidentsPerHour: 10,
  },
  locking: {
    taskTimeout: '60m',
    sectionTimeout: '120m',
    waitTimeout: '30m',
    pollInterval: '5s',
  },
  database: {
    autoMigrate: true,
    backupBeforeMigrate: true,
  },
  logs: {
    retention: '30d',
    keepLogs: true,
    level: 'info',
  },
  disputes: {
    timeoutDays: 7,
    autoCreateOnMaxRejections: true,
    majorBlocksLoop: false,
  },
  projects: {
    scanPaths: ['~/Projects'],
    excludePatterns: ['node_modules', '.git'],
    allowedPaths: [],
    blockedPaths: [],
  },
  backup: {
    enabled: true,
    retention: '7d',
    includeConfig: true,
    includeLogs: false,
  },
  build: {
    timeout: '5m',
  },
  test: {
    timeout: '10m',
  },
  webui: {
    port: 3000,
    host: 'localhost',
    auth: false,
  },
  quality: {
    tests: {
      required: false,
    },
  },
  sections: {
    batchMode: false,
    maxBatchSize: 10,
  },
};

/**
 * Get global config path (~/.steroids/config.yaml)
 */
export function getGlobalConfigPath(): string {
  return join(homedir(), STEROIDS_DIR, CONFIG_FILE);
}

/**
 * Get project config path (.steroids/config.yaml)
 */
export function getProjectConfigPath(projectPath?: string): string {
  const basePath = projectPath ?? process.cwd();
  return join(basePath, STEROIDS_DIR, CONFIG_FILE);
}

/**
 * Load config from a file
 * Returns empty object if file doesn't exist
 */
export function loadConfigFile(filePath: string): Partial<SteroidsConfig> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parse(content) ?? {};
  } catch (error) {
    console.warn(`Warning: Failed to parse config at ${filePath}`);
    return {};
  }
}

/**
 * Deep merge two config objects
 * Second object values override first
 */
export function mergeConfigs(
  base: Partial<SteroidsConfig>,
  override: Partial<SteroidsConfig>
): Partial<SteroidsConfig> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const baseValue = (base as Record<string, unknown>)[key];
    const overrideValue = (override as Record<string, unknown>)[key];

    // Skip "unset" values - empty strings, null, or undefined should not override base values
    // This preserves base config when override has empty/unset values
    // Note: We intentionally DO NOT skip false or 0, as these are legitimate override values
    if (overrideValue === undefined || overrideValue === null || overrideValue === '') {
      continue;
    }

    if (
      baseValue !== null &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue) &&
      overrideValue !== null &&
      typeof overrideValue === 'object' &&
      !Array.isArray(overrideValue)
    ) {
      // Deep merge nested objects
      result[key] = mergeConfigs(
        baseValue as Partial<SteroidsConfig>,
        overrideValue as Partial<SteroidsConfig>
      );
    } else {
      // Override value
      result[key] = overrideValue;
    }
  }

  return result as Partial<SteroidsConfig>;
}

/**
 * Apply environment variable overrides
 * STEROIDS_AI_CODER_MODEL -> ai.coder.model
 */
export function applyEnvOverrides(
  config: Partial<SteroidsConfig>
): Partial<SteroidsConfig> {
  const result = { ...config };

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('STEROIDS_')) continue;

    // Convert STEROIDS_AI_CODER_MODEL to ['ai', 'coder', 'model']
    const path = key
      .substring('STEROIDS_'.length)
      .toLowerCase()
      .split('_');

    // Set nested value
    let current: Record<string, unknown> = result as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      if (!(path[i] in current) || typeof current[path[i]] !== 'object') {
        current[path[i]] = {};
      }
      current = current[path[i]] as Record<string, unknown>;
    }

    // Convert value type
    const finalKey = path[path.length - 1];
    if (value === 'true') {
      current[finalKey] = true;
    } else if (value === 'false') {
      current[finalKey] = false;
    } else if (!isNaN(Number(value))) {
      current[finalKey] = Number(value);
    } else {
      current[finalKey] = value;
    }
  }

  return result;
}

/**
 * Load merged configuration
 * Priority: defaults < global < project < environment
 */
export function loadConfig(projectPath?: string): SteroidsConfig {
  // Start with defaults
  let config: Partial<SteroidsConfig> = { ...DEFAULT_CONFIG };

  // Load and merge global config
  const globalConfig = loadConfigFile(getGlobalConfigPath());
  config = mergeConfigs(config, globalConfig);

  // Load and merge project config
  const projectConfig = loadConfigFile(getProjectConfigPath(projectPath));
  config = mergeConfigs(config, projectConfig);

  // Apply environment overrides
  config = applyEnvOverrides(config);

  return config as SteroidsConfig;
}

/**
 * Save config to file
 */
export function saveConfig(
  config: Partial<SteroidsConfig>,
  filePath: string
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = stringify(config, { indent: 2 });
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Get a config value by dot-notation path
 * e.g., getConfigValue(config, 'ai.coder.model')
 */
export function getConfigValue(
  config: SteroidsConfig,
  path: string
): unknown {
  const parts = path.split('.');
  let current: unknown = config;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set a config value by dot-notation path
 * Returns a new config object with the value set
 */
export function setConfigValue(
  config: SteroidsConfig,
  path: string,
  value: unknown
): SteroidsConfig {
  const result = JSON.parse(JSON.stringify(config)) as SteroidsConfig;
  const parts = path.split('.');
  let current: Record<string, unknown> = result as Record<string, unknown>;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
  return result;
}
