# Phase 0.5: CLI Contract - COMPLETED ✅

## Overview
Phase 0.5 establishes a consistent CLI contract across all Steroids commands with global flags, JSON output, semantic exit codes, and comprehensive help.

## Implementation Summary

### ✅ Task 0.5.1: Global Flags Parser
**Status:** COMPLETED
**File:** `src/cli/flags.ts`

Implemented all required global flags:
- `-h, --help` - Show help
- `--version` - Show version
- `-j, --json` - Output as JSON
- `-q, --quiet` - Minimal output
- `-v, --verbose` - Detailed output
- `--no-color` - Disable colors
- `--config <path>` - Custom config path
- `--dry-run` - Preview without executing
- `--timeout <duration>` - Command timeout (supports 30s, 5m, 1h formats)
- `--no-hooks` - Skip hook execution
- `--no-wait` - Don't wait for locks

**Features:**
- Combined short flags support (e.g., `-jqv`)
- Duration parser for timeout values
- Conflict validation (quiet vs verbose)
- Environment variable fallback

### ✅ Task 0.5.2: JSON Output Envelope
**Status:** COMPLETED
**File:** `src/cli/output.ts`

Implemented standard JSON response envelope:

**Success Format:**
```json
{
  "success": true,
  "command": "tasks",
  "subcommand": "list",
  "data": { ... },
  "error": null
}
```

**Error Format:**
```json
{
  "success": false,
  "command": "tasks",
  "subcommand": "update",
  "data": null,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task not found: abc123",
    "details": { "taskId": "abc123" }
  }
}
```

**Features:**
- `Output` class for consistent output across commands
- Helpers for success/error responses
- Table formatting support
- Respects quiet/verbose/JSON flags

### ✅ Task 0.5.3: Error Codes
**Status:** COMPLETED
**File:** `src/cli/errors.ts`

Defined comprehensive error code system:

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

**Features:**
- `CliError` class with automatic exit code mapping
- Helper functions for common errors
- Proper error propagation and JSON formatting

### ✅ Task 0.5.4: Environment Variable Support
**Status:** COMPLETED
**File:** `src/cli/env.ts`

Implemented comprehensive environment variable support:

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
| `CI` | detected | Any value |
| `NO_COLOR` | `--no-color` | Any value |

**Features:**
- Centralized env var access
- CI system detection (GitHub, GitLab, CircleCI, Travis, Jenkins)
- Boolean value parsing (`isTruthy`, `isFalsy`)
- Environment snapshot for debugging

### ✅ Task 0.5.5: Interactive Detection
**Status:** COMPLETED
**File:** `src/cli/interactive.ts`

Implemented interactive mode detection:

**Features:**
- TTY detection for stdin/stdout
- CI environment detection
- `requireInteractive()` function for commands that need user input
- `warnNonInteractive()` for optional interactivity
- Environment info reporting

**Detection Logic:**
- Interactive if: stdin is TTY AND stdout is TTY AND not in CI
- Detects: GitHub Actions, GitLab CI, CircleCI, Travis, Jenkins, Generic CI

### ✅ Task 0.5.6: Colored Output
**Status:** COMPLETED
**File:** `src/cli/colors.ts`

Implemented colored output with proper disable support:

**Features:**
- Respects `NO_COLOR` and `STEROIDS_NO_COLOR`
- Respects `--no-color` flag
- Automatic disable when stdout is not a TTY
- Color helpers: `red`, `green`, `yellow`, `blue`, `cyan`, `magenta`, `gray`
- Status markers: `success ✓`, `error ✗`, `warning ⚠`, `info ℹ`
- Progress markers: `pending ○`, `progress ◐`, `completed ●`

### ✅ Task 0.5.7: Help System
**Status:** COMPLETED
**File:** `src/cli/help.ts`

Implemented comprehensive help system:

**Features:**
- `generateHelp()` function with template system
- Support for: command description, usage, subcommands, options, examples, related commands
- Automatic global options section
- Automatic environment variables section
- Automatic exit codes section
- "Did you mean?" suggestions using Levenshtein distance
- Consistent formatting across all commands

**Template Structure:**
```typescript
{
  command: 'tasks',
  description: 'Manage tasks',
  details: 'Detailed description...',
  usage: ['steroids tasks [options]'],
  subcommands: [{ name: 'list', description: '...' }],
  options: [{ short: 's', long: 'status', description: '...' }],
  examples: [{ command: '...', description: '...' }],
  related: [{ command: 'steroids sections', description: '...' }],
  sections: [{ title: 'CUSTOM', content: '...' }],
}
```

### ✅ Task 0.5.8: Update All Existing Commands
**Status:** COMPLETED

All 20 commands updated:
1. ✅ `about` - Uses generateHelp, GlobalFlags
2. ✅ `backup` - Uses generateHelp, GlobalFlags
3. ✅ `completion` - Uses generateHelp, GlobalFlags
4. ✅ `config` - Uses generateHelp, GlobalFlags
5. ✅ `disputes` - Uses generateHelp, GlobalFlags
6. ✅ `gc` - Uses generateHelp, GlobalFlags
7. ✅ `git` - Uses generateHelp, GlobalFlags
8. ✅ `health` - Uses generateHelp, GlobalFlags
9. ✅ `init` - Uses generateHelp, GlobalFlags
10. ✅ `llm` - Uses generateHelp, GlobalFlags
11. ✅ `locks` - Uses generateHelp, GlobalFlags
12. ✅ `logs` - Uses generateHelp, GlobalFlags
13. ✅ `loop` - Uses generateHelp, GlobalFlags
14. ✅ `projects` - Uses generateHelp, GlobalFlags
15. ✅ `purge` - Uses generateHelp, GlobalFlags
16. ✅ `runners` - Uses generateHelp, GlobalFlags
17. ✅ `scan` - Uses generateHelp, GlobalFlags
18. ✅ `sections` - Uses generateHelp, GlobalFlags
19. ✅ `stats` - Uses generateHelp, GlobalFlags
20. ✅ `tasks` - Uses generateHelp, GlobalFlags

**Main CLI Entry Point** (`src/index.ts`):
- ✅ Parses global flags first
- ✅ Applies global flags to environment
- ✅ Passes flags to all commands
- ✅ Handles errors with proper exit codes
- ✅ Supports JSON error output

## Testing Results

### ✅ Global Flags
- ✅ `--help` works
- ✅ `--version` works
- ✅ `--json` works
- ✅ `-h` short form works
- ✅ Combined flags work (e.g., `-jqv`)

### ✅ JSON Output Envelope
- ✅ Success envelope has all required fields
- ✅ Error envelope has all required fields
- ✅ Error includes code, message, details

### ✅ Exit Codes
- ✅ Success returns 0
- ✅ Invalid arguments returns 2
- ✅ Semantic codes for different error types

### ✅ Environment Variables
- ✅ `STEROIDS_JSON` works
- ✅ `STEROIDS_QUIET` works
- ✅ `NO_COLOR` works
- ✅ `CI` detection works

### ✅ Command Help
- ✅ All commands have examples
- ✅ All commands show exit codes
- ✅ All commands show environment variables
- ✅ All commands show global options

## Success Criteria Met

1. ✅ `--json` works on every command
2. ✅ Exit codes are semantic
3. ✅ Errors include machine-parseable codes
4. ✅ Environment variables override flags
5. ✅ `--help` is comprehensive on all commands
6. ✅ Non-interactive mode works in CI

## Architecture

```
src/cli/
├── flags.ts        # Global flags parser
├── output.ts       # JSON envelope and Output class
├── errors.ts       # Error codes and CliError
├── env.ts          # Environment variable support
├── interactive.ts  # Interactive mode detection
├── colors.ts       # Colored output helpers
├── help.ts         # Help system templates
└── index.ts        # Barrel export

src/index.ts        # Main CLI entry (parses flags, routes commands)
src/commands/*.ts   # All 20 commands updated
```

## Usage Examples

### Basic Commands
```bash
# Help
steroids --help
steroids tasks --help

# Version
steroids --version
steroids --version --json

# List tasks with different flags
steroids tasks
steroids tasks --json
steroids tasks --status all
steroids tasks --global --json
```

### Environment Variables
```bash
# Use env vars instead of flags
STEROIDS_JSON=1 steroids tasks
STEROIDS_QUIET=1 steroids loop
NO_COLOR=1 steroids tasks --status all

# CI mode detection
CI=1 steroids tasks  # Non-interactive mode
```

### Error Handling
```bash
# Semantic exit codes
steroids nonexistent  # Exit 2 (invalid arguments)
steroids tasks update missing-id  # Exit 4 (not found)

# JSON error output
steroids nonexistent --json
# {
#   "success": false,
#   "error": {
#     "code": "INVALID_ARGUMENTS",
#     "message": "Unknown command: nonexistent"
#   }
# }
```

## Notes

- All commands maintain backward compatibility
- JSON output is opt-in via `--json` or `STEROIDS_JSON=1`
- Colors automatically disable in non-TTY or when `NO_COLOR` is set
- Help system is extensible for future commands
- Exit codes follow Unix conventions

## Conclusion

Phase 0.5 successfully established a robust CLI contract that:
- Provides consistent user experience across all commands
- Supports machine-readable JSON output
- Uses semantic exit codes for automation
- Respects environment variables and CI detection
- Includes comprehensive help with examples

All commands are now LLM-friendly with clear documentation, making it easier for AI agents to discover and use Steroids CLI features correctly.
