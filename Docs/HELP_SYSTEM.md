# Comprehensive Help System

> Status: ✅ COMPLETE
>
> Implemented in Phase 0.5: CLI Contract

---

## Overview

The Steroids CLI implements a comprehensive help system with:
- **Global flags** that work on every command
- **JSON output** with standardized envelope format
- **Semantic exit codes** for shell scripting
- **Environment variable** support
- **Comprehensive help text** with examples and cross-references

---

## Global Flags

These flags work on **every** command:

| Flag | Short | Description | Values |
|------|-------|-------------|--------|
| `--help` | `-h` | Show help text | - |
| `--version` | - | Show version | - |
| `--json` | `-j` | Output as JSON | - |
| `--quiet` | `-q` | Minimal output | - |
| `--verbose` | `-v` | Detailed output | - |
| `--no-color` | - | Disable colors | - |
| `--config` | - | Custom config path | `<path>` |
| `--dry-run` | - | Preview without executing | - |
| `--timeout` | - | Command timeout | `<duration>` |
| `--no-hooks` | - | Skip hook execution | - |
| `--no-wait` | - | Don't wait for locks | - |

**Combined short flags:** You can combine short flags like `-jv` for `--json --verbose`.

---

## Environment Variables

Environment variables provide defaults that can be overridden by CLI flags:

| Variable | Maps To | Values | Example |
|----------|---------|--------|---------|
| `STEROIDS_CONFIG` | `--config` | Path | `/path/to/config` |
| `STEROIDS_JSON` | `--json` | `1`, `true` | `STEROIDS_JSON=1` |
| `STEROIDS_QUIET` | `--quiet` | `1`, `true` | `STEROIDS_QUIET=1` |
| `STEROIDS_VERBOSE` | `--verbose` | `1`, `true` | `STEROIDS_VERBOSE=1` |
| `STEROIDS_NO_HOOKS` | `--no-hooks` | `1`, `true` | `STEROIDS_NO_HOOKS=1` |
| `STEROIDS_NO_COLOR` | `--no-color` | `1`, `true` | `STEROIDS_NO_COLOR=1` |
| `STEROIDS_NO_WAIT` | `--no-wait` | `1`, `true` | `STEROIDS_NO_WAIT=1` |
| `STEROIDS_AUTO_MIGRATE` | auto-migrate | `1`, `true` | `STEROIDS_AUTO_MIGRATE=1` |
| `STEROIDS_TIMEOUT` | `--timeout` | Duration | `STEROIDS_TIMEOUT=30s` |
| `NO_COLOR` | `--no-color` | Any value | `NO_COLOR=1` |
| `CI` | detected | Any value | Set by CI systems |

**Precedence:** CLI flags > Environment variables > Defaults

---

## JSON Output Envelope

When `--json` is specified (or `STEROIDS_JSON=1`), all commands output a standardized JSON envelope:

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

---

## Error Codes and Exit Codes

The CLI uses semantic error codes that map to appropriate Unix exit codes:

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
| `VALIDATION_ERROR` | 2 | Validation failed |
| `INTERNAL_ERROR` | 1 | Internal error |
| `NOT_IMPLEMENTED` | 1 | Feature not implemented |

### Shell Scripting Example

```bash
#!/bin/bash
# Exit codes enable robust shell scripting

steroids tasks update abc123 --status completed
EXIT_CODE=$?

case $EXIT_CODE in
  0)
    echo "Task updated successfully"
    ;;
  2)
    echo "Invalid arguments provided"
    exit 1
    ;;
  3)
    echo "Not initialized - run: steroids init"
    exit 1
    ;;
  4)
    echo "Task not found"
    exit 1
    ;;
  6)
    echo "Task is locked - try again later"
    exit 1
    ;;
  *)
    echo "Unexpected error: $EXIT_CODE"
    exit 1
    ;;
esac
```

---

## Help Text Format

Every command follows a consistent help format:

```
steroids <command> - Short description

USAGE:
  steroids <command> [options]

DESCRIPTION:
  Detailed multi-line description explaining what the command does,
  when to use it, and how it fits into the overall workflow.

SUBCOMMANDS:
  list                List items (default)
  add <name>          Add a new item

OPTIONS:
  -s, --status        Filter by status
                    Values: pending | completed
                    Default: pending

GLOBAL OPTIONS:
  -h, --help          Show help
  --json              Output as JSON
  [... all global flags ...]

EXAMPLES:
  steroids command                    # Basic usage
  steroids command --flag value       # With option
  steroids command --json             # Machine output

RELATED COMMANDS:
  steroids other-cmd    Related command description

ENVIRONMENT VARIABLES:
  STEROIDS_JSON          Output as JSON (--json)
  [... all env vars ...]

EXIT CODES:
  0  Success
  1  General error
  [... all exit codes ...]
```

---

## Interactive Mode Detection

The CLI detects whether it's running in interactive mode:

**Interactive mode requires:**
- stdin is a TTY (not piped input)
- stdout is a TTY (not piped output)
- Not running in CI environment

**CI Detection:** Checks for `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `JENKINS_URL` environment variables.

**Usage in commands:**
```typescript
import { isInteractive, requireInteractive } from '../cli/interactive.js';

// Require interactive mode
requireInteractive('Cannot prompt for confirmation');
// Throws error in CI/non-interactive mode

// Check and adapt
if (isInteractive()) {
  // Prompt user
} else {
  // Use defaults or fail
}
```

---

## Color Output

Colored output respects the [no-color.org](https://no-color.org) standard:

**Colors are disabled if:**
- `NO_COLOR` environment variable is set (any value)
- `STEROIDS_NO_COLOR=1` or `STEROIDS_NO_COLOR=true`
- stdout is not a TTY
- `--no-color` flag is used

**Usage:**
```typescript
import { colors, markers } from '../cli/colors.js';

console.log(colors.green('Success!'));
console.log(colors.red('Error!'));
console.log(markers.success('Task completed'));
console.log(markers.error('Task failed'));
```

---

## Implementation Files

| File | Purpose |
|------|---------|
| `src/cli/flags.ts` | Global flags parser with env var support |
| `src/cli/output.ts` | JSON envelope and Output helper class |
| `src/cli/errors.ts` | Error codes, exit codes, and CliError class |
| `src/cli/env.ts` | Environment variable utilities |
| `src/cli/interactive.ts` | Interactive mode detection |
| `src/cli/colors.ts` | Colored output with no-color support |
| `src/cli/help.ts` | Help text generation and templates |
| `src/cli/index.ts` | Barrel export for all CLI utilities |

---

## Adding Help to a New Command

```typescript
import { generateHelp } from '../cli/help.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';

const HELP = generateHelp({
  command: 'mycommand',
  description: 'One-line description',
  details: `Multi-line detailed description.
Explain what the command does and when to use it.`,
  usage: ['steroids mycommand [options]'],
  subcommands: [
    { name: 'list', description: 'List items' },
    { name: 'add', args: '<name>', description: 'Add item' },
  ],
  options: [
    { short: 's', long: 'status', description: 'Filter by status', values: 'pending | completed' },
  ],
  examples: [
    { command: 'steroids mycommand', description: 'Basic usage' },
    { command: 'steroids mycommand --status completed', description: 'With filter' },
  ],
  related: [
    { command: 'steroids other', description: 'Related command' },
  ],
});

export async function mycommandCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'mycommand', flags });

  // Parse command-specific args
  const { values } = parseArgs({
    args,
    options: {
      status: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  // Handle help
  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  // Command logic...
  const result = { success: true };

  // Output
  if (flags.json) {
    out.success(result);
  } else {
    out.log('Command completed successfully!');
  }
}
```

---

## Testing the Help System

Run the test script:

```bash
./test-help-system.sh
```

This validates:
- Global flags work on all commands
- JSON output follows envelope format
- Environment variables are respected
- Exit codes are semantic
- Help text is comprehensive
- Error handling works correctly

---

## Examples

### Basic Help

```bash
steroids --help
steroids tasks --help
steroids init --help
```

### JSON Output

```bash
# Via flag
steroids tasks --status all --json

# Via env var
STEROIDS_JSON=1 steroids tasks list

# Version as JSON
steroids --version --json
```

### Quiet Mode

```bash
# Via flag
steroids tasks list --quiet

# Via env var
STEROIDS_QUIET=1 steroids tasks list
```

### Verbose Mode

```bash
steroids loop --verbose
STEROIDS_VERBOSE=1 steroids loop
```

### Disable Colors

```bash
steroids tasks list --no-color
NO_COLOR=1 steroids tasks list
STEROIDS_NO_COLOR=1 steroids tasks list
```

### Combined Flags

```bash
# JSON + verbose
steroids tasks list -jv

# Quiet + no-color
steroids tasks list -q --no-color
```

### Timeout

```bash
steroids loop --timeout 30s
steroids loop --timeout 5m
STEROIDS_TIMEOUT=1h steroids loop
```

### Shell Scripting

```bash
#!/bin/bash
# Robust error handling with exit codes

if ! steroids tasks list --json > tasks.json; then
  echo "Failed to list tasks (exit code: $?)"
  exit 1
fi

# Parse JSON output
PENDING_COUNT=$(jq '.data.total' tasks.json)
echo "Found $PENDING_COUNT pending tasks"

# Update task with error handling
if steroids tasks update abc123 --status completed --json > result.json; then
  echo "Task completed successfully"
else
  ERROR_CODE=$(jq -r '.error.code' result.json)
  ERROR_MSG=$(jq -r '.error.message' result.json)

  case "$ERROR_CODE" in
    TASK_NOT_FOUND)
      echo "Task not found"
      ;;
    TASK_LOCKED)
      echo "Task is locked - retrying later..."
      sleep 5
      ;;
    *)
      echo "Unexpected error: $ERROR_MSG"
      exit 1
      ;;
  esac
fi
```

---

## Future Enhancements

Potential improvements (not currently planned):

- [ ] Shell completion scripts (bash, zsh, fish)
- [ ] Man pages generation
- [ ] Interactive mode with prompts (inquirer-like)
- [ ] Progress bars for long-running operations
- [ ] Table formatting with adjustable column widths
- [ ] YAML output format (in addition to JSON)
- [ ] Markdown output for documentation
- [ ] Color themes (light/dark/custom)
- [ ] Localization (i18n) support

---

## Related Documentation

- [CLI Architecture](../CLI/ARCHITECTURE.md) - Overall CLI design
- [Code Quality](./CODE_QUALITY.md) - Coding standards
- [CLAUDE.md](../CLAUDE.md) - Development workflow
