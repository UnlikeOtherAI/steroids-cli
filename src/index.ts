#!/usr/bin/env node
/**
 * Steroids CLI - Automated task execution system
 * Entry point for the CLI
 */

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
      case 'about':
        await aboutCommand(commandArgs);
        break;
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
      case 'health':
        await healthCommand(commandArgs);
        break;
      case 'scan':
        await scanCommand(commandArgs);
        break;
      case 'backup':
        await backupCommand(commandArgs);
        break;
      case 'logs':
        await logsCommand(commandArgs);
        break;
      case 'gc':
        await gcCommand(commandArgs);
        break;
      case 'completion':
        await completionCommand(commandArgs);
        break;
      case 'locks':
        await locksCommand(commandArgs);
        break;
      case 'dispute':
        await disputeCommand(commandArgs);
        break;
      case 'purge':
        await purgeCommand(commandArgs);
        break;
      case 'git':
        await gitCommand(commandArgs);
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
