# CLI Contract

> **Status:** ✅ Complete
>
> Defines the cross-cutting contract that ALL Steroids CLI commands follow.

---

## Overview

This document defines the contract that ensures consistency across all Steroids CLI commands:
- Global flags that work on every command
- JSON output envelope for machine-readable responses
- Semantic exit codes for shell scripting
- Environment variable overrides
- Error handling and reporting
- Help system conventions

---

## Global Flags

These flags work on **every** command and are parsed before command-specific options:

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| `--help` | `-h` | boolean | Show command help |
| `--version` | | boolean | Show CLI version |
| `--json` | `-j` | boolean | Output as JSON |
| `--quiet` | `-q` | boolean | Minimal output |
| `--verbose` | `-v` | boolean | Detailed output |
| `--no-color` | | boolean | Disable colored output |
| `--config <path>` | | string | Custom config file path |
| `--dry-run` | | boolean | Preview without executing |
| `--timeout <duration>` | | string | Command timeout (e.g., 30s, 5m, 1h) |
| `--no-hooks` | | boolean | Skip hook execution |
| `--no-wait` | | boolean | Don't wait for locks |

### Flag Combinations

Short flags can be combined:
```bash
steroids tasks -jqv list    # --json --quiet --verbose (verbose wins)
```

Conflicting flags:
- `--quiet` and `--verbose` are mutually exclusive (error)
- Last one wins for other conflicts

---

## JSON Output Envelope

When `--json` flag is set, ALL commands must output a standard JSON envelope:

### Success Envelope

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

### Error Envelope

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

### Implementation

Commands should use the `Output` helper:

```typescript
import { createOutput } from '../cli/output.js';

export async function myCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'mycommand', subcommand: 'sub', flags });

  // For JSON or regular output
  if (out.isJson()) {
    out.success({ result: 'data' });
  } else {
    out.log('Success!');
  }
}
```

---

## Error Codes

All errors use semantic error codes that map to exit codes:

| Error Code | Exit Code | Description |
|------------|-----------|-------------|
| `SUCCESS` | 0 | Operation completed |
| `GENERAL_ERROR` | 1 | Unspecified error |
| `INVALID_ARGUMENTS` | 2 | Bad command arguments |
| `CONFIG_ERROR` | 3 | Configuration problem |
| `NOT_FOUND` | 4 | Resource not found |
| `PERMISSION_DENIED` | 5 | Access denied |
| `RESOURCE_LOCKED` | 6 | Lock held by another |
| `HEALTH_FAILED` | 7 | Health check failed |
| `TASK_NOT_FOUND` | 4 | Task doesn't exist |
| `SECTION_NOT_FOUND` | 4 | Section doesn't exist |
| `TASK_LOCKED` | 6 | Task locked by runner |
| `NOT_INITIALIZED` | 3 | Steroids not initialized |
| `MIGRATION_REQUIRED` | 3 | Database needs migration |
| `HOOK_FAILED` | 1 | Hook execution failed |

### Usage in Commands

```typescript
import { CliError, ErrorCode } from '../cli/errors.js';

throw new CliError(
  ErrorCode.TASK_NOT_FOUND,
  `Task not found: ${taskId}`,
  { taskId }
);
```

### Exit Code Behavior

The CLI main handler automatically:
1. Catches `CliError` instances
2. Outputs error in JSON or human format based on `--json` flag
3. Exits with the appropriate exit code

Commands should **throw errors** rather than calling `process.exit()` directly.

---

## Environment Variables

Environment variables provide defaults that can be overridden by CLI flags:

| Variable | Maps To | Values | Description |
|----------|---------|--------|-------------|
| `STEROIDS_CONFIG` | `--config` | Path | Custom config path |
| `STEROIDS_JSON` | `--json` | `1`, `true` | Output as JSON |
| `STEROIDS_QUIET` | `--quiet` | `1`, `true` | Minimal output |
| `STEROIDS_VERBOSE` | `--verbose` | `1`, `true` | Detailed output |
| `STEROIDS_NO_HOOKS` | `--no-hooks` | `1`, `true` | Skip hooks |
| `STEROIDS_NO_COLOR` | `--no-color` | `1`, `true` | Disable colors |
| `STEROIDS_NO_WAIT` | `--no-wait` | `1`, `true` | Don't wait for locks |
| `STEROIDS_AUTO_MIGRATE` | auto-migrate | `1`, `true` | Auto-migrate database |
| `STEROIDS_TIMEOUT` | `--timeout` | Duration | Command timeout |
| `NO_COLOR` | `--no-color` | Any value | Standard no-color.org variable |
| `CI` | detected | Any value | CI environment detection |

### Precedence

1. CLI flags (highest priority)
2. Environment variables
3. Config file
4. Defaults (lowest priority)

### Example Usage

```bash
# Use env var as default
export STEROIDS_JSON=1
steroids tasks list              # Outputs JSON

# Override with flag
steroids tasks list --no-json    # Outputs text (if we add such flag)

# CI detection
CI=1 steroids loop               # Non-interactive mode
```

---

## Interactive Detection

The CLI automatically detects whether it's running in an interactive terminal:

```typescript
import { isInteractive, requireInteractive } from '../cli/interactive.js';

if (!isInteractive()) {
  throw new CliError(
    ErrorCode.INVALID_ARGUMENTS,
    'This command requires interactive mode or explicit flags.'
  );
}
```

Interactive mode requires:
- `stdin` is a TTY
- `stdout` is a TTY
- Not running in CI environment

CI is detected by checking for environment variables:
- `CI`
- `GITHUB_ACTIONS`
- `GITLAB_CI`
- `CIRCLECI`
- `TRAVIS`
- `JENKINS_URL`

---

## Colored Output

Colors are automatically disabled when:
- `NO_COLOR` environment variable is set (any value)
- `STEROIDS_NO_COLOR` is set to `1` or `true`
- `stdout` is not a TTY
- `--no-color` flag is used

### Usage

```typescript
import { colors, markers } from '../cli/colors.js';

console.log(colors.green('Success!'));
console.log(markers.success('Task completed'));
console.log(markers.error('Task failed'));
```

Colors follow the [no-color.org](https://no-color.org/) standard.

---

## Help System

Every command must provide comprehensive help text:

### Help Text Structure

```
<command> - <one-line description>

USAGE:
  steroids <command> [options]
  steroids <command> <subcommand> [options]

DESCRIPTION:
  <detailed multi-line description>

SUBCOMMANDS:
  <name> <args>    <description>

OPTIONS:
  -x, --example    <description>

GLOBAL OPTIONS:
  <list of global flags>

EXAMPLES:
  steroids <command>                # <description>
  steroids <command> --flag value   # <description>

RELATED COMMANDS:
  steroids <other>    <description>

ENVIRONMENT VARIABLES:
  <list of relevant env vars>

EXIT CODES:
  0  Success
  1  Error
  ...
```

### Using the Help Template

```typescript
import { generateHelp, type HelpTemplate } from '../cli/help.js';

const HELP = generateHelp({
  command: 'mycommand',
  description: 'Do something useful',
  usage: [
    'steroids mycommand [options]',
    'steroids mycommand <subcommand> [options]',
  ],
  details: 'Longer description explaining what this command does...',
  subcommands: [
    { name: 'sub1', description: 'First subcommand' },
    { name: 'sub2', args: '<id>', description: 'Second subcommand' },
  ],
  options: [
    { short: 's', long: 'status', description: 'Filter by status', values: 'pending|completed' },
  ],
  examples: [
    { command: 'steroids mycommand', description: 'Basic usage' },
    { command: 'steroids mycommand --status pending', description: 'With filter' },
  ],
  related: [
    { command: 'steroids other', description: 'Related command' },
  ],
});
```

### Quick Help

For simple commands without subcommands:

```typescript
import { quickHelp } from '../cli/help.js';

const HELP = quickHelp(
  'simple',
  'Do a simple thing',
  [
    { short: 'f', long: 'force', description: 'Force operation' },
  ],
  [
    { command: 'steroids simple', description: 'Run it' },
  ]
);
```

---

## Command Implementation Template

All commands should follow this structure:

```typescript
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { CliError, ErrorCode } from '../cli/errors.js';
import { parseArgs } from 'node:util';

const HELP = `
steroids mycommand - Brief description

USAGE:
  steroids mycommand [options]

OPTIONS:
  -x, --example    Description

EXAMPLES:
  steroids mycommand               # Basic
  steroids mycommand --example     # With option
`;

export async function myCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Create output helper
  const out = createOutput({ command: 'mycommand', flags });

  // Parse command-specific args
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      example: { type: 'boolean', short: 'x', default: false },
    },
    allowPositionals: true,
  });

  // Handle help
  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  // Validate arguments
  if (someInvalidCondition) {
    throw new CliError(
      ErrorCode.INVALID_ARGUMENTS,
      'Invalid argument: reason'
    );
  }

  // Execute command logic
  try {
    const result = await doSomething();

    // Output result
    if (out.isJson()) {
      out.success({ result });
    } else {
      out.log(`Success: ${result}`);
    }
  } catch (error) {
    // Re-throw as CliError for proper handling
    if (error instanceof Error) {
      throw new CliError(
        ErrorCode.GENERAL_ERROR,
        error.message
      );
    }
    throw error;
  }
}
```

---

## Testing the Contract

### Manual Testing

```bash
# Test global flags
steroids tasks --help
steroids tasks --json list
steroids tasks --quiet list
steroids tasks --verbose list
steroids tasks --dry-run update abc123 --status completed

# Test environment variables
export STEROIDS_JSON=1
steroids tasks list

# Test exit codes
steroids tasks update nonexistent --status completed
echo $?  # Should be 4 (NOT_FOUND)

# Test CI detection
CI=1 steroids loop  # Should run non-interactively

# Test colors
steroids tasks list
NO_COLOR=1 steroids tasks list  # No colors
```

### Automated Testing

Test each command's contract compliance:
- Global flags work correctly
- JSON output follows envelope format
- Exit codes are semantic
- Help text is comprehensive
- Environment variables are respected

---

## Checklist for New Commands

When adding a new command, ensure:

- [ ] Command accepts `GlobalFlags` parameter
- [ ] Help text follows the template structure
- [ ] `--help` flag displays help and exits
- [ ] `--json` flag outputs JSON envelope
- [ ] `--quiet` and `--verbose` control output verbosity
- [ ] `--dry-run` previews without executing (if applicable)
- [ ] Errors use `CliError` with semantic error codes
- [ ] Exit codes match error codes
- [ ] Examples are included in help text
- [ ] Related commands are cross-referenced
- [ ] Environment variables are documented (if any)

---

## Summary

The CLI contract ensures:
1. **Consistency** - All commands behave the same way
2. **Scriptability** - JSON output and exit codes for automation
3. **Usability** - Comprehensive help, colors, verbosity control
4. **Debuggability** - Verbose mode, error details, semantic codes
5. **Flexibility** - Environment variables, config files, flags

Commands that follow this contract are:
- Easy to learn (consistent interface)
- Easy to script (JSON + exit codes)
- Easy to debug (verbose output, error codes)
- CI/CD friendly (non-interactive mode, env vars)
