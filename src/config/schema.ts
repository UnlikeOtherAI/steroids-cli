/**
 * Configuration schema with descriptions, options, and defaults
 */

import { PROVIDER_NAMES } from './provider-names.js';

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
  intake: {
    _description: 'External bug intake connector settings',
    _type: 'object',
    enabled: {
      _description: 'Enable external bug intake polling and sync',
      _type: 'boolean',
      _default: false,
    },
    pollIntervalMinutes: {
      _description: 'Minutes between intake polls',
      _type: 'number',
      _default: 15,
    },
    maxReportsPerPoll: {
      _description: 'Maximum normalized reports to process per poll',
      _type: 'number',
      _default: 50,
    },
    connectors: {
      _description: 'Connector-specific intake configuration',
      _type: 'object',
      sentry: {
        _description: 'Sentry bug intake settings',
        _type: 'object',
        enabled: {
          _description: 'Enable the Sentry intake connector',
          _type: 'boolean',
          _default: false,
        },
        baseUrl: {
          _description: 'Sentry API base URL',
          _type: 'string',
          _default: 'https://sentry.io',
        },
        organization: {
          _description: 'Sentry organization slug',
          _type: 'string',
          _default: '',
        },
        project: {
          _description: 'Sentry project slug',
          _type: 'string',
          _default: '',
        },
        authTokenEnvVar: {
          _description: 'Environment variable that stores the Sentry auth token',
          _type: 'string',
          _default: 'SENTRY_AUTH_TOKEN',
        },
        webhookSecretEnvVar: {
          _description: 'Environment variable that stores the Sentry webhook signing secret',
          _type: 'string',
          _default: 'SENTRY_WEBHOOK_SECRET',
        },
        defaultAssignee: {
          _description: 'Optional default assignee for created Sentry issues',
          _type: 'string',
          _default: '',
        },
      },
      github: {
        _description: 'GitHub Issues intake settings',
        _type: 'object',
        enabled: {
          _description: 'Enable the GitHub Issues intake connector',
          _type: 'boolean',
          _default: false,
        },
        apiBaseUrl: {
          _description: 'GitHub API base URL',
          _type: 'string',
          _default: 'https://api.github.com',
        },
        owner: {
          _description: 'GitHub repository owner',
          _type: 'string',
          _default: '',
        },
        repo: {
          _description: 'GitHub repository name',
          _type: 'string',
          _default: '',
        },
        tokenEnvVar: {
          _description: 'Environment variable that stores the GitHub token',
          _type: 'string',
          _default: 'GITHUB_TOKEN',
        },
        webhookSecretEnvVar: {
          _description: 'Environment variable that stores the GitHub webhook signing secret',
          _type: 'string',
          _default: 'GITHUB_WEBHOOK_SECRET',
        },
        labels: {
          _description: 'Labels required when scanning or creating GitHub issues',
          _type: 'array',
          _default: [],
        },
      },
    },
  },
  ai: {
    _description: 'AI provider configuration',
    _type: 'object',
    orchestrator: {
      _description: 'AI settings for orchestration decisions',
      _type: 'object',
      provider: {
        _description: 'AI provider for orchestrator',
        _type: 'string',
        _options: PROVIDER_NAMES,
        _default: 'claude',
      },
      model: {
        _description: 'Model identifier for orchestrator',
        _type: 'string',
        _default: 'claude-sonnet-4-6',
      },
    },
    coder: {
      _description: 'AI settings for code generation',
      _type: 'object',
      provider: {
        _description: 'AI provider for coder',
        _type: 'string',
        _options: PROVIDER_NAMES,
        _default: 'claude',
      },
      model: {
        _description: 'Model identifier for coder',
        _type: 'string',
        _default: 'claude-sonnet-4-6',
      },
    },
    reviewer: {
      _description: 'AI settings for code review',
      _type: 'object',
      provider: {
        _description: 'AI provider for reviewer',
        _type: 'string',
        _options: PROVIDER_NAMES,
        _default: 'claude',
      },
      model: {
        _description: 'Model identifier for reviewer',
        _type: 'string',
        _default: 'claude-sonnet-4-6',
      },
      customInstructions: {
        _description: 'Extra reviewer-specific instructions appended to reviewer prompts',
        _type: 'string',
      },
    },
    reviewers: {
      _description: 'Multiple independent AI reviewers (all must approve)',
      _type: 'array',
      _default: [],
    },
  },
  git: {
    _description: 'Git workflow settings',
    _type: 'object',
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
    prAssignees: {
      _description: 'Optional GitHub logins to assign when auto-creating section PRs',
      _type: 'array',
      _default: [],
    },
    prReviewers: {
      _description: 'Optional GitHub logins or teams to request review from when auto-creating section PRs',
      _type: 'array',
      _default: [],
    },
  },
  runners: {
    _description: 'Runner daemon configuration',
    _type: 'object',
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
    },
  },
  health: {
    _description: 'Health check configuration',
    _type: 'object',
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
    maxInvocationsPerTask: {
      _description: 'Maximum total provider invocations (coder+reviewer) per task before auto-skipping. Prevents runaway loops from burning API quota.',
      _type: 'number',
      _default: 50,
    },
    maxIncidentsPerHour: {
      _description: 'Safety limit: stop auto-recovery if too many incidents occur in one hour',
      _type: 'number',
      _default: 10,
    },
  },
  projects: {
    _description: 'Project scanning settings',
    _type: 'object',
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
  followUpTasks: {
    _description: 'Follow-up task generation settings',
    _type: 'object',
    autoImplementDepth1: {
      _description: 'Automatically implement the first round of follow-up tasks (depth 1)',
      _type: 'boolean',
      _default: true,
    },
    maxDepth: {
      _description: 'Maximum chain depth for follow-up tasks',
      _type: 'number',
      _default: 2,
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
