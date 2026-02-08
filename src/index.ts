#!/usr/bin/env node
/**
 * Steroids CLI - Automated task execution system
 * Entry point for the CLI
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlobalFlags, applyGlobalFlags } from './cli/flags.js';
import { CliError, ErrorCode, getExitCode } from './cli/errors.js';
import { outputJsonError } from './cli/output.js';
import { initCommand } from './commands/init.js';
import { tasksCommand } from './commands/tasks.js';
import { sectionsCommand } from './commands/sections.js';
import { loopCommand } from './commands/loop.js';
import { runnersCommand } from './commands/runners.js';
import { configCommand } from './commands/config.js';
import { healthCommand } from './commands/health.js';
import { scanCommand } from './commands/scan.js';
import { backupCommand } from './commands/backup.js';
import { logsCommand } from './commands/logs.js';
import { gcCommand } from './commands/gc.js';
import { completionCommand } from './commands/completion.js';
import { locksCommand } from './commands/locks.js';
import { disputeCommand } from './commands/disputes.js';
import { purgeCommand } from './commands/purge.js';
import { gitCommand } from './commands/git.js';
import { aboutCommand } from './commands/about.js';

// Read version from package.json - search up from dist folder
function getVersion(): string {
  // When running from dist/, package.json is one level up
  const paths = [
    join(__dirname, '..', 'package.json'),
    join(__dirname, 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf-8'));
        if (pkg.name === 'steroids-cli') return pkg.version;
      } catch { /* ignore */ }
    }
  }
  return '0.0.0';
}
const VERSION = getVersion();

const HELP = `
steroids - Automated task execution with coder/reviewer loop

USAGE:
  steroids <command> [options]

COMMANDS:
  about             Explain what Steroids is (for LLMs discovering this tool)

  init              Initialize steroids in current directory
  sections          Manage task sections
  tasks             Manage tasks
  dispute           Manage coder/reviewer disputes
  loop              Run the orchestrator loop
  runners           Manage runner daemons
  watch             Real-time status dashboard
  ui                Manage WebUI Docker container
  config            Manage configuration
  health            Check project health
  scan              Scan directory for projects
  backup            Manage backups
  logs              View invocation logs
  gc                Garbage collection
  purge             Purge old data
  git               Git integration commands
  completion        Generate shell completions
  locks             Manage task and section locks

GLOBAL OPTIONS:
  -h, --help        Show help
  --version         Show version
  -j, --json        Output as JSON
  -q, --quiet       Minimal output
  -v, --verbose     Detailed output
  --no-color        Disable colored output
  --config <path>   Custom config file path
  --dry-run         Preview without executing
  --timeout <dur>   Command timeout (e.g., 30s, 5m)
  --no-hooks        Skip hook execution

ENVIRONMENT VARIABLES:
  STEROIDS_CONFIG        Custom config path
  STEROIDS_JSON          Output as JSON (1, true)
  STEROIDS_QUIET         Minimal output (1, true)
  STEROIDS_VERBOSE       Detailed output (1, true)
  STEROIDS_NO_HOOKS      Skip hooks (1, true)
  STEROIDS_NO_COLOR      Disable colors (1, true)
  STEROIDS_AUTO_MIGRATE  Auto-migrate database (1, true)
  STEROIDS_TIMEOUT       Command timeout (duration)
  NO_COLOR               Standard no-color variable
  CI                     CI environment detected

EXAMPLES:
  steroids init
  steroids sections add "Phase 1"
  steroids tasks add "Implement feature" --section "Phase 1"
  steroids tasks list --json
  steroids loop --verbose
  STEROIDS_QUIET=1 steroids tasks list
`;

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);

    // Parse global flags first
    const { flags, remaining } = parseGlobalFlags(args);

    // Apply global flags (e.g., set NO_COLOR)
    applyGlobalFlags(flags);

    // Handle --help at top level
    if (flags.help && remaining.length === 0) {
      console.log(HELP);
      process.exit(0);
    }

    // Handle --version at top level
    if (flags.version && remaining.length === 0) {
      if (flags.json) {
        console.log(JSON.stringify({ version: VERSION }, null, 2));
      } else {
        console.log(`steroids v${VERSION}`);
      }
      process.exit(0);
    }

    // No command provided
    if (remaining.length === 0) {
      console.log(HELP);
      process.exit(0);
    }

    const command = remaining[0];
    const commandArgs = remaining.slice(1);

    // Execute command - pass flags to all commands
    switch (command) {
      case 'about':
        await aboutCommand(commandArgs, flags);
        break;
      case 'init':
        await initCommand(commandArgs, flags);
        break;
      case 'sections':
        await sectionsCommand(commandArgs, flags);
        break;
      case 'tasks':
        await tasksCommand(commandArgs, flags);
        break;
      case 'loop':
        await loopCommand(commandArgs, flags);
        break;
      case 'runners':
        await runnersCommand(commandArgs, flags);
        break;
      case 'config':
        await configCommand(commandArgs, flags);
        break;
      case 'health':
        await healthCommand(commandArgs, flags);
        break;
      case 'scan':
        await scanCommand(commandArgs, flags);
        break;
      case 'backup':
        await backupCommand(commandArgs, flags);
        break;
      case 'logs':
        await logsCommand(commandArgs, flags);
        break;
      case 'gc':
        await gcCommand(commandArgs, flags);
        break;
      case 'completion':
        await completionCommand(commandArgs, flags);
        break;
      case 'locks':
        await locksCommand(commandArgs, flags);
        break;
      case 'dispute':
        await disputeCommand(commandArgs, flags);
        break;
      case 'purge':
        await purgeCommand(commandArgs, flags);
        break;
      case 'git':
        await gitCommand(commandArgs, flags);
        break;
      default:
        if (flags.json) {
          outputJsonError(
            command,
            null,
            ErrorCode.INVALID_ARGUMENTS,
            `Unknown command: ${command}`,
            { command }
          );
        } else {
          console.error(`Error: Unknown command: ${command}`);
          console.error(`Run 'steroids --help' for usage information.`);
        }
        process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
    }
  } catch (error) {
    // Get flags for error output (re-parse if needed, as we may have thrown before parsing)
    let errorFlags = { json: false, verbose: false };
    try {
      const { flags } = parseGlobalFlags(process.argv.slice(2));
      errorFlags = { json: flags.json, verbose: flags.verbose };
    } catch {
      // If parsing fails, use env vars as fallback
      errorFlags.json = process.env.STEROIDS_JSON === '1' || process.env.STEROIDS_JSON === 'true';
      errorFlags.verbose = process.env.STEROIDS_VERBOSE === '1';
    }

    // Handle CliError with proper exit codes
    if (error instanceof CliError) {
      if (errorFlags.json) {
        outputJsonError('steroids', null, error.code, error.message, error.details);
      } else {
        console.error(`Error: ${error.message}`);
        if (errorFlags.verbose && error.details) {
          console.error('Details:', JSON.stringify(error.details, null, 2));
        }
      }
      process.exit(error.exitCode);
    }

    // Handle generic errors
    if (error instanceof Error) {
      if (errorFlags.json) {
        outputJsonError('steroids', null, ErrorCode.GENERAL_ERROR, error.message);
      } else {
        console.error(`Error: ${error.message}`);
        if (errorFlags.verbose) {
          console.error(error.stack);
        }
      }
    } else {
      if (errorFlags.json) {
        outputJsonError('steroids', null, ErrorCode.GENERAL_ERROR, 'An unexpected error occurred');
      } else {
        console.error('An unexpected error occurred');
      }
    }
    process.exit(getExitCode(ErrorCode.GENERAL_ERROR));
  }
}

main();
