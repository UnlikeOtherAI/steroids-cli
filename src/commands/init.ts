/**
 * steroids init - Initialize steroids in current directory
 */

import { parseArgs } from 'node:util';
import { initDatabase, isInitialized, getDbPath } from '../database/connection.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors, markers } from '../cli/colors.js';

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

export async function initCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'init', flags });

  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  const cwd = process.cwd();
  const dbPath = getDbPath(cwd);

  if (isInitialized(cwd)) {
    if (flags.json) {
      out.success({
        message: 'Already initialized',
        database: dbPath,
        alreadyInitialized: true,
      });
    } else {
      out.log(markers.info('Steroids already initialized in this directory.'));
      out.log(`Database: ${colors.cyan(dbPath)}`);
    }
    return;
  }

  out.verbose('Initializing Steroids...');

  if (flags.dryRun) {
    out.log(colors.yellow('Dry run: Would initialize Steroids'));
    out.log(`Database would be created at: ${dbPath}`);
    return;
  }

  const { close } = initDatabase(cwd);
  close();

  if (flags.json) {
    out.success({
      message: 'Initialized successfully',
      database: dbPath,
      nextSteps: [
        'steroids sections add "Phase 1"',
        'steroids tasks add "My first task" --section "Phase 1"',
        'steroids loop',
      ],
    });
  } else {
    out.log('');
    out.log(markers.success('Steroids initialized successfully!'));
    out.log(`Database: ${colors.cyan(dbPath)}`);
    out.log('');
    out.log(colors.bold('Next steps:'));
    out.log(`  ${colors.dim('$')} steroids sections add "Phase 1"`);
    out.log(`  ${colors.dim('$')} steroids tasks add "My first task" --section "Phase 1"`);
    out.log(`  ${colors.dim('$')} steroids loop`);
  }
}
