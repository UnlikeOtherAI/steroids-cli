import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids sections - Manage task sections
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import {
  listSections,
  getSectionTaskCount,
  getSection,
  getSectionDependencies,
  getPendingDependencies,
  listTasks,
  STATUS_MARKERS,
  type TaskStatus,
} from '../database/queries.js';
import { generateMermaidSyntax, generateImageFromMermaid } from './sections-graph.js';
import {
  addSection,
  setPriority,
  addDependency,
  removeDependency
} from './sections-commands.js';
import { generateHelp } from '../cli/help.js';
import { createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';

const HELP = generateHelp({
  command: 'sections',
  description: 'Manage task sections and dependencies',
  details: `Sections organize tasks into logical phases or milestones.
Each section can have dependencies on other sections, controlling execution order.
Sections help structure large projects and track high-level progress.`,
  usage: ['steroids sections <subcommand> [options]'],
  subcommands: [
    { name: 'add', args: '<name>', description: 'Add a new section' },
    { name: 'list', args: '[--deps]', description: 'List all sections with task counts' },
    { name: 'priority', args: '<id> <value>', description: 'Set section priority (0-100 or high/medium/low)' },
    { name: 'depends-on', args: '<id> <depends-on-id>', description: 'Add section dependency' },
    { name: 'no-depends-on', args: '<id> <dep-id>', description: 'Remove section dependency' },
    { name: 'graph', args: '[options]', description: 'Show dependency graph (ASCII, Mermaid, image)' },
  ],
  options: [
    { long: 'deps', description: 'Show dependencies in list view' },
    { long: 'mermaid', description: 'Output Mermaid flowchart syntax (graph subcommand)' },
    { long: 'output', description: 'Generate image file (graph subcommand)', values: 'png | svg' },
    { short: 'o', long: 'open', description: 'Auto-open generated file' },
    { long: 'tasks', description: 'Include tasks within sections in graph' },
    { long: 'status', description: 'Filter tasks by status in graph', values: '<status>' },
    { long: 'section', description: 'Show only specified section in graph', values: '<id>' },
  ],
  examples: [
    { command: 'steroids sections add "Phase 1: Foundation"', description: 'Add new section' },
    { command: 'steroids sections list', description: 'List all sections with task counts' },
    { command: 'steroids sections list --deps', description: 'Show dependencies' },
    { command: 'steroids sections priority abc123 high', description: 'Set priority (high/medium/low)' },
    { command: 'steroids sections priority abc123 25', description: 'Set numeric priority (0-100)' },
    { command: 'steroids sections depends-on abc123 def456', description: 'Add dependency' },
    { command: 'steroids sections no-depends-on abc123 def456', description: 'Remove dependency' },
    { command: 'steroids sections graph', description: 'ASCII tree view (default)' },
    { command: 'steroids sections graph --json', description: 'JSON output' },
    { command: 'steroids sections graph --mermaid', description: 'Mermaid flowchart syntax' },
    { command: 'steroids sections graph --output png', description: 'Generate PNG image' },
    { command: 'steroids sections graph --output svg --open', description: 'Generate and open SVG' },
    { command: 'steroids sections graph --tasks', description: 'Include tasks in graph' },
    { command: 'steroids sections graph --tasks --status active', description: 'Show active tasks only' },
    { command: 'steroids sections graph --section abc123 --tasks', description: 'Single section graph' },
  ],
  related: [
    { command: 'steroids tasks', description: 'Manage tasks within sections' },
    { command: 'steroids loop', description: 'Run automation respecting section dependencies' },
  ],
  sections: [
    {
      title: 'PRIORITY VALUES',
      content: `high      = 75
medium    = 50 (default)
low       = 25
Or any number 0-100`,
    },
    {
      title: 'DEPENDENCIES',
      content: `Sections can depend on other sections.
Tasks in a section only run if all dependency sections are completed.
Use 'graph' subcommand to visualize the dependency tree.`,
    },
  ],
});

export async function sectionsCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || flags.help) {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':
      await addSection(subArgs, flags);
      break;
    case 'list':
      await listAllSections(subArgs, flags);
      break;
    case 'priority':
      await setPriority(subArgs, flags);
      break;
    case 'depends-on':
      await addDependency(subArgs, flags);
      break;
    case 'no-depends-on':
      await removeDependency(subArgs, flags);
      break;
    case 'graph':
      await showGraph(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }
}

async function listAllSections(args: string[], globalFlags?: GlobalFlags): Promise<void> {
  const flags = globalFlags || { json: false, quiet: false, verbose: false, help: false, version: false, noColor: false, dryRun: false, noHooks: false, noWait: false };
  const out = createOutput({ command: 'sections', subcommand: 'list', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      deps: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    console.log(`
steroids sections list - List all sections

USAGE:
  steroids sections list [options]

OPTIONS:
  --deps              Show dependencies inline
  -j, --json          Output as JSON (global flag)
  -h, --help          Show help
`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const sections = listSections(db);

    if (flags.json) {
      const result = sections.map((s) => ({
        ...s,
        task_count: getSectionTaskCount(db, s.id),
        pending_dependencies: getPendingDependencies(db, s.id),
        dependencies: values.deps ? getSectionDependencies(db, s.id) : undefined,
      }));
      out.success({
        sections: result,
        total: result.length,
      });
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
        'ID        NAME                                    PRIORITY  TASKS'
      );
    }
    console.log('─'.repeat(90));

    for (const section of sections) {
      const taskCount = getSectionTaskCount(db, section.id);
      const shortId = section.id.substring(0, 8);
      const pendingDeps = getPendingDependencies(db, section.id);
      const priority = section.priority ?? 50;
      const blocked = pendingDeps.length > 0 ? ' [BLOCKED]' : '';

      if (values.deps) {
        const deps = getSectionDependencies(db, section.id);
        const depsDisplay = deps.length > 0
          ? deps.map(d => d.id.substring(0, 8)).join(', ')
          : '-';

        console.log(
          `${shortId}  ${section.name.padEnd(40)}  ${String(priority).padStart(3)}     ${String(taskCount).padStart(2)}     ${depsDisplay}${blocked}`
        );
      } else {
        console.log(
          `${shortId}  ${section.name.padEnd(38)}  ${String(priority).padStart(3)}     ${String(taskCount).padStart(2)}${blocked}`
        );
      }
    }
  } finally {
    close();
  }
}

async function showGraph(args: string[], globalFlags?: GlobalFlags): Promise<void> {
  const flags = globalFlags || { json: false, quiet: false, verbose: false, help: false, version: false, noColor: false, dryRun: false, noHooks: false, noWait: false };
  const out = createOutput({ command: 'sections', subcommand: 'graph', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      mermaid: { type: 'boolean', default: false },
      output: { type: 'string' },  // png or svg
      open: { type: 'boolean', short: 'o', default: false },
      tasks: { type: 'boolean', default: false },
      status: { type: 'string' },  // active, pending, etc.
      section: { type: 'string' },  // section ID filter
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
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

OUTPUT FORMATS:
  Default (ASCII):       steroids sections graph
  JSON:                  steroids sections graph --json
  Mermaid syntax:        steroids sections graph --mermaid
  PNG image:             steroids sections graph --output png
  SVG image:             steroids sections graph --output svg -o

EXAMPLES:
  # Basic dependency graph (ASCII tree)
  steroids sections graph

  # Generate PNG and auto-open it
  steroids sections graph --output png -o

  # Show graph with all tasks included
  steroids sections graph --tasks

  # Filter to show only active tasks (in_progress or review)
  steroids sections graph --tasks --status active

  # Graph for a single section with its tasks
  steroids sections graph --section abc123 --tasks

  # Export as Mermaid syntax (for documentation)
  steroids sections graph --mermaid > docs/sections.mmd
`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    // Filter sections if --section specified
    let sections = listSections(db);
    if (values.section) {
      const section = getSection(db, values.section);
      if (!section) {
        console.error(`Error: Section not found: ${values.section}`);
        process.exit(getExitCode(ErrorCode.SECTION_NOT_FOUND));
      }
      sections = [section];
    }

    if (sections.length === 0) {
      console.log('No sections found.');
      return;
    }

    // Build dependency graph with tasks if requested
    const sectionsWithDeps = sections.map(s => {
      const deps = getSectionDependencies(db, s.id);
      const pendingDeps = getPendingDependencies(db, s.id);
      let tasks: any[] = [];

      if (values.tasks) {
        const taskFilter: any = { sectionId: s.id };
        if (values.status) {
          if (values.status === 'active') {
            // Active means in_progress or review
            tasks = listTasks(db, { sectionId: s.id }).filter(
              t => t.status === 'in_progress' || t.status === 'review'
            );
          } else {
            taskFilter.status = values.status as TaskStatus;
            tasks = listTasks(db, taskFilter);
          }
        } else {
          tasks = listTasks(db, taskFilter);
        }
      }

      return {
        section: s,
        dependencies: deps,
        pendingDeps,
        tasks,
      };
    });

    // Handle JSON output
    if (flags.json) {
      const graph = sectionsWithDeps.map((s) => ({
        ...s.section,
        dependencies: s.dependencies,
        pending_dependencies: s.pendingDeps,
        tasks: s.tasks,
      }));
      out.success({ graph });
      return;
    }

    // Handle Mermaid output
    if (values.mermaid || values.output) {
      const mermaidSyntax = generateMermaidSyntax(sectionsWithDeps, values.tasks || false);

      if (values.output) {
        await generateImageFromMermaid(mermaidSyntax, values.output, values.open || false);
      } else {
        console.log(mermaidSyntax);
      }
      return;
    }

    // Default: ASCII tree output
    const rootSections = sectionsWithDeps.filter(s => s.dependencies.length === 0);

    console.log('SECTION DEPENDENCY GRAPH');
    console.log('─'.repeat(90));

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

      // Print tasks if requested
      if (values.tasks && item.tasks.length > 0) {
        const taskIndent = indent + (isLast ? '    ' : '│   ');
        item.tasks.forEach((task, idx) => {
          const marker = STATUS_MARKERS[task.status as TaskStatus] || '[ ]';
          const rejections = task.rejection_count > 0 ? ` (${task.rejection_count} rejections)` : '';
          const taskPrefix = taskIndent + (idx === item.tasks.length - 1 ? '└─ ' : '├─ ');
          console.log(`${taskPrefix}${marker} ${task.title}${rejections}`);
        });
      }

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
