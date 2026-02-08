import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids sections - Manage task sections
 */

import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { openDatabase } from '../database/connection.js';
import {
  createSection,
  listSections,
  getSectionTaskCount,
  getSection,
  setSectionPriority,
  addSectionDependency,
  removeSectionDependency,
  getSectionDependencies,
  getPendingDependencies,
  listTasks,
  STATUS_MARKERS,
  type TaskStatus,
} from '../database/queries.js';

const HELP = `
steroids sections - Manage task sections

USAGE:
  steroids sections <subcommand> [options]

SUBCOMMANDS:
  add <name>                       Add a new section
  list [--deps]                    List all sections
  priority <id> <value>            Set section priority (0-100 or high/medium/low)
  depends-on <id> <depends-on-id>  Add section dependency
  no-depends-on <id> <dep-id>      Remove section dependency
  graph                            Show dependency graph

OPTIONS:
  -h, --help        Show help
  -j, --json        Output as JSON

EXAMPLES:
  steroids sections add "Phase 1: Foundation"
  steroids sections list --deps
  steroids sections priority abc123 high
  steroids sections priority abc123 25
  steroids sections depends-on abc123 def456
  steroids sections graph
`;

export async function sectionsCommand(args: string[], flags: GlobalFlags): Promise<void> {
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
    case 'priority':
      await setPriority(subArgs);
      break;
    case 'depends-on':
      await addDependency(subArgs);
      break;
    case 'no-depends-on':
      await removeDependency(subArgs);
      break;
    case 'graph':
      await showGraph(subArgs);
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
      deps: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids sections list - List all sections

USAGE:
  steroids sections list [options]

OPTIONS:
  --deps              Show dependencies inline
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
        dependencies: values.deps ? getSectionDependencies(db, s.id) : undefined,
        pending_dependencies: values.deps ? getPendingDependencies(db, s.id) : undefined,
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
    if (values.deps) {
      console.log(
        'ID        NAME                                      PRIORITY  TASKS  DEPENDENCIES'
      );
    } else {
      console.log(
        'ID        NAME                                          TASKS'
      );
    }
    console.log('─'.repeat(90));

    for (const section of sections) {
      const taskCount = getSectionTaskCount(db, section.id);
      const shortId = section.id.substring(0, 8);

      if (values.deps) {
        const deps = getSectionDependencies(db, section.id);
        const pendingDeps = getPendingDependencies(db, section.id);
        const priority = section.priority ?? 50;
        const depsDisplay = deps.length > 0
          ? deps.map(d => d.id.substring(0, 8)).join(', ')
          : '-';
        const blocked = pendingDeps.length > 0 ? ' [BLOCKED]' : '';

        console.log(
          `${shortId}  ${section.name.padEnd(40)}  ${String(priority).padStart(3)}     ${String(taskCount).padStart(2)}     ${depsDisplay}${blocked}`
        );
      } else {
        console.log(
          `${shortId}  ${section.name.padEnd(44)}  ${taskCount}`
        );
      }
    }
  } finally {
    close();
  }
}

async function setPriority(args: string[]): Promise<void> {
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

async function addDependency(args: string[]): Promise<void> {
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

async function removeDependency(args: string[]): Promise<void> {
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

async function showGraph(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      mermaid: { type: 'boolean', default: false },
      output: { type: 'string' },  // png or svg
      open: { type: 'boolean', short: 'o', default: false },
      tasks: { type: 'boolean', default: false },
      status: { type: 'string' },  // active, pending, etc.
      section: { type: 'string' },  // section ID filter
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids sections graph - Show dependency graph

USAGE:
  steroids sections graph [options]

OPTIONS:
  -j, --json           Output as JSON
  --mermaid            Output Mermaid flowchart syntax
  --output <format>    Generate image file (png or svg)
  -o, --open           Auto-open generated file
  --tasks              Include tasks within sections
  --status <status>    Filter tasks by status (pending, active, etc.)
  --section <id>       Show only specified section
  -h, --help           Show help

EXAMPLES:
  steroids sections graph
  steroids sections graph --mermaid
  steroids sections graph --output png -o
  steroids sections graph --tasks --status active
  steroids sections graph --section abc123 --tasks
`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const sections = listSections(db);

    if (values.json) {
      const graph = sections.map((s) => ({
        ...s,
        dependencies: getSectionDependencies(db, s.id),
        pending_dependencies: getPendingDependencies(db, s.id),
      }));
      console.log(JSON.stringify(graph, null, 2));
      return;
    }

    if (sections.length === 0) {
      console.log('No sections found.');
      return;
    }

    // Build dependency graph (simple ASCII tree)
    const sectionsWithDeps = sections.map(s => ({
      section: s,
      dependencies: getSectionDependencies(db, s.id),
      pendingDeps: getPendingDependencies(db, s.id),
    }));

    // Find root sections (no dependencies)
    const rootSections = sectionsWithDeps.filter(s => s.dependencies.length === 0);

    console.log('SECTION DEPENDENCY GRAPH');
    console.log('─'.repeat(90));

    // Print each root and its descendants
    const printed = new Set<string>();

    function printSection(sectionId: string, indent: string = '', isLast: boolean = true) {
      if (printed.has(sectionId)) return;
      printed.add(sectionId);

      const item = sectionsWithDeps.find(s => s.section.id === sectionId);
      if (!item) return;

      const priority = item.section.priority ?? 50;
      const blocked = item.pendingDeps.length > 0 ? ' [BLOCKED]' : '';
      const prefix = indent + (isLast ? '└─> ' : '├─> ');

      console.log(`${prefix}${item.section.name} (priority: ${priority})${blocked}`);

      // Find sections that depend on this one
      const dependents = sectionsWithDeps.filter(s =>
        s.dependencies.some(d => d.id === sectionId)
      );

      const newIndent = indent + (isLast ? '    ' : '│   ');
      dependents.forEach((dep, idx) => {
        printSection(dep.section.id, newIndent, idx === dependents.length - 1);
      });
    }

    if (rootSections.length === 0) {
      console.log('(circular dependencies detected - showing all sections)');
      sectionsWithDeps.forEach((item, idx) => {
        printSection(item.section.id, '', idx === sectionsWithDeps.length - 1);
      });
    } else {
      rootSections.forEach((item, idx) => {
        printSection(item.section.id, '', idx === rootSections.length - 1);
      });
    }

    console.log();
  } finally {
    close();
  }
}
