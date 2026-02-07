/**
 * steroids init - Initialize steroids in current directory
 */

import { parseArgs } from 'node:util';
import { initDatabase, isInitialized, getDbPath } from '../database/connection.js';

const HELP = `
steroids init - Initialize Steroids in current directory

USAGE:
  steroids init [options]

OPTIONS:
  -y, --yes         Accept all defaults
  -h, --help        Show help

CREATES:
  .steroids/steroids.db    SQLite database with task schema
`;

export async function initCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const cwd = process.cwd();

  if (isInitialized(cwd)) {
    console.log('Steroids already initialized in this directory.');
    console.log(`Database: ${getDbPath(cwd)}`);
    return;
  }

  console.log('Initializing Steroids...');

  const { close } = initDatabase(cwd);
  close();

  console.log('');
  console.log('Steroids initialized successfully!');
  console.log(`Database: ${getDbPath(cwd)}`);
  console.log('');
  console.log('Next steps:');
  console.log('  steroids sections add "Phase 1"');
  console.log('  steroids tasks add "My first task" --section "Phase 1"');
  console.log('  steroids loop');
}
