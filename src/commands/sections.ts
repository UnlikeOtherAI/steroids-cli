/**
 * steroids sections - Manage task sections
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import {
  createSection,
  listSections,
  getSectionTaskCount,
} from '../database/queries.js';

const HELP = `
steroids sections - Manage task sections

USAGE:
  steroids sections <subcommand> [options]

SUBCOMMANDS:
  add <name>        Add a new section
  list              List all sections

OPTIONS:
  -h, --help        Show help
  -j, --json        Output as JSON

EXAMPLES:
  steroids sections add "Phase 1: Foundation"
  steroids sections add "Phase 2: Core Features"
  steroids sections list
  steroids sections list --json
`;

export async function sectionsCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':
      await addSection(subArgs);
      break;
    case 'list':
      await listAllSections(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function addSection(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      position: { type: 'string', short: 'p' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids sections add <name> - Add a new section

USAGE:
  steroids sections add <name> [options]

OPTIONS:
  -p, --position <n>  Position in list (default: end)
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  if (positionals.length === 0) {
    console.error('Error: Section name required');
    process.exit(1);
  }

  const name = positionals.join(' ');
  const position = values.position ? parseInt(values.position, 10) : undefined;

  const { db, close } = openDatabase();
  try {
    const section = createSection(db, name, position);

    if (values.json) {
      console.log(JSON.stringify(section, null, 2));
    } else {
      console.log(`Section created: ${section.name}`);
      console.log(`  ID: ${section.id}`);
      console.log(`  Position: ${section.position}`);
    }
  } finally {
    close();
  }
}

async function listAllSections(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids sections list - List all sections

USAGE:
  steroids sections list [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const sections = listSections(db);

    if (values.json) {
      const result = sections.map((s) => ({
        ...s,
        task_count: getSectionTaskCount(db, s.id),
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (sections.length === 0) {
      console.log('No sections found. Create one with:');
      console.log('  steroids sections add "Section Name"');
      return;
    }

    console.log('SECTIONS');
    console.log('─'.repeat(90));
    console.log(
      'ID        NAME                                          TASKS'
    );
    console.log('─'.repeat(90));

    for (const section of sections) {
      const taskCount = getSectionTaskCount(db, section.id);
      const shortId = section.id.substring(0, 8);
      console.log(
        `${shortId}  ${section.name.padEnd(44)}  ${taskCount}`
      );
    }
  } finally {
    close();
  }
}
