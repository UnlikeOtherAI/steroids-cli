/**
 * Configuration schema with descriptions, options, and defaults
 */

export interface SchemaField {
  _description: string;
  _type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  _options?: readonly (string | number | boolean)[];
  _default?: unknown;
  _required?: boolean;
}

export interface SchemaObject {
  [key: string]: SchemaField | SchemaObject;
}

/**
 * Full configuration schema
 */
export const CONFIG_SCHEMA: SchemaObject = {
  ai: {
    _description: 'AI provider configuration',
    _type: 'object',
    orchestrator: {
      _description: 'AI settings for orchestration decisions',
      _type: 'object',
      provider: {
        _description: 'AI provider for orchestrator',
        _type: 'string',
        _options: ['claude', 'gemini', 'openai', 'codex', 'mistral'] as const,
        _default: 'claude',
      },
      model: {
        _description: 'Model identifier for orchestrator',
        _type: 'string',
        _default: 'claude-sonnet-4',
      },
      cli: {
        _description: 'Path to CLI executable',
        _type: 'string',
        _default: '',
      },
    },
    coder: {
      _description: 'AI settings for code generation',
      _type: 'object',
      provider: {
        _description: 'AI provider for coder',
        _type: 'string',
        _options: ['claude', 'gemini', 'openai', 'codex', 'mistral'] as const,
        _default: 'claude',
      },
      model: {
        _description: 'Model identifier for coder',
        _type: 'string',
        _default: 'claude-sonnet-4',
      },
      cli: {
        _description: 'Path to CLI executable',
        _type: 'string',
        _default: '',
      },
      skipExternalSetup: {
        _description: 'Auto-skip tasks marked as external/manual setup (Cloud SQL, etc.)',
        _type: 'boolean',
        _default: true,
      },
    },
    reviewer: {
      _description: 'AI settings for code review',
      _type: 'object',
      provider: {
        _description: 'AI provider for reviewer',
        _type: 'string',
        _options: ['claude', 'gemini', 'openai', 'codex', 'mistral'] as const,
        _default: 'claude',
      },
      model: {
        _description: 'Model identifier for reviewer',
        _type: 'string',
        _default: 'claude-sonnet-4',
      },
      cli: {
        _description: 'Path to CLI executable',
        _type: 'string',
        _default: '',
      },
    },
  },
  output: {
    _description: 'Output formatting options',
    _type: 'object',
    format: {
      _description: 'Default output format for CLI commands',
      _type: 'string',
      _options: ['table', 'json'] as const,
      _default: 'table',
    },
    colors: {
      _description: 'Enable colored output',
      _type: 'boolean',
      _default: true,
    },
    verbose: {
      _description: 'Show detailed output',
      _type: 'boolean',
      _default: false,
    },
  },
  git: {
    _description: 'Git workflow settings',
    _type: 'object',
    autoPush: {
      _description: 'Automatically push after task completion',
      _type: 'boolean',
      _default: true,
    },
    remote: {
      _description: 'Remote name for push operations',
      _type: 'string',
      _default: 'origin',
    },
    branch: {
      _description: 'Default branch name',
      _type: 'string',
      _default: 'main',
    },
    commitPrefix: {
      _description: 'Prefix for commit messages',
      _type: 'string',
      _default: '',
    },
    retryOnFailure: {
      _description: 'Retry push on temporary failure',
      _type: 'boolean',
      _default: true,
    },
  },
  runners: {
    _description: 'Runner daemon configuration',
    _type: 'object',
    heartbeatInterval: {
      _description: 'Interval between heartbeat updates',
      _type: 'string',
      _default: '30s',
    },
    staleTimeout: {
      _description: 'Time after which runner is considered stale',
      _type: 'string',
      _default: '5m',
    },
    subprocessHangTimeout: {
      _description: 'Kill subprocess if no output for this duration',
      _type: 'string',
      _default: '15m',
    },
    maxConcurrent: {
      _description: 'Maximum concurrent runners (global)',
      _type: 'number',
      _default: 5,
    },
    logRetention: {
      _description: 'How long to keep runner logs',
      _type: 'string',
      _default: '7d',
    },
    daemonLogs: {
      _description: 'Enable daemon stdout/stderr logging to disk',
      _type: 'boolean',
      _default: true,
    },
    parallel: {
      _description: 'Parallel execution settings',
      _type: 'object',
      enabled: {
        _description: 'Enable runners with independent workstreams',
        _type: 'boolean',
        _default: true,
      },
      maxClones: {
        _description: 'Maximum number of parallel workstreams (clone runners)',
        _type: 'number',
        _default: 5,
      },
      workspaceRoot: {
        _description: 'Optional path for parallel workspaces root',
        _type: 'string',
        _default: '',
      },
      hydrationCommand: {
        _description: 'Optional shell command to hydrate each workspace before runner start',
        _type: 'string',
        _default: '',
      },
      validationCommand: {
        _description: 'Optional shell command to validate integration workspace before push',
        _type: 'string',
        _default: '',
      },
      allowSharedMutableDependencies: {
        _description: 'Allow shared mutable dependency directories across parallel workspaces (unsafe)',
        _type: 'boolean',
        _default: false,
      },
      cleanupOnSuccess: {
        _description: 'Delete workspace clones after successful merge',
        _type: 'boolean',
        _default: true,
      },
      cleanupOnFailure: {
        _description: 'Preserve workspace clones after failures for debugging',
        _type: 'boolean',
        _default: false,
      },
    },
  },
  health: {
    _description: 'Health check configuration',
    _type: 'object',
    threshold: {
      _description: 'Minimum health score (0-100)',
      _type: 'number',
      _default: 80,
    },
    checks: {
      _description: 'Which checks to run',
      _type: 'object',
      git: {
        _description: 'Check for clean git working tree',
        _type: 'boolean',
        _default: true,
      },
      deps: {
        _description: 'Check dependencies are installed',
        _type: 'boolean',
        _default: true,
      },
      tests: {
        _description: 'Run tests as part of health check',
        _type: 'boolean',
        _default: true,
      },
      lint: {
        _description: 'Run linting as part of health check',
        _type: 'boolean',
        _default: true,
      },
    },
    sanitiseEnabled: {
      _description: 'Enable periodic project sanitise pass during wakeup',
      _type: 'boolean',
      _default: true,
    },
    sanitiseIntervalMinutes: {
      _description: 'Minutes between periodic sanitise passes per project',
      _type: 'number',
      _default: 5,
    },
    sanitiseInvocationTimeoutSec: {
      _description: 'Seconds before a running invocation is considered stale for sanitise checks',
      _type: 'number',
      _default: 1800,
    },
    orphanedTaskTimeout: {
      _description: 'Seconds before an in_progress task without an active runner is considered orphaned',
      _type: 'number',
      _default: 600,
    },
    maxCoderDuration: {
      _description: 'Seconds before an in_progress task with an active runner is treated as hanging (coder phase)',
      _type: 'number',
      _default: 1800,
    },
    maxReviewerDuration: {
      _description: 'Seconds before a review task with an active runner is treated as hanging (reviewer phase)',
      _type: 'number',
      _default: 900,
    },
    runnerHeartbeatTimeout: {
      _description: 'Seconds before a runner heartbeat is considered stale for stuck-task detection',
      _type: 'number',
      _default: 300,
    },
    invocationStaleness: {
      _description: 'Seconds since last task invocation to consider the task inactive (used for orphan checks)',
      _type: 'number',
      _default: 600,
    },
    autoRecover: {
      _description: 'Automatically attempt recovery actions for detected stuck tasks during wakeup',
      _type: 'boolean',
      _default: true,
    },
    maxRecoveryAttempts: {
      _description: 'Maximum recovery attempts per task before escalating by skipping it',
      _type: 'number',
      _default: 3,
    },
    maxIncidentsPerHour: {
      _description: 'Safety limit: stop auto-recovery if too many incidents occur in one hour',
      _type: 'number',
      _default: 10,
    },
  },
  locking: {
    _description: 'Task and section locking settings',
    _type: 'object',
    taskTimeout: {
      _description: 'Maximum time a task can be locked',
      _type: 'string',
      _default: '60m',
    },
    sectionTimeout: {
      _description: 'Maximum time a section can be locked',
      _type: 'string',
      _default: '120m',
    },
    waitTimeout: {
      _description: 'How long to wait for a lock before failing',
      _type: 'string',
      _default: '30m',
    },
    pollInterval: {
      _description: 'How often to check for lock availability',
      _type: 'string',
      _default: '5s',
    },
  },
  database: {
    _description: 'Database settings',
    _type: 'object',
    autoMigrate: {
      _description: 'Automatically run migrations on startup',
      _type: 'boolean',
      _default: true,
    },
    backupBeforeMigrate: {
      _description: 'Create backup before running migrations',
      _type: 'boolean',
      _default: true,
    },
  },
  logs: {
    _description: 'Logging configuration',
    _type: 'object',
    retention: {
      _description: 'How long to keep log files',
      _type: 'string',
      _default: '30d',
    },
    keepLogs: {
      _description: 'Whether to persist logs to disk',
      _type: 'boolean',
      _default: true,
    },
    level: {
      _description: 'Minimum log level to record',
      _type: 'string',
      _options: ['debug', 'info', 'warn', 'error'] as const,
      _default: 'info',
    },
  },
  disputes: {
    _description: 'Dispute handling settings',
    _type: 'object',
    timeoutDays: {
      _description: 'Days before stale dispute auto-resolution',
      _type: 'number',
      _default: 7,
    },
    autoCreateOnMaxRejections: {
      _description: 'Auto-create dispute when task hits 15 rejections',
      _type: 'boolean',
      _default: false,
    },
    majorBlocksLoop: {
      _description: 'Whether major disputes block the loop',
      _type: 'boolean',
      _default: false,
    },
  },
  projects: {
    _description: 'Project scanning settings',
    _type: 'object',
    scanPaths: {
      _description: 'Directories to scan for projects',
      _type: 'array',
      _default: ['~/Projects'],
    },
    excludePatterns: {
      _description: 'Patterns to exclude from scanning',
      _type: 'array',
      _default: ['node_modules', '.git'],
    },
    allowedPaths: {
      _description: 'Whitelist: only allow project registration from these directories (prefix match). Empty = allow all.',
      _type: 'array',
      _default: [],
    },
    blockedPaths: {
      _description: 'Blacklist: block project registration from these directories (prefix match). Empty = block none.',
      _type: 'array',
      _default: [],
    },
  },
  backup: {
    _description: 'Backup configuration',
    _type: 'object',
    enabled: {
      _description: 'Enable automatic backups',
      _type: 'boolean',
      _default: true,
    },
    retention: {
      _description: 'How long to keep backups',
      _type: 'string',
      _default: '7d',
    },
    includeConfig: {
      _description: 'Include config files in backup',
      _type: 'boolean',
      _default: true,
    },
    includeLogs: {
      _description: 'Include log files in backup',
      _type: 'boolean',
      _default: false,
    },
  },
  build: {
    _description: 'Build settings',
    _type: 'object',
    timeout: {
      _description: 'Maximum time for build commands',
      _type: 'string',
      _default: '5m',
    },
  },
  test: {
    _description: 'Test settings',
    _type: 'object',
    timeout: {
      _description: 'Maximum time for test commands',
      _type: 'string',
      _default: '10m',
    },
  },
  webui: {
    _description: 'Web UI settings',
    _type: 'object',
    port: {
      _description: 'Port for web server',
      _type: 'number',
      _default: 3000,
    },
    host: {
      _description: 'Host to bind to',
      _type: 'string',
      _default: 'localhost',
    },
    auth: {
      _description: 'Enable authentication',
      _type: 'boolean',
      _default: false,
    },
  },
  quality: {
    _description: 'Code quality requirements',
    _type: 'object',
    tests: {
      _description: 'Test coverage settings',
      _type: 'object',
      required: {
        _description: 'Whether to require tests for new code',
        _type: 'boolean',
        _default: false,
      },
      minCoverage: {
        _description: 'Minimum test coverage percentage (0-100)',
        _type: 'number',
      },
    },
  },
  sections: {
    _description: 'Section processing settings',
    _type: 'object',
    batchMode: {
      _description: 'Process all pending tasks in a section as one batch',
      _type: 'boolean',
      _default: false,
    },
    maxBatchSize: {
      _description: 'Maximum tasks to batch together (prevents context overflow)',
      _type: 'number',
      _default: 10,
    },
  },
  hooks: {
    _description: 'Event hooks for automation (scripts and webhooks)',
    _type: 'array',
    _default: [],
  },
};

/**
 * Check if a schema node is a leaf field (has _type but no child config keys)
 */
export function isSchemaField(node: SchemaField | SchemaObject): node is SchemaField {
  if (!('_type' in node)) return false;
  // If it has any non-underscore keys, it's a container object, not a leaf field
  const nonMetaKeys = Object.keys(node).filter((k) => !k.startsWith('_'));
  return nonMetaKeys.length === 0;
}

/**
 * Get schema for a config path
 */
export function getSchemaForPath(path: string): SchemaField | SchemaObject | null {
  const parts = path.split('.');
  let current: SchemaField | SchemaObject | undefined = CONFIG_SCHEMA;

  for (const part of parts) {
    if (!current) {
      return null;
    }
    // Skip fields that are metadata
    if (part.startsWith('_')) {
      return null;
    }
    // Navigate into the object
    current = (current as SchemaObject)[part];
  }

  return current ?? null;
}

/**
 * Get all top-level config categories
 */
export function getCategories(): string[] {
  return Object.keys(CONFIG_SCHEMA);
}

/**
 * Get description for a category
 */
export function getCategoryDescription(category: string): string {
  const schema = CONFIG_SCHEMA[category];
  if (schema && isSchemaField(schema)) {
    return schema._description;
  }
  if (schema && '_description' in schema) {
    return (schema as unknown as { _description: string })._description;
  }
  return '';
}
