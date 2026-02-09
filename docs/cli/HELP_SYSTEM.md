# Steroids CLI Help System

## Overview

The Steroids CLI implements a comprehensive, consistent help system across all commands with:
- Standard JSON output envelope for machine-readable responses
- Semantic exit codes following Unix conventions
- Environment variable support for configuration
- Interactive mode detection for CI/CD compatibility
- Colored output with proper NO_COLOR support
- Rich help text with examples and cross-references

## Components

### 1. Global Flags (`src/cli/flags.ts`)

All commands accept these global flags:

```bash
-h, --help          Show help
--version           Show version
-j, --json          Output as JSON
-q, --quiet         Minimal output
-v, --verbose       Detailed output
--no-color          Disable colored output
--config <path>     Custom config file path
--dry-run           Preview without executing
--timeout <dur>     Command timeout (e.g., 30s, 5m, 1h)
--no-hooks          Skip hook execution
--no-wait           Don't wait for locks
```

**Short flag combinations** work: `-jqv` = `--json --quiet --verbose`

### 2. JSON Output Envelope (`src/cli/output.ts`)

**Success format:**
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

**Error format:**
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

### 3. Error Codes (`src/cli/errors.ts`)

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

**Specific error codes** (map to generic exit codes):
- `TASK_NOT_FOUND`, `SECTION_NOT_FOUND` → `NOT_FOUND` (4)
- `TASK_LOCKED` → `RESOURCE_LOCKED` (6)
- `NOT_INITIALIZED`, `MIGRATION_REQUIRED` → `CONFIG_ERROR` (3)
- `HOOK_FAILED` → `GENERAL_ERROR` (1)

### 4. Environment Variables (`src/cli/env.ts`)

| Variable | Maps To | Values |
|----------|---------|--------|
| `STEROIDS_CONFIG` | `--config` | Path |
| `STEROIDS_JSON` | `--json` | `1`, `true` |
| `STEROIDS_QUIET` | `--quiet` | `1`, `true` |
| `STEROIDS_VERBOSE` | `--verbose` | `1`, `true` |
| `STEROIDS_NO_HOOKS` | `--no-hooks` | `1`, `true` |
| `STEROIDS_NO_COLOR` | `--no-color` | `1`, `true` |
| `STEROIDS_NO_WAIT` | `--no-wait` | `1`, `true` |
| `STEROIDS_AUTO_MIGRATE` | auto-migrate | `1`, `true` |
| `STEROIDS_TIMEOUT` | `--timeout` | Duration |
| `NO_COLOR` | `--no-color` | Any value |
| `CI` | detected | Any value |

**Environment variables override defaults** but are themselves overridden by explicit CLI flags.

### 5. Interactive Detection (`src/cli/interactive.ts`)

Detects:
- TTY on stdin/stdout
- CI environment (GitHub Actions, GitLab CI, CircleCI, Travis, Jenkins)
- Non-interactive mode (piped input/output)

**Use cases:**
```typescript
import { isInteractive, requireInteractive } from './cli/interactive.js';

// Warn if non-interactive
if (!isInteractive()) {
  console.warn('Running in non-interactive mode');
}

// Require interactive or throw
requireInteractive('Cannot prompt for migration confirmation');
```

### 6. Colors (`src/cli/colors.ts`)

Respects `NO_COLOR` and `--no-color`:

```typescript
import { colors, markers } from './cli/colors.js';

console.log(colors.red('Error'));
console.log(colors.green('Success'));
console.log(markers.success('Task completed'));
console.log(markers.error('Task failed'));
```

### 7. Help System (`src/cli/help.ts`)

Generates comprehensive help from templates:

```typescript
import { generateHelp } from './cli/help.js';

const HELP = generateHelp({
  command: 'tasks',
  description: 'Manage tasks',
  details: 'Long description...',
  usage: ['steroids tasks [options]'],
  subcommands: [
    { name: 'list', description: 'List tasks' },
  ],
  options: [
    { short: 's', long: 'status', description: 'Filter by status' },
  ],
  examples: [
    { command: 'steroids tasks', description: 'List pending tasks' },
  ],
  related: [
    { command: 'steroids sections', description: 'Manage sections' },
  ],
});
```

## Usage Examples

### Basic Help
```bash
steroids --help
steroids tasks --help
steroids tasks -h
```

### JSON Output
```bash
steroids tasks --json
steroids tasks list --json
STEROIDS_JSON=1 steroids tasks
```

### Environment Variables
```bash
export STEROIDS_JSON=1
export STEROIDS_VERBOSE=1
steroids tasks

# Or inline
STEROIDS_QUIET=1 steroids tasks list
```

### Exit Codes
```bash
steroids tasks
echo $?  # 0 on success

steroids fakecommand
echo $?  # 2 for invalid arguments
```

### Dry Run
```bash
steroids init --dry-run
steroids tasks add "New task" --dry-run
```

### No Color
```bash
NO_COLOR=1 steroids tasks
steroids tasks --no-color
```

## Testing

Run the comprehensive test suite:

```bash
./test-help-system.sh
```

This verifies:
1. Global flags work on all commands
2. JSON output follows standard envelope
3. Exit codes are semantic
4. Environment variables work
5. Help is comprehensive on all commands
6. Combined short flags work
7. Duration parsing works
8. Dry run mode works
9. Color disable works
10. Error messages are helpful

## Implementation Checklist

- [x] Global flags parser (`src/cli/flags.ts`)
- [x] JSON output envelope (`src/cli/output.ts`)
- [x] Error codes and exit codes (`src/cli/errors.ts`)
- [x] Environment variable support (`src/cli/env.ts`)
- [x] Interactive detection (`src/cli/interactive.ts`)
- [x] Colored output (`src/cli/colors.ts`)
- [x] Help system (`src/cli/help.ts`)
- [x] Update all commands to use new system
- [x] Comprehensive test suite

## Success Criteria

✅ `--json` works on every command
✅ Exit codes are semantic
✅ Errors include machine-parseable codes
✅ Environment variables override flags
✅ `--help` is comprehensive on all commands
✅ Non-interactive mode works in CI
