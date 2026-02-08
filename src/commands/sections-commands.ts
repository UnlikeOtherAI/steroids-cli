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
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { invalidArgumentsError, sectionNotFoundError } from '../cli/errors.js';

export async function addSection(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'add', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      position: { type: 'string', short: 'p' },
    },
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections add <name> - Add a new section

USAGE:
  steroids sections add <name> [options]

OPTIONS:
  -p, --position <n>  Position in list (default: end)

GLOBAL OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  if (positionals.length === 0) {
    throw invalidArgumentsError('Section name required');
  }

  const name = positionals.join(' ');
  const position = values.position ? parseInt(values.position, 10) : undefined;

  if (flags.dryRun) {
    out.log(`Would create section: ${name}`);
    if (position !== undefined) {
      out.log(`  Position: ${position}`);
    }
    return;
  }

  const { db, close } = openDatabase();
  try {
    const section = createSection(db, name, position);

    if (flags.json) {
      out.success({
        section: {
          id: section.id,
          name: section.name,
          position: section.position,
          priority: section.priority,
          created_at: section.created_at,
        },
      });
    } else {
      out.log(`Section created: ${section.name}`);
      out.log(`  ID: ${section.id}`);
      out.log(`  Position: ${section.position}`);
    }
  } finally {
    close();
  }
}

export async function setPriority(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'priority', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections priority <section-id> <priority> - Set section priority

USAGE:
  steroids sections priority <section-id> <priority>

ARGUMENTS:
  section-id    Section ID or prefix (min 4 chars)
  priority      Priority value (0-100) or preset (high=10, medium=50, low=90)

GLOBAL OPTIONS:
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
    throw invalidArgumentsError('Section ID and priority required');
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
      throw invalidArgumentsError('Priority must be 0-100 or high/medium/low');
    }
  }

  if (flags.dryRun) {
    out.log(`Would set priority to ${priority} for section: ${sectionIdInput}`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    setSectionPriority(db, section.id, priority);

    if (flags.json) {
      out.success({
        section: {
          id: section.id,
          name: section.name,
          priority,
        },
      });
    } else {
      out.log(`Priority set to ${priority} for section: ${section.name}`);
    }
  } finally {
    close();
  }
}

export async function addDependency(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'depends-on', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections depends-on <section-id> <depends-on-id> - Add section dependency

USAGE:
  steroids sections depends-on <section-id> <depends-on-id>

ARGUMENTS:
  section-id       The section that depends on another
  depends-on-id    The section that must be completed first

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    throw invalidArgumentsError('Both section IDs required');
  }

  const [sectionIdInput, dependsOnIdInput] = positionals;

  if (flags.dryRun) {
    out.log(`Would add dependency: ${sectionIdInput} depends on ${dependsOnIdInput}`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    const dependsOnSection = getSection(db, dependsOnIdInput);
    if (!dependsOnSection) {
      throw sectionNotFoundError(dependsOnIdInput);
    }

    const dependency = addSectionDependency(db, section.id, dependsOnSection.id);

    if (flags.json) {
      out.success({
        dependency: {
          section_id: dependency.section_id,
          depends_on_section_id: dependency.depends_on_section_id,
          section_name: section.name,
          depends_on_name: dependsOnSection.name,
        },
      });
    } else {
      out.log(`Dependency added: ${section.name} depends on ${dependsOnSection.name}`);
    }
  } finally {
    close();
  }
}

export async function removeDependency(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'no-depends-on', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections no-depends-on <section-id> <depends-on-id> - Remove section dependency

USAGE:
  steroids sections no-depends-on <section-id> <depends-on-id>

ARGUMENTS:
  section-id       The dependent section
  depends-on-id    The dependency to remove

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections no-depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    throw invalidArgumentsError('Both section IDs required');
  }

  const [sectionIdInput, dependsOnIdInput] = positionals;

  if (flags.dryRun) {
    out.log(`Would remove dependency: ${sectionIdInput} no longer depends on ${dependsOnIdInput}`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    const dependsOnSection = getSection(db, dependsOnIdInput);
    if (!dependsOnSection) {
      throw sectionNotFoundError(dependsOnIdInput);
    }

    removeSectionDependency(db, section.id, dependsOnSection.id);

    if (flags.json) {
      out.success({
        removed: {
          section_id: section.id,
          depends_on_section_id: dependsOnSection.id,
          section_name: section.name,
          depends_on_name: dependsOnSection.name,
        },
      });
    } else {
      out.log(`Dependency removed: ${section.name} no longer depends on ${dependsOnSection.name}`);
    }
  } finally {
    close();
  }
}
