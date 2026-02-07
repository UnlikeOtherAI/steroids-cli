#!/usr/bin/env node
/**
 * Steroids CLI - Automated task execution system
 * Entry point for the CLI
 */

import { parseArgs } from 'node:util';
import { initCommand } from './commands/init.js';
import { tasksCommand } from './commands/tasks.js';
import { sectionsCommand } from './commands/sections.js';
import { loopCommand } from './commands/loop.js';
import { runnersCommand } from './commands/runners.js';
import { configCommand } from './commands/config.js';

const VERSION = '0.1.0';

const HELP = `
steroids - Automated task execution with coder/reviewer loop

USAGE:
  steroids <command> [options]

COMMANDS:
  init              Initialize steroids in current directory
  sections          Manage task sections
  tasks             Manage tasks
  loop              Run the orchestrator loop
  runners           Manage runner daemons
  config            Manage configuration

OPTIONS:
  -h, --help        Show help
  -v, --version     Show version
  -j, --json        Output as JSON
  -q, --quiet       Minimal output

EXAMPLES:
  steroids init
  steroids sections add "Phase 1"
  steroids tasks add "Implement feature" --section "Phase 1"
  steroids tasks list
  steroids loop
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    process.exit(0);
  }

  if (args[0] === '-v' || args[0] === '--version') {
    console.log(`steroids v${VERSION}`);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case 'init':
        await initCommand(commandArgs);
        break;
      case 'sections':
        await sectionsCommand(commandArgs);
        break;
      case 'tasks':
        await tasksCommand(commandArgs);
        break;
      case 'loop':
        await loopCommand(commandArgs);
        break;
      case 'runners':
        await runnersCommand(commandArgs);
        break;
      case 'config':
        await configCommand(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('An unexpected error occurred');
    }
    process.exit(1);
  }
}

main();
