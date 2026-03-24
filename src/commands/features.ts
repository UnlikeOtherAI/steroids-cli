/**
 * steroids features - Manage complete features with multiple tasks
 */

import { parseArgs } from 'node:util';
import { openDatabase, withDatabase } from '../database/connection.js';
import { createSection, listSections, getSectionTaskCount } from '../database/queries.js';
import { generateHelp } from '../cli/help.js';
import { createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';

const HELP = generateHelp({
  command: 'features',
  description: 'Manage complete features with multiple tasks',
  details: `Features are collections of related tasks organized under a section.
Each feature can contain multiple tasks that belong together as a cohesive unit.`,
  usage: ['steroids features <subcommand> [options]'],
  subcommands: [
    { name: 'add', args: '<name> --tasks <task-list>', description: 'Add a new feature with tasks' },
    { name: 'list', args: '', description: 'List all features (sections with tasks)' },
  ],
  options: [
    { long: 'tasks', description: 'Comma-separated list of task titles', values: '<task1>,<task2>,...' },
    { long: 'branch', description: 'Target branch for the feature', values: '<branch-name>' },
    { long: 'auto-pr', description: 'Enable auto-PR on feature completion' },
  ],
  examples: [
    { command: 'steroids features add "User Authentication" --tasks "Login endpoint,Register endpoint,Password reset"', description: 'Add feature with multiple tasks' },
    { command: 'steroids features add "API Gateway" --tasks "Route requests,Rate limiting,Metrics collection" --branch feature/api-gateway', description: 'Add feature with branch override' },
    { command: 'steroids features list', description: 'List all features with their tasks' },
  ],
  related: [
    { command: 'steroids sections', description: 'Manage sections (underlying concept)' },
    { command: 'steroids tasks', description: 'Manage individual tasks' },
  ],
});

export async function featuresCommand(args: string[], flags: any): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || flags.help) {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':
      await addFeature(subArgs, flags);
      break;
    case 'list':
      await listFeatures(subArgs, flags);
      break;
    default: {
      const out = createOutput({ command: 'features', subcommand, flags });
      if (flags.json) {
        out.error(ErrorCode.INVALID_ARGUMENTS, `Unknown subcommand: ${subcommand}`);
      } else {
        console.error(`Unknown subcommand: ${subcommand}`);
        console.log(HELP);
      }
      process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
    }
  }
}

async function addFeature(args: string[], globalFlags: any): Promise<void> {
  const flags = globalFlags || { json: false, quiet: false, verbose: false, help: false, version: false, noColor: false, dryRun: false, noHooks: false, noWait: false };
  const out = createOutput({ command: 'features', subcommand: 'add', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      tasks: { type: 'string' },
      branch: { type: 'string' },
      'auto-pr': { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    console.log(`
steroids features add - Add a new feature with tasks

USAGE:
  steroids features add <name> [options]

OPTIONS:
  -j, --json              Output as JSON (global flag)
  --tasks <task1>,<task2> Comma-separated list of task titles
  --branch <branch-name>  Target branch for the feature
  --auto-pr               Enable auto-PR on feature completion
  -h, --help              Show help

EXAMPLES:
  steroids features add "User Authentication" \\
    --tasks "Login endpoint,Register endpoint,Password reset"
    
  steroids features add "API Gateway" \\
    --tasks "Route requests,Rate limiting,Metrics collection" \\
    --branch feature/api-gateway
`);
    return;
  }

  // Extract feature name (first positional argument)
  if (args.length === 0) {
    if (flags.json) {
      out.error(ErrorCode.INVALID_ARGUMENTS, 'Feature name is required');
    } else {
      console.error('Error: Feature name is required');
      console.log('Usage: steroids features add <name> --tasks "<task1>,<task2>,..."');
    }
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  const featureName = args[0];

  // Validate tasks are provided
  if (!values.tasks) {
    if (flags.json) {
      out.error(ErrorCode.INVALID_ARGUMENTS, '--tasks is required');
    } else {
      console.error('Error: --tasks is required');
      console.log('Usage: steroids features add <name> --tasks "<task1>,<task2>,..."');
    }
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  // Split tasks
  const taskTitles = values.tasks.split(',').map(t => t.trim()).filter(t => t.length > 0);
  if (taskTitles.length === 0) {
    if (flags.json) {
      out.error(ErrorCode.INVALID_ARGUMENTS, 'At least one task is required');
    } else {
      console.error('Error: At least one task is required');
    }
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  const projectPath = process.cwd();
  
  // Create feature section
  let sectionId = '';
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = db.transaction(() => {
      const s = createSection(db, featureName);
      sectionId = s.id;
      return s;
    })();
    
    // Add branch if specified
    if (values.branch) {
      db.transaction(() => {
        db.prepare('UPDATE sections SET branch = ? WHERE id = ?').run(values.branch, sectionId);
      })();
    }
    
    // Enable auto-PR if requested
    if (values['auto-pr']) {
      db.transaction(() => {
        db.prepare('UPDATE sections SET auto_pr = 1 WHERE id = ?').run(sectionId);
      })();
    }
  });

  // Add tasks to the section (simplified approach)
  const addedTasks: any[] = [];
  for (const taskTitle of taskTitles) {
    try {
      // Create tasks in a simpler way using a direct query
      /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
        const stmt = db.prepare('INSERT INTO tasks (title, section_id, status) VALUES (?, ?, "pending")');
        const result = stmt.run(taskTitle, sectionId);
        addedTasks.push({ title: taskTitle, id: result.lastInsertRowid.toString() });
      });
    } catch (error) {
      console.error(`Failed to add task "${taskTitle}": ${(error as Error).message}`);
      // Continue with other tasks
    }
  }

  if (flags.json) {
    out.success({
      feature: {
        name: featureName,
        id: sectionId,
        tasks: addedTasks,
        task_count: addedTasks.length,
      },
    });
  } else {
    console.log(`✓ Added feature: ${featureName}`);
    console.log(`  Section ID: ${sectionId}`);
    console.log(`  Tasks added: ${addedTasks.length}`);
    for (const task of addedTasks) {
      console.log(`    - ${task.title} (${task.id})`);
    }
  }
}

async function listFeatures(args: string[], globalFlags: any): Promise<void> {
  const flags = globalFlags || { json: false, quiet: false, verbose: false, help: false, version: false, noColor: false, dryRun: false, noHooks: false, noWait: false };
  const out = createOutput({ command: 'features', subcommand: 'list', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    console.log(`
steroids features list - List all features

USAGE:
  steroids features list [options]

OPTIONS:
  -j, --json     Output as JSON (global flag)
  -h, --help     Show help
`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const sections = listSections(db);

    if (flags.json) {
      const result = sections.map((s: any) => {
        const taskCount = getSectionTaskCount(db, s.id);
        return {
          ...s,
          task_count: taskCount,
        };
      });
      out.success({
        features: result,
        total: result.length,
      });
      return;
    }

    if (sections.length === 0) {
      console.log('No features found. Create one with:');
      console.log('  steroids features add "Feature Name" --tasks "Task 1,Task 2"');
      return;
    }

    console.log('FEATURES');
    console.log('─'.repeat(100));
    console.log('ID        NAME                               BRANCH              TASKS');
    console.log('─'.repeat(100));

    for (const section of sections) {
      const taskCount = getSectionTaskCount(db, section.id);
      const shortId = section.id.substring(0, 8);
      
      // Branch display: show branch + PR info if set
      let branchDisplay = section.branch ?? '-';
      if (section.auto_pr) {
        branchDisplay += section.pr_number != null ? ` PR#${section.pr_number}` : ' [auto-PR]';
      }
      const branchCol = branchDisplay.substring(0, 18).padEnd(18);

      console.log(
        `${shortId}  ${section.name.padEnd(33)}  ${branchCol}  ${String(taskCount).padStart(2)}`
      );
    }
  });
}