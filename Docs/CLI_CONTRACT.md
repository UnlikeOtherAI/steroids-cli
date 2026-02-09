# CLI Contract

> The cross-cutting contract that ALL commands must follow

---

## Overview

This document defines the standardized interface that every Steroids CLI command must implement. This ensures consistency, predictability, and automation-friendliness across the entire CLI surface.

## Global Flags

These flags work on **every** command:

| Flag | Short | Description | Example |
|------|-------|-------------|---------|
| `--help` | `-h` | Show help for the command | `steroids tasks --help` |
| `--version` | | Show version (root only) | `steroids --version` |
| `--json` | `-j` | Output as JSON | `steroids tasks list --json` |
| `--quiet` | `-q` | Minimal output | `steroids loop --quiet` |
| `--verbose` | `-v` | Detailed output | `steroids init --verbose` |
| `--no-color` | | Disable colored output | `steroids tasks --no-color` |
| `--config <path>` | | Custom config file | `steroids tasks --config ~/my.yaml` |
| `--dry-run` | | Preview without executing | `steroids gc --dry-run` |
| `--timeout <dur>` | | Command timeout | `steroids loop --timeout 30m` |
| `--no-hooks` | | Skip hook execution | `steroids tasks update --no-hooks` |
| `--no-wait` | | Don't wait for locks | `steroids tasks list --no-wait` |

### Combined Flags

Short flags can be combined:
```bash
steroids tasks -jqv      # JSON + quiet + verbose
steroids tasks -jv       # JSON + verbose
```

## JSON Output Envelope

When `--json` is used, all commands output a standard envelope:

### Success Format

```json
{
  "success": true,
  "command": "tasks",
  "subcommand": "list",
  "data": {
    "tasks": [...],
    "total": 5
  },
  "error": null
}
```

### Error Format

```json
{
  "success": false,
  "command": "tasks",
  "subcommand": "update",
  "data": null,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task not found: abc123",
    "details": {
      "taskId": "abc123"
    }
  }
}
```

## Error Codes

Machine-readable error codes for automation:

| Error Code | Exit Code | Description |
|------------|-----------|-------------|
| `SUCCESS` | 0 | Operation completed successfully |
| `GENERAL_ERROR` | 1 | Unspecified error |
| `INVALID_ARGUMENTS` | 2 | Bad command arguments |
| `CONFIG_ERROR` | 3 | Configuration problem |
| `NOT_FOUND` | 4 | Resource not found |
| `PERMISSION_DENIED` | 5 | Access denied |
| `RESOURCE_LOCKED` | 6 | Lock held by another process |
| `HEALTH_FAILED` | 7 | Health check failed |
| `TASK_NOT_FOUND` | 4 | Task doesn't exist |
| `SECTION_NOT_FOUND` | 4 | Section doesn't exist |
| `TASK_LOCKED` | 6 | Task locked by runner |
| `NOT_INITIALIZED` | 3 | Steroids not initialized |
| `MIGRATION_REQUIRED` | 3 | Database needs migration |
| `HOOK_FAILED` | 1 | Hook execution failed |
| `VALIDATION_ERROR` | 2 | Validation failed |
| `INTERNAL_ERROR` | 1 | Internal error |

### Error Code Usage

```typescript
import { CliError, ErrorCode } from './cli/errors.js';

throw new CliError(
  ErrorCode.TASK_NOT_FOUND,
  `Task not found: ${taskId}`,
  { taskId }
);
```

## Environment Variables

Environment variables provide defaults that CLI flags override:

| Variable | Maps To | Values | Example |
|----------|---------|--------|---------|
| `STEROIDS_CONFIG` | `--config` | Path | `~/.steroids/config.yaml` |
| `STEROIDS_JSON` | `--json` | `1`, `true` | `STEROIDS_JSON=1` |
| `STEROIDS_QUIET` | `--quiet` | `1`, `true` | `STEROIDS_QUIET=1` |
| `STEROIDS_VERBOSE` | `--verbose` | `1`, `true` | `STEROIDS_VERBOSE=1` |
| `STEROIDS_NO_HOOKS` | `--no-hooks` | `1`, `true` | `STEROIDS_NO_HOOKS=1` |
| `STEROIDS_NO_COLOR` | `--no-color` | `1`, `true` | `STEROIDS_NO_COLOR=1` |
| `STEROIDS_NO_WAIT` | `--no-wait` | `1`, `true` | `STEROIDS_NO_WAIT=1` |
| `STEROIDS_AUTO_MIGRATE` | auto-migrate | `1`, `true` | `STEROIDS_AUTO_MIGRATE=1` |
| `STEROIDS_TIMEOUT` | `--timeout` | Duration | `STEROIDS_TIMEOUT=30s` |
| `NO_COLOR` | `--no-color` | Any value | `NO_COLOR=1` |
| `CI` | non-interactive | Any value | `CI=true` |

### Environment Variable Priority

```
CLI flags > Environment variables > Config file > Defaults
```

## Interactive Detection

The CLI detects whether it's running in an interactive terminal:

```typescript
import { isInteractive, requireInteractive } from './cli/interactive.js';

if (!isInteractive()) {
  console.warn('Running in non-interactive mode');
}

// For operations that REQUIRE interaction:
requireInteractive('Cannot prompt for migration confirmation');
```

### CI Detection

Automatically detects CI environments:
- `CI` environment variable
- `GITHUB_ACTIONS`
- `GITLAB_CI`
- `CIRCLECI`
- `TRAVIS`
- `JENKINS_URL`

## Help System

Every command must provide comprehensive help via `--help`:

### Required Sections

- **USAGE** - How to invoke the command
- **DESCRIPTION** - What the command does (optional but recommended)
- **SUBCOMMANDS** - Available subcommands (if applicable)
- **OPTIONS** - Command-specific options
- **GLOBAL OPTIONS** - Standard global flags
- **EXAMPLES** - Real-world usage examples
- **RELATED COMMANDS** - Cross-references (optional)
- **ENVIRONMENT VARIABLES** - Relevant env vars
- **EXIT CODES** - Exit code meanings

### Example Help Implementation

```typescript
import { generateHelp } from './cli/help.js';

const HELP = generateHelp({
  command: 'tasks',
  description: 'Manage tasks in the automated development workflow',
  details: `Tasks are units of work that flow through the coder/reviewer loop.
Each task has a specification file and tracks progress through various states.`,
  usage: [
    'steroids tasks [options]',
    'steroids tasks <subcommand> [args] [options]',
  ],
  subcommands: [
    { name: 'list', description: 'List tasks (default)' },
    { name: 'add', args: '<title>', description: 'Add a new task' },
  ],
  options: [
    { short: 's', long: 'status', description: 'Filter by status', values: 'pending | all' },
  ],
  examples: [
    { command: 'steroids tasks', description: 'List pending tasks' },
    { command: 'steroids tasks --status all --json', description: 'All tasks as JSON' },
  ],
  related: [
    { command: 'steroids sections', description: 'Manage task sections' },
  ],
});
```

## Command Implementation Template

```typescript
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { CliError, ErrorCode } from '../cli/errors.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'mycommand',
  description: 'Short description',
  // ... help config
});

export async function myCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Create output helper
  const output = createOutput({
    command: 'mycommand',
    subcommand: args[0] || null,
    flags,
  });

  // Handle --help
  if (flags.help) {
    console.log(HELP);
    return;
  }

  try {
    // Parse command-specific args
    const parsed = parseArgs({
      args,
      options: {
        // Command-specific options
      },
      allowPositionals: true,
    });

    // Do work
    const result = await doWork(parsed);

    // Output results
    if (flags.json) {
      output.success(result);
    } else {
      output.log('Operation completed successfully');
    }
  } catch (error) {
    if (error instanceof CliError) {
      if (flags.json) {
        output.error(error.code, error.message, error.details);
      } else {
        console.error(`Error: ${error.message}`);
      }
      process.exit(error.exitCode);
    }
    throw error;
  }
}
```

## Testing

The CLI contract is validated by `scripts/test-cli-contract.sh`:

```bash
# Run all contract tests
./scripts/test-cli-contract.sh

# Tests verify:
# - Global flags work on all commands
# - JSON output follows envelope format
# - Exit codes are semantic
# - Environment variables work
# - Help is comprehensive
# - Interactive detection works
# - Color output can be disabled
```

## Implementation Files

| File | Purpose |
|------|---------|
| `src/cli/flags.ts` | Global flags parser |
| `src/cli/output.ts` | JSON envelope and output helpers |
| `src/cli/errors.ts` | Error codes and CliError class |
| `src/cli/env.ts` | Environment variable support |
| `src/cli/interactive.ts` | Interactive mode detection |
| `src/cli/colors.ts` | Colored output with NO_COLOR support |
| `src/cli/help.ts` | Help system templates |
| `src/cli/index.ts` | Barrel export |

## Best Practices

### 1. Always Use Output Helper

```typescript
const output = createOutput({ command: 'tasks', subcommand: 'list', flags });

// GOOD
output.success(data);
output.error(ErrorCode.NOT_FOUND, 'Not found');
output.log('Processing...');
output.verbose('Detail: xyz');

// BAD
console.log(JSON.stringify(data));  // Doesn't respect flags
console.error('Error');              // No JSON support
```

### 2. Throw CliError for Expected Errors

```typescript
// GOOD
throw new CliError(
  ErrorCode.TASK_NOT_FOUND,
  `Task not found: ${id}`,
  { taskId: id }
);

// BAD
throw new Error('Task not found');  // No error code or exit code
```

### 3. Respect Quiet and Verbose Modes

```typescript
// Show in normal and verbose mode
output.log('Processing tasks...');

// Show only in verbose mode
output.verbose('Found 5 pending tasks');

// Always show warnings (unless quiet)
output.warn('Database migration recommended');
```

### 4. Provide Helpful Examples

Every command should have 3-5 practical examples showing:
- Basic usage
- Common flags (`--json`, `--verbose`)
- Complex scenarios
- Environment variable usage

### 5. Cross-Reference Related Commands

Help users discover related functionality:
```typescript
related: [
  { command: 'steroids sections', description: 'Manage task sections' },
  { command: 'steroids loop', description: 'Run automation' },
],
```

## Validation Checklist

Before merging command changes, verify:

- [x] Global flags work (`--json`, `--quiet`, `--verbose`, `--no-color`)
- [x] `--help` shows comprehensive documentation
- [x] JSON output uses the standard envelope
- [x] Errors use CliError with semantic error codes
- [x] Exit codes match error codes
- [x] Environment variables work
- [x] Examples are practical and tested
- [x] Help includes all required sections
- [x] Command is listed in main help (`src/index.ts`)
- [x] Test script passes: `./scripts/test-cli-contract.sh`
