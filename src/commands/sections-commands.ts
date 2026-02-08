/**
 * Sections subcommand implementations
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import {
  createSection,
  getSection,
  setSectionPriority,
  addSectionDependency,
  removeSectionDependency,
} from '../database/queries.js';

export async function addSection(args: string[]): Promise<void> {
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

export async function setPriority(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids sections priority <section-id> <priority> - Set section priority

USAGE:
  steroids sections priority <section-id> <priority>

ARGUMENTS:
  section-id    Section ID or prefix (min 4 chars)
  priority      Priority value (0-100) or preset (high=10, medium=50, low=90)

OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections priority abc123 high
  steroids sections priority abc123 25
  steroids sections priority abc123 low
`);
    return;
  }

  if (positionals.length < 2) {
    console.error('Error: Section ID and priority required');
    process.exit(1);
  }

  const [sectionIdInput, priorityInput] = positionals;

  // Parse priority
  let priority: number;
  if (priorityInput === 'high') {
    priority = 10;
  } else if (priorityInput === 'medium') {
    priority = 50;
  } else if (priorityInput === 'low') {
    priority = 90;
  } else {
    priority = parseInt(priorityInput, 10);
    if (isNaN(priority) || priority < 0 || priority > 100) {
      console.error('Error: Priority must be 0-100 or high/medium/low');
      process.exit(1);
    }
  }

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      console.error(`Error: Section not found: ${sectionIdInput}`);
      process.exit(1);
    }

    setSectionPriority(db, section.id, priority);

    if (values.json) {
      console.log(JSON.stringify({ id: section.id, priority }, null, 2));
    } else {
      console.log(`Priority set to ${priority} for section: ${section.name}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    close();
  }
}

export async function addDependency(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids sections depends-on <section-id> <depends-on-id> - Add section dependency

USAGE:
  steroids sections depends-on <section-id> <depends-on-id>

ARGUMENTS:
  section-id       The section that depends on another
  depends-on-id    The section that must be completed first

OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    console.error('Error: Both section IDs required');
    process.exit(1);
  }

  const [sectionIdInput, dependsOnIdInput] = positionals;

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      console.error(`Error: Section not found: ${sectionIdInput}`);
      process.exit(1);
    }

    const dependsOnSection = getSection(db, dependsOnIdInput);
    if (!dependsOnSection) {
      console.error(`Error: Section not found: ${dependsOnIdInput}`);
      process.exit(1);
    }

    const dependency = addSectionDependency(db, section.id, dependsOnSection.id);

    if (values.json) {
      console.log(JSON.stringify(dependency, null, 2));
    } else {
      console.log(`Dependency added: ${section.name} depends on ${dependsOnSection.name}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    close();
  }
}

export async function removeDependency(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids sections no-depends-on <section-id> <depends-on-id> - Remove section dependency

USAGE:
  steroids sections no-depends-on <section-id> <depends-on-id>

ARGUMENTS:
  section-id       The dependent section
  depends-on-id    The dependency to remove

OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections no-depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    console.error('Error: Both section IDs required');
    process.exit(1);
  }

  const [sectionIdInput, dependsOnIdInput] = positionals;

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      console.error(`Error: Section not found: ${sectionIdInput}`);
      process.exit(1);
    }

    const dependsOnSection = getSection(db, dependsOnIdInput);
    if (!dependsOnSection) {
      console.error(`Error: Section not found: ${dependsOnIdInput}`);
      process.exit(1);
    }

    removeSectionDependency(db, section.id, dependsOnSection.id);

    if (values.json) {
      console.log(JSON.stringify({ success: true }, null, 2));
    } else {
      console.log(`Dependency removed: ${section.name} no longer depends on ${dependsOnSection.name}`);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    close();
  }
}
