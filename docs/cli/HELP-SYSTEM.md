# Help System Documentation

## Overview

The Steroids CLI has a comprehensive help system that provides consistent, detailed information for all commands. This document explains the help system architecture and how to use it.

## Features

### 1. **Comprehensive Help Text**
Every command includes:
- Short description
- Detailed explanation
- Usage examples
- Subcommand listing
- Option documentation
- Related commands
- Exit codes
- Environment variables

### 2. **Global Options**
All commands support these global flags:
```bash
-h, --help        # Show help
--version         # Show version
-j, --json        # Output as JSON
-q, --quiet       # Minimal output
-v, --verbose     # Detailed output
--no-color        # Disable colored output
--config <path>   # Custom config file path
--dry-run         # Preview without executing
--timeout <dur>   # Command timeout (e.g., 30s, 5m)
--no-hooks        # Skip hook execution
--no-wait         # Don't wait for locks
```

### 3. **JSON Output Envelope**
When using `--json`, all commands output a standard envelope:

**Success:**
```json
{
  "success": true,
  "command": "tasks",
  "subcommand": "list",
  "data": { ... },
  "error": null
}
```

**Error:**
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

### 4. **Semantic Exit Codes**
```
0  Success
1  General error
2  Invalid arguments
3  Configuration error or not initialized
4  Resource not found
5  Permission denied
6  Resource locked
7  Health check failed
```

### 5. **Environment Variables**
All global flags can be set via environment variables:
```bash
STEROIDS_CONFIG=/path/to/config
STEROIDS_JSON=1
STEROIDS_QUIET=1
STEROIDS_VERBOSE=1
STEROIDS_NO_HOOKS=1
STEROIDS_NO_COLOR=1
STEROIDS_NO_WAIT=1
STEROIDS_AUTO_MIGRATE=1
STEROIDS_TIMEOUT=30s
NO_COLOR=1
CI=1
```

## Usage Examples

### Viewing Help

```bash
# Main help
steroids --help

# Command help
steroids tasks --help
steroids sections --help
steroids loop --help

# Any command with -h
steroids tasks -h
```

### Using JSON Output

```bash
# Via flag
steroids tasks list --json

# Via environment variable
STEROIDS_JSON=1 steroids tasks list

# Parse with jq
steroids tasks list --json | jq '.data.tasks[]'
```

### Using Global Flags

```bash
# Quiet mode
steroids tasks list --quiet
STEROIDS_QUIET=1 steroids tasks list

# Verbose mode
steroids loop --verbose

# Dry run (preview)
steroids tasks update abc123 --status completed --dry-run

# Disable colors
steroids tasks list --no-color
NO_COLOR=1 steroids tasks list

# Custom config
steroids --config ~/my-config.json tasks list
```

### CI/CD Integration

```bash
# Check health with threshold
steroids health --threshold 80 --json
if [ $? -eq 7 ]; then
  echo "Health check failed"
  exit 1
fi

# List tasks as JSON in CI
STEROIDS_JSON=1 steroids tasks list --status all

# Run without hooks in CI
STEROIDS_NO_HOOKS=1 steroids loop --once
```

## Architecture

### CLI Infrastructure (`src/cli/`)

```
src/cli/
├── flags.ts        # Global flags parser
├── output.ts       # JSON envelope and output helpers
├── errors.ts       # Error codes and exit codes
├── colors.ts       # Colored output support
├── env.ts          # Environment variable support
├── interactive.ts  # Interactive mode detection
├── help.ts         # Help system templates
└── index.ts        # Barrel export
```

### Key Components

#### 1. **Flags Parser** (`flags.ts`)
```typescript
export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  noColor: boolean;
  configPath?: string;
  dryRun: boolean;
  timeout?: number;
  noHooks: boolean;
  noWait: boolean;
}

export function parseGlobalFlags(args: string[]): ParsedArgs;
```

#### 2. **Output Helper** (`output.ts`)
```typescript
export class Output {
  success<T>(data: T): void;
  error(code: string, message: string, details?: Record<string, unknown>): void;
  log(message: string): void;
  verbose(message: string): void;
  warn(message: string): void;
  table(headers: string[], rows: string[][]): void;
}
```

#### 3. **Error Codes** (`errors.ts`)
```typescript
export enum ErrorCode {
  SUCCESS = 'SUCCESS',
  GENERAL_ERROR = 'GENERAL_ERROR',
  INVALID_ARGUMENTS = 'INVALID_ARGUMENTS',
  CONFIG_ERROR = 'CONFIG_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',
  // ...
}

export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly exitCode: ExitCode;
  public readonly details?: Record<string, unknown>;
}
```

#### 4. **Help Generator** (`help.ts`)
```typescript
export interface HelpTemplate {
  command: string;
  description: string;
  details?: string;
  usage?: string[];
  subcommands?: SubcommandDef[];
  options?: OptionDef[];
  examples?: CommandExample[];
  related?: RelatedCommand[];
  sections?: HelpSection[];
}

export function generateHelp(template: HelpTemplate): string;
```

### Command Structure

Each command follows this pattern:

```typescript
import { generateHelp } from '../cli/help.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';

const HELP = generateHelp({
  command: 'mycommand',
  description: 'Short description',
  details: 'Detailed explanation',
  examples: [
    { command: 'steroids mycommand', description: 'Basic usage' },
    { command: 'steroids mycommand --flag', description: 'With option' },
  ],
  // ...
});

export async function myCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const output = createOutput({
    command: 'mycommand',
    flags,
  });

  try {
    // Command logic here
    const result = await doSomething();

    if (flags.json) {
      output.success(result);
    } else {
      output.log('Success!');
    }
  } catch (error) {
    if (error instanceof CliError) {
      if (flags.json) {
        output.error(error.code, error.message, error.details);
      } else {
        console.error(colors.red(error.message));
      }
      process.exit(error.exitCode);
    }
    throw error;
  }
}
```

## Adding Help to New Commands

1. **Import the help generator:**
   ```typescript
   import { generateHelp } from '../cli/help.js';
   ```

2. **Define the help template:**
   ```typescript
   const HELP = generateHelp({
     command: 'newcommand',
     description: 'What this command does',
     details: 'Longer explanation with context',
     usage: ['steroids newcommand [options]'],
     options: [
       { short: 'f', long: 'flag', description: 'What this does' },
     ],
     examples: [
       { command: 'steroids newcommand', description: 'Basic' },
       { command: 'steroids newcommand --flag value', description: 'With flag' },
     ],
     related: [
       { command: 'steroids othercommand', description: 'Related command' },
     ],
   });
   ```

3. **Handle --help flag:**
   ```typescript
   export async function newCommand(args: string[], flags: GlobalFlags): Promise<void> {
     if (flags.help) {
       console.log(HELP);
       return;
     }
     // Command logic...
   }
   ```

4. **Use Output helper for consistent output:**
   ```typescript
   const output = createOutput({ command: 'newcommand', flags });
   output.success(data);  // Handles JSON vs. human-readable
   ```

## Testing

Test the help system with:

```bash
# Run all help tests
npm run test:help

# Or manually
./scripts/test-cli-contract.sh
```

## Related Documentation

- [CLI Architecture](./ARCHITECTURE.md)
- [Error Handling](./ERROR-HANDLING.md)
- [JSON Output Reference](./JSON-OUTPUT.md)
