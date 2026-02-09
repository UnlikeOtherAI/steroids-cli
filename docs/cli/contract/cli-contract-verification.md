# CLI Contract Verification

This document verifies that the comprehensive help system and CLI contract (Phase 0.5) is fully implemented.

## ✅ Completed Features

### 0.5.1 Global Flags Parser
**Status: ✅ COMPLETE**

- [x] Shared options parser in `src/cli/flags.ts`
- [x] `-j, --json` - Output as JSON
- [x] `-q, --quiet` - Minimal output
- [x] `-v, --verbose` - Detailed output
- [x] `-h, --help` - Show help
- [x] `--version` - Show version
- [x] `--no-color` - Disable colors
- [x] `--config <path>` - Custom config path
- [x] `--dry-run` - Preview without executing
- [x] `--timeout <duration>` - Command timeout
- [x] `--no-hooks` - Skip hook execution
- [x] `--no-wait` - Don't wait for locks

**File:** `src/cli/flags.ts` (286 lines)

### 0.5.2 JSON Output Envelope
**Status: ✅ COMPLETE**

- [x] Standard response wrapper
- [x] Success envelope with data
- [x] Error envelope with code/message/details
- [x] All commands use envelope when `--json`

**File:** `src/cli/output.ts` (256 lines)

Success Format:
```json
{
  "success": true,
  "command": "tasks",
  "subcommand": "list",
  "data": { ... },
  "error": null
}
```

Error Format:
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

### 0.5.3 Error Codes
**Status: ✅ COMPLETE**

- [x] Error code enum
- [x] Map errors to exit codes
- [x] Include in JSON error.code field

**File:** `src/cli/errors.ts` (285 lines)

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

### 0.5.4 Environment Variable Support
**Status: ✅ COMPLETE**

- [x] Read env vars on startup
- [x] Override config with env vars
- [x] Document all supported vars

**File:** `src/cli/env.ts` (238 lines)

| Variable | Maps To | Values |
|----------|---------|--------|
| `STEROIDS_CONFIG` | `--config` | Path |
| `STEROIDS_JSON` | `--json` | `1`, `true` |
| `STEROIDS_QUIET` | `--quiet` | `1`, `true` |
| `STEROIDS_VERBOSE` | `--verbose` | `1`, `true` |
| `STEROIDS_NO_HOOKS` | `--no-hooks` | `1`, `true` |
| `STEROIDS_NO_COLOR` | `--no-color` | `1`, `true` |
| `STEROIDS_AUTO_MIGRATE` | auto-migrate | `1`, `true` |
| `STEROIDS_TIMEOUT` | `--timeout` | Duration |
| `STEROIDS_NO_WAIT` | `--no-wait` | `1`, `true` |
| `CI` | detected | Any value |
| `NO_COLOR` | `--no-color` | Any value |

### 0.5.5 Interactive Detection
**Status: ✅ COMPLETE**

- [x] Detect TTY for stdin/stdout
- [x] Detect CI environment
- [x] Force non-interactive when needed
- [x] Provide helpful errors

**File:** `src/cli/interactive.ts` (137 lines)

Functions:
- `isInteractive()` - Check if running in interactive mode
- `requireInteractive(message)` - Throw error if non-interactive
- `warnNonInteractive(message)` - Warn about non-interactive mode
- `getEnvironmentInfo()` - Get environment details

### 0.5.6 Colored Output
**Status: ✅ COMPLETE**

- [x] Respect `--no-color` and `NO_COLOR`
- [x] Status markers with colors
- [x] Error messages in red
- [x] Success messages in green

**File:** `src/cli/colors.ts` (255 lines)

Color functions:
- `colors.red()`, `colors.green()`, `colors.yellow()`, `colors.blue()`
- `colors.magenta()`, `colors.cyan()`, `colors.gray()`
- `colors.bold()`, `colors.dim()`

Markers:
- `markers.success()` - ✓ in green
- `markers.error()` - ✗ in red
- `markers.warning()` - ⚠ in yellow
- `markers.info()` - ℹ in blue
- `markers.pending()`, `markers.progress()`, `markers.completed()`

### 0.5.7 Help System
**Status: ✅ COMPLETE**

- [x] Comprehensive help for every command
- [x] Examples in help text
- [x] Cross-reference related commands
- [x] LLM-friendly descriptions

**File:** `src/cli/help.ts` (384 lines)

Functions:
- `generateHelp(template)` - Generate help from template
- `quickHelp()` - Quick help for simple commands
- `showErrorCodes()` - Display error codes table
- `helpHint()` - Format help hint for errors
- `didYouMean()` - Suggest corrections

Help template supports:
- Command name and description
- Detailed description
- Usage patterns
- Subcommands
- Options (command-specific and global)
- Examples with descriptions
- Related commands
- Custom sections
- Environment variables
- Exit codes

### 0.5.8 All Commands Updated
**Status: ✅ COMPLETE**

All 20 commands use comprehensive help:
- [x] `about` - Uses generateHelp
- [x] `backup` - Uses generateHelp
- [x] `completion` - Uses generateHelp
- [x] `config` - Uses generateHelp
- [x] `dispute` - Uses generateHelp
- [x] `gc` - Uses generateHelp
- [x] `git` - Uses generateHelp
- [x] `health` - Uses generateHelp
- [x] `init` - Uses generateHelp
- [x] `llm` - Uses generateHelp
- [x] `locks` - Uses generateHelp
- [x] `logs` - Uses generateHelp
- [x] `loop` - Uses generateHelp
- [x] `projects` - Uses generateHelp
- [x] `purge` - Uses generateHelp
- [x] `runners` - Uses generateHelp
- [x] `scan` - Uses generateHelp
- [x] `sections` - Uses generateHelp
- [x] `stats` - Uses generateHelp
- [x] `tasks` - Uses generateHelp

All commands:
- Accept global flags
- Output JSON envelope when `--json`
- Use semantic exit codes
- Show comprehensive help with `--help`

## Test Results

### Global Help
```bash
$ steroids --help
# Shows main help with all commands, global options, env vars, examples
```

### Command Help
```bash
$ steroids tasks --help
# Shows comprehensive help for tasks command with:
# - Description, usage, subcommands, options
# - Examples, related commands, status values
# - Global options, env vars, exit codes
```

### JSON Output
```bash
$ steroids tasks list --json
# Returns properly formatted JSON envelope with success, command, data

$ steroids nonexistent --json
# Returns error envelope with code, message, details
```

### Exit Codes
```bash
$ steroids nonexistent
# Exits with code 2 (INVALID_ARGUMENTS)

$ steroids tasks list
# Exits with code 0 (SUCCESS)
```

### Environment Variables
```bash
$ STEROIDS_JSON=1 steroids --version
# Outputs JSON: {"version": "0.3.1"}

$ NO_COLOR=1 steroids tasks list
# Disables colored output
```

### Interactive Detection
```bash
$ echo "test" | steroids loop
# Detects non-interactive mode (piped input)

$ CI=1 steroids loop
# Detects CI environment
```

## Success Criteria

✅ **All success criteria met:**

1. ✅ `--json` works on every command
2. ✅ Exit codes are semantic (0-7)
3. ✅ Errors include machine-parseable codes
4. ✅ Environment variables override flags
5. ✅ `--help` is comprehensive on all commands
6. ✅ Non-interactive mode works in CI

## File Summary

| File | Lines | Purpose |
|------|-------|---------|
| `src/cli/flags.ts` | 286 | Global flags parser |
| `src/cli/output.ts` | 256 | JSON output envelope |
| `src/cli/errors.ts` | 285 | Error codes and exit codes |
| `src/cli/env.ts` | 238 | Environment variables |
| `src/cli/interactive.ts` | 137 | Interactive detection |
| `src/cli/colors.ts` | 255 | Colored output |
| `src/cli/help.ts` | 384 | Help system |
| `src/index.ts` | 274 | Main CLI entry point |

**Total:** 2,115 lines of CLI infrastructure

All 20 commands updated to use the comprehensive help system.

## Conclusion

**Phase 0.5: CLI Contract is 100% complete.**

All infrastructure is in place and all commands have been updated to use:
- Global flags
- JSON output envelopes
- Semantic exit codes
- Comprehensive help
- Environment variable support
- Interactive/CI detection
- Colored output

The CLI now provides a consistent, professional interface with excellent
developer experience for both interactive use and automation/scripting.
