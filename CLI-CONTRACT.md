# CLI Contract

> **Status:** ✅ Implemented in Phase 0.5

This document defines the cross-cutting contract that ALL Steroids CLI commands follow.

---

## Global Flags

These flags work on **every** command:

| Flag | Short | Description |
|------|-------|-------------|
| `--help` | `-h` | Show command help |
| `--version` | | Show version |
| `--json` | `-j` | Output as JSON envelope |
| `--quiet` | `-q` | Minimal output (suppress info/warnings) |
| `--verbose` | `-v` | Detailed output |
| `--no-color` | | Disable colored output |
| `--config <path>` | | Custom config file path |
| `--dry-run` | | Preview without executing |
| `--timeout <duration>` | | Command timeout (e.g., 30s, 5m, 1h) |
| `--no-hooks` | | Skip hook execution |
| `--no-wait` | | Don't wait for locks |

### Flag Behavior

- **Combined short flags:** `-jqv` combines JSON + quiet + verbose
- **Conflicting flags:** `--quiet` and `--verbose` cannot be used together
- **Priority:** CLI flags override environment variables

---

## JSON Output Envelope

When `--json` is specified, all commands output a standard envelope:

### Success Response

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

### Error Response

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

## Exit Codes

Semantic exit codes for shell scripting and automation:

| Code | Meaning | Description |
|------|---------|-------------|
| 0 | Success | Operation completed |
| 1 | General error | Unspecified error |
| 2 | Invalid arguments | Bad command arguments |
| 3 | Config error | Configuration problem or not initialized |
| 4 | Not found | Resource not found |
| 5 | Permission denied | Access denied |
| 6 | Resource locked | Lock held by another process |
| 7 | Health failed | Health check failed |

### Error Code Mapping

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

---

## Environment Variables

Environment variables provide defaults that can be overridden by CLI flags:

| Variable | Maps To | Values |
|----------|---------|--------|
| `STEROIDS_CONFIG` | `--config` | Path to config file |
| `STEROIDS_JSON` | `--json` | `1`, `true` |
| `STEROIDS_QUIET` | `--quiet` | `1`, `true` |
| `STEROIDS_VERBOSE` | `--verbose` | `1`, `true` |
| `STEROIDS_NO_HOOKS` | `--no-hooks` | `1`, `true` |
| `STEROIDS_NO_COLOR` | `--no-color` | `1`, `true` |
| `STEROIDS_NO_WAIT` | `--no-wait` | `1`, `true` |
| `STEROIDS_AUTO_MIGRATE` | Auto-migrate behavior | `1`, `true` |
| `STEROIDS_TIMEOUT` | `--timeout` | Duration (30s, 5m, 1h) |
| `NO_COLOR` | `--no-color` | Any value |
| `CI` | CI detection | Any value |

### CI Detection

The CLI automatically detects CI environments by checking:
- `CI`
- `CONTINUOUS_INTEGRATION`
- `GITHUB_ACTIONS`
- `GITLAB_CI`
- `CIRCLECI`
- `TRAVIS`
- `JENKINS_URL`

When in CI, interactive prompts are disabled.

---

## Interactive Mode Detection

Commands detect whether they're running interactively:

```typescript
isInteractive() = stdin.isTTY && stdout.isTTY && !CI
```

Non-interactive operations must provide explicit flags or fail with helpful error:

```
Error: Cannot prompt for migration confirmation
This operation requires interactive mode or explicit flags.
```

---

## Colored Output

Colors follow the [no-color.org](https://no-color.org) standard:

- **Disabled by:** `--no-color`, `NO_COLOR`, `STEROIDS_NO_COLOR`, non-TTY stdout
- **Status markers:**
  - ✓ Green for success
  - ✗ Red for error
  - ⚠ Yellow for warning
  - ℹ Blue for info
- **Error messages:** Red
- **Success messages:** Green

---

## Help System

Every command provides comprehensive help:

```bash
steroids <command> --help
```

Help text includes:
- **Usage:** Command syntax
- **Description:** What the command does
- **Options:** Command-specific flags
- **Global Options:** Standard flags
- **Examples:** Common use cases
- **Related Commands:** Cross-references
- **Exit Codes:** Semantic codes
- **Environment Variables:** Supported vars

---

## Implementation Details

### File Structure

```
src/cli/
├── flags.ts          # Global flags parser
├── output.ts         # JSON envelope and output helpers
├── errors.ts         # Error codes and exit codes
├── env.ts            # Environment variable support
├── interactive.ts    # Interactive mode detection
├── colors.ts         # Colored output
├── help.ts           # Help system
└── index.ts          # Barrel export
```

### Command Pattern

All commands follow this pattern:

```typescript
export async function myCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'mycommand', flags });

  // Parse command-specific args
  const { values } = parseArgs({
    args,
    options: { /* command-specific options */ },
  });

  // Handle help
  if (flags.help || values.help) {
    out.log(HELP);
    return;
  }

  try {
    // Do work
    const result = await doSomething();

    // Output result
    if (flags.json) {
      out.success(result);
    } else {
      // Format for human consumption
      console.log(formatResult(result));
    }
  } catch (error) {
    if (error instanceof CliError) {
      out.error(error.code, error.message, error.details);
      process.exit(error.exitCode);
    }
    throw error;
  }
}
```

---

## Testing

Run the contract test suite:

```bash
./test-cli-contract.sh
```

Tests verify:
- Global flags work on all commands
- JSON envelope format
- Exit codes
- Environment variables
- Combined short flags
- Help text
- Interactive detection

---

## Examples

### Basic Usage

```bash
# Show version
steroids --version

# Get JSON output
steroids tasks --json

# Combine flags
steroids tasks -jqv

# Use environment variables
STEROIDS_JSON=1 steroids tasks

# Disable colors
NO_COLOR=1 steroids tasks

# Run in CI (non-interactive)
CI=1 steroids init --yes
```

### Scripting

```bash
# Parse JSON output
steroids tasks --json | jq '.data.tasks[] | select(.status == "pending")'

# Check exit codes
if steroids health; then
  echo "Healthy"
else
  case $? in
    7) echo "Health check failed" ;;
    *) echo "Other error" ;;
  esac
fi

# Timeout long operations
steroids loop --timeout 30m
```

### CI Integration

```bash
# GitHub Actions example
- name: Run Steroids
  env:
    STEROIDS_JSON: "1"
    STEROIDS_AUTO_MIGRATE: "1"
  run: |
    steroids init --yes
    steroids tasks --json > tasks.json
```

---

## Migration Guide

If you have existing code that doesn't follow the contract:

### Before (Old Style)

```typescript
export async function oldCommand(args: string[]): Promise<void> {
  console.log('Doing something...');
  // No JSON support
  // No global flags
  // Exits with 1 for all errors
}
```

### After (New Style)

```typescript
export async function newCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'newcommand', flags });

  try {
    const result = await doWork();

    if (flags.json) {
      out.success({ result });
    } else {
      out.log('Doing something...');
      console.log(result);
    }
  } catch (error) {
    if (error instanceof CliError) {
      out.error(error.code, error.message);
      process.exit(error.exitCode);
    }
    throw error;
  }
}
```

---

## See Also

- [CLAUDE.md](./CLAUDE.md) - Coding standards
- [CLI/ARCHITECTURE.md](./CLI/ARCHITECTURE.md) - CLI architecture
- [test-cli-contract.sh](./test-cli-contract.sh) - Test suite
