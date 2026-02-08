import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids tasks - Manage tasks
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { openDatabase } from '../database/connection.js';
import { getRegisteredProjects } from '../runners/projects.js';
import { logActivity } from '../runners/activity-log.js';
import {
  createTask,
  listTasks,
  getTask,
  getTaskByTitle,
  updateTaskStatus,
  resetRejectionCount,
  approveTask,
  rejectTask,
  getTaskAudit,
  getSection,
  getSectionByName,
  STATUS_MARKERS,
  type Task,
  type TaskStatus,
} from '../database/queries.js';
import { outputJson as outputEnvelope, outputJsonError } from '../cli/output.js';
import { ErrorCode } from '../cli/errors.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'tasks',
  description: 'Manage tasks in the automated development workflow',
  details: `Tasks are units of work that flow through the coder/reviewer loop.
Each task has a specification file and tracks progress through various states.
Use this command to add, update, approve, reject, or skip tasks.`,
  usage: [
    'steroids tasks [options]',
    'steroids tasks <subcommand> [args] [options]',
  ],
  subcommands: [
    { name: 'list', description: 'List tasks (default subcommand)' },
    { name: 'stats', description: 'Show task counts by status' },
    { name: 'add', args: '<title>', description: 'Add a new task' },
    { name: 'update', args: '<id|title>', description: 'Update task status' },
    { name: 'approve', args: '<id|title>', description: 'Approve a task (mark completed)' },
    { name: 'reject', args: '<id|title>', description: 'Reject a task (back to in_progress)' },
    { name: 'skip', args: '<id|title>', description: 'Skip a task (external/manual work)' },
    { name: 'audit', args: '<id|title>', description: 'View task audit trail' },
  ],
  options: [
    { short: 's', long: 'status', description: 'Filter by status', values: 'pending | in_progress | review | completed | disputed | failed | skipped | partial | active | all', default: 'pending' },
    { short: 'g', long: 'global', description: 'List tasks across ALL registered projects' },
    { long: 'section', description: 'Filter by section ID (local project only)', values: '<id>' },
    { long: 'search', description: 'Search in task titles', values: '<query>' },
    { long: 'reset-rejections', description: 'Reset rejection count to 0 (update subcommand)' },
    { long: 'actor', description: 'Actor making the change', values: '<name>' },
    { long: 'model', description: 'Model identifier (for LLM actors)', values: '<model>' },
    { long: 'notes', description: 'Review notes/comments', values: '<text>' },
    { long: 'source', description: 'Specification file (add subcommand)', values: '<file>' },
    { long: 'partial', description: 'Mark as partial when skipping' },
  ],
  examples: [
    { command: 'steroids tasks', description: 'List pending tasks' },
    { command: 'steroids tasks --status all', description: 'List all tasks' },
    { command: 'steroids tasks --status active', description: 'Show active tasks (in_progress + review)' },
    { command: 'steroids tasks --status skipped', description: 'See what needs manual action' },
    { command: 'steroids tasks --global --json', description: 'List tasks from all projects as JSON' },
    { command: 'steroids tasks add "Implement login" --section abc123 --source docs/spec.md', description: 'Add new task' },
    { command: 'steroids tasks update "Implement login" --status review', description: 'Update task status' },
    { command: 'steroids tasks approve abc123 --model claude-sonnet-4', description: 'Approve a task' },
    { command: 'steroids tasks reject abc123 --model codex --notes "Missing tests"', description: 'Reject a task' },
    { command: 'steroids tasks skip abc123 --notes "Cloud SQL - manual setup"', description: 'Skip a task' },
    { command: 'steroids tasks audit abc123', description: 'View task history' },
    { command: 'steroids tasks stats --json', description: 'Get task statistics as JSON' },
  ],
  related: [
    { command: 'steroids sections', description: 'Manage task sections' },
    { command: 'steroids loop', description: 'Run automation on pending tasks' },
    { command: 'steroids dispute', description: 'View coder/reviewer disputes' },
  ],
  sections: [
    {
      title: 'STATUS VALUES',
      content: `pending         [ ]  Not started
in_progress     [-]  Being worked on by coder
review          [o]  Ready for reviewer
completed       [x]  Approved by reviewer
disputed        [!]  Coder/reviewer disagreement
failed          [F]  Exceeded 15 rejections (needs human)
skipped         [S]  Fully external (nothing to code)
partial         [s]  Coded what we could, rest external
active          Combined: in_progress + review`,
    },
  ],
});

export async function tasksCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag (parsed by main CLI)
  if (flags.help) {
    console.log(HELP);
    return;
  }

  if (args.length === 0) {
    // Default: list pending tasks
    await listAllTasks([], flags);
    return;
  }

  // Check if first arg is a subcommand or a flag
  const subcommand = args[0];

  if (subcommand.startsWith('-')) {
    // It's a flag, so this is a list command
    await listAllTasks(args, flags);
    return;
  }

  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'stats':
      await showStats(subArgs, flags);
      break;
    case 'add':
      await addTask(subArgs);
      break;
    case 'update':
      await updateTask(subArgs);
      break;
    case 'approve':
      await approveTaskCmd(subArgs);
      break;
    case 'reject':
      await rejectTaskCmd(subArgs);
      break;
    case 'skip':
      await skipTaskCmd(subArgs);
      break;
    case 'audit':
      await auditTask(subArgs);
      break;
    case 'list':
      await listAllTasks(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

interface TaskWithProject extends Task {
  project_path?: string;
  project_name?: string;
}

async function listAllTasks(args: string[], globalFlags?: GlobalFlags): Promise<void> {
  // Check for help flag first (parseArgs doesn't always handle -h well)
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      status: { type: 'string', short: 's', default: 'pending' },
      section: { type: 'string' },
      search: { type: 'string' },
      global: { type: 'boolean', short: 'g', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  // Honor global --json flag or local -j/--json flag
  const outputJson = values.json || globalFlags?.json;

  const statusFilter = values.status as string;
  const isGlobalQuery = values.global as boolean;

  // For --global flag, query all registered projects
  if (isGlobalQuery) {
    const allTasks: TaskWithProject[] = [];
    const projects = getRegisteredProjects(false); // enabled only

    for (const project of projects) {
      const dbPath = `${project.path}/.steroids/steroids.db`;
      if (!existsSync(dbPath)) continue;

      try {
        const { db, close } = openDatabase(project.path);
        try {
          let tasks: Task[];
          if (statusFilter === 'active') {
            const inProgress = listTasks(db, { status: 'in_progress', search: values.search });
            const review = listTasks(db, { status: 'review', search: values.search });
            tasks = [...inProgress, ...review];
          } else {
            tasks = listTasks(db, { status: statusFilter as TaskStatus | 'all', search: values.search });
          }

          const projectName = project.name || basename(project.path);
          for (const task of tasks) {
            allTasks.push({
              ...task,
              project_path: project.path,
              project_name: projectName,
            });
          }
        } finally {
          close();
        }
      } catch {
        // Skip projects with inaccessible databases
      }
    }

    if (outputJson) {
      outputEnvelope('tasks', 'list', {
        tasks: allTasks,
        total: allTasks.length,
        filter: { status: statusFilter, global: true },
      });
      return;
    }

    if (allTasks.length === 0) {
      console.log(`No ${statusFilter} tasks found across all projects.`);
      return;
    }

    const statusLabel = statusFilter.toUpperCase();
    console.log(`${statusLabel} TASKS (All Projects)`);
    console.log('─'.repeat(100));
    console.log(
      'STATUS  PROJECT                    TITLE                                        REJ  ID'
    );
    console.log('─'.repeat(100));

    for (const task of allTasks) {
      const marker = STATUS_MARKERS[task.status];
      const shortId = task.id.substring(0, 8);
      const projectName = (task.project_name || 'unknown').substring(0, 22).padEnd(22);
      const title = task.title.length > 40
        ? task.title.substring(0, 37) + '...'
        : task.title.padEnd(40);
      const rej = task.rejection_count > 0
        ? String(task.rejection_count).padStart(3)
        : '  -';
      console.log(`${marker}     ${projectName}   ${title}  ${rej}  ${shortId}`);
    }

    console.log('─'.repeat(100));
    console.log(`Total: ${allTasks.length} active task(s) across ${projects.length} project(s)`);

    // Multi-project warning
    if (projects.length > 1) {
      const currentProject = process.cwd();
      console.log('');
      console.log('─'.repeat(100));
      console.log('⚠️  MULTI-PROJECT WARNING');
      console.log(`   Your current project: ${currentProject}`);
      console.log('   DO NOT modify files in other projects. Each runner works only on its own project.');
      console.log('─'.repeat(100));
    }
    return;
  }

  // Non-global query: use current project only
  const { db, close } = openDatabase();
  try {
    let sectionId: string | undefined;

    if (values.section) {
      const section = getSection(db, values.section);
      if (!section) {
        console.error(`Section not found: ${values.section}`);
        console.error('Use "steroids sections list" to see available sections.');
        process.exit(1);
      }
      sectionId = section.id;
    }

    let tasks: Task[];
    if (statusFilter === 'active') {
      const inProgress = listTasks(db, { status: 'in_progress', sectionId, search: values.search });
      const review = listTasks(db, { status: 'review', sectionId, search: values.search });
      tasks = [...inProgress, ...review];
    } else {
      tasks = listTasks(db, {
        status: statusFilter as TaskStatus | 'all',
        sectionId,
        search: values.search,
      });
    }

    if (outputJson) {
      outputEnvelope('tasks', 'list', {
        tasks,
        total: tasks.length,
        filter: { status: statusFilter, section: sectionId, search: values.search },
      });
      return;
    }

    if (tasks.length === 0) {
      console.log(`No ${values.status} tasks found.`);
      return;
    }

    console.log(`TASKS (Project: ${process.cwd()})`);
    console.log('─'.repeat(80));
    console.log(
      'STATUS  TITLE                                                   REJ  ID'
    );
    console.log('─'.repeat(80));

    for (const task of tasks) {
      const marker = STATUS_MARKERS[task.status];
      const shortId = task.id.substring(0, 8);
      const title = task.title.length > 52
        ? task.title.substring(0, 49) + '...'
        : task.title.padEnd(52);
      const rej = task.rejection_count > 0
        ? String(task.rejection_count).padStart(3)
        : '  -';
      console.log(`${marker}     ${title}  ${rej}  ${shortId}`);
    }

    console.log('─'.repeat(80));
    console.log(`Total: ${tasks.length} tasks`);
  } finally {
    close();
  }
}

async function showStats(args: string[], globalFlags?: GlobalFlags): Promise<void> {
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
steroids tasks stats - Show task counts by status

USAGE:
  steroids tasks stats [options]

OPTIONS:
  -j, --json        Output as JSON
  -h, --help        Show help

EXAMPLE:
  steroids tasks stats
`);
    return;
  }

  const outputJson = values.json || globalFlags?.json;

  const { db, close } = openDatabase();
  try {
    const statuses: TaskStatus[] = [
      'pending',
      'in_progress',
      'review',
      'completed',
      'disputed',
      'failed',
      'skipped',
      'partial',
    ];

    const counts: Record<string, number> = {};
    let total = 0;

    for (const status of statuses) {
      const tasks = listTasks(db, { status });
      counts[status] = tasks.length;
      total += tasks.length;
    }

    if (outputJson) {
      outputEnvelope('tasks', 'stats', { counts, total });
      return;
    }

    console.log('TASK STATS');
    console.log('─'.repeat(30));
    for (const status of statuses) {
      const count = counts[status];
      const marker = STATUS_MARKERS[status];
      console.log(`  ${marker} ${status.padEnd(12)}: ${count}`);
    }
    console.log('─'.repeat(30));
    console.log(`  Total: ${total}`);
  } finally {
    close();
  }
}

async function addTask(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      section: { type: 'string' },
      source: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids tasks add <title> - Add a new task

USAGE:
  steroids tasks add <title> --section <id> --source <file> [options]

OPTIONS:
  --section <id>        Section ID (REQUIRED)
  --source <file>       Specification file (REQUIRED)
  -j, --json            Output as JSON
  -h, --help            Show help

EXAMPLES:
  steroids tasks add "Implement login" --section abc123 --source docs/login-spec.md
  steroids tasks add "Fix bug" --section def456 --source specs/bugfix.md
`);
    return;
  }

  if (positionals.length === 0) {
    console.error('Error: task title required');
    console.error('Usage: steroids tasks add <title> --section <id> --source <file>');
    process.exit(2);
  }

  if (!values.section) {
    console.error('Error: --section <id> is required');
    console.error('Every task must belong to a section.');
    console.error('Usage: steroids tasks add <title> --section <id> --source <file>');
    process.exit(2);
  }

  if (!values.source) {
    console.error('Error: --source <file> is required');
    console.error('Every task must reference a specification file.');
    console.error('Usage: steroids tasks add <title> --section <id> --source <file>');
    process.exit(2);
  }

  const title = positionals.join(' ');

  const { db, close } = openDatabase();
  try {
    const section = getSection(db, values.section);
    if (!section) {
      console.error(`Section not found: ${values.section}`);
      console.error('Use "steroids sections list" to see available sections.');
      process.exit(1);
    }

    const task = createTask(db, title, {
      sectionId: section.id,
      sourceFile: values.source,
    });

    if (values.json) {
      outputEnvelope('tasks', 'add', { task });
    } else {
      console.log(`Task created: ${task.title}`);
      console.log(`  ID: ${task.id}`);
      console.log(`  Status: ${task.status}`);
      if (task.source_file) {
        console.log(`  Source: ${task.source_file}`);
      }
    }
  } finally {
    close();
  }
}

async function updateTask(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      status: { type: 'string' },
      actor: { type: 'string', default: 'human:cli' },
      model: { type: 'string' },
      notes: { type: 'string' },
      'reset-rejections': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids tasks update <title|id> - Update task status

USAGE:
  steroids tasks update <title|id> [options]

OPTIONS:
  --status <status>     New status: pending | in_progress | review | completed
  --reset-rejections    Reset rejection count to 0 (keeps audit history)
  --actor <actor>       Actor making the change (default: human:cli)
  --model <model>       Model identifier (for LLM actors)
  --notes <text>        Notes for the reviewer (useful when submitting for review)
  -j, --json            Output as JSON
  -h, --help            Show help

EXAMPLES:
  steroids tasks update abc123 --status review
  steroids tasks update abc123 --status pending --reset-rejections
  steroids tasks update abc123 --status review --notes "Found existing implementation at commit xyz"
`);
    return;
  }

  if (!values.status && !values['reset-rejections']) {
    console.error('Error: --status or --reset-rejections required');
    process.exit(1);
  }

  const identifier = positionals.join(' ');

  const { db, close } = openDatabase();
  try {
    // Try to find task by ID or title
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }

    if (!task) {
      console.error(`Task not found: ${identifier}`);
      process.exit(1);
    }

    const actor = values.model
      ? `model:${values.model}`
      : values.actor ?? 'human:cli';

    let oldRejectionCount: number | undefined;

    // Reset rejections if requested
    if (values['reset-rejections']) {
      oldRejectionCount = resetRejectionCount(db, task.id, actor, values.notes as string | undefined);
    }

    // Update status if provided
    if (values.status) {
      updateTaskStatus(db, task.id, values.status as TaskStatus, actor, values.notes as string | undefined);
    }

    const updated = getTask(db, task.id);

    if (values.json) {
      console.log(JSON.stringify({ ...updated, rejectionReset: oldRejectionCount !== undefined }, null, 2));
    } else {
      console.log(`Task updated: ${task.title}`);
      if (values.status) {
        console.log(`  Status: ${task.status} → ${values.status}`);
      }
      if (oldRejectionCount !== undefined) {
        console.log(`  Rejections: ${oldRejectionCount} → 0 (reset)`);
      }
    }
  } finally {
    close();
  }
}

async function approveTaskCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      model: { type: 'string' },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids tasks approve <id> - Approve a task

USAGE:
  steroids tasks approve <id> [options]

OPTIONS:
  --model <model>   Model performing the review (required)
  --notes <text>    Approval notes
  -j, --json        Output as JSON
  -h, --help        Show help
`);
    return;
  }

  if (!values.model) {
    console.error('Error: --model required');
    process.exit(1);
  }

  const identifier = positionals[0];

  const { db, close } = openDatabase();
  try {
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }

    if (!task) {
      console.error(`Task not found: ${identifier}`);
      process.exit(1);
    }

    approveTask(db, task.id, values.model, values.notes);

    const updated = getTask(db, task.id);

    if (values.json) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(`Task approved: ${task.title}`);
      console.log(`  Status: completed`);
      console.log(`  Reviewer: ${values.model}`);
    }
  } finally {
    close();
  }
}

async function rejectTaskCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      model: { type: 'string' },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids tasks reject <id> - Reject a task

USAGE:
  steroids tasks reject <id> [options]

OPTIONS:
  --model <model>   Model performing the review (required)
  --notes <text>    Rejection reason (important for coder)
  -j, --json        Output as JSON
  -h, --help        Show help
`);
    return;
  }

  if (!values.model) {
    console.error('Error: --model required');
    process.exit(1);
  }

  const identifier = positionals[0];

  const { db, close } = openDatabase();
  try {
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }

    if (!task) {
      console.error(`Task not found: ${identifier}`);
      process.exit(1);
    }

    const result = rejectTask(db, task.id, values.model, values.notes);

    if (values.json) {
      console.log(JSON.stringify({ task, result }, null, 2));
    } else {
      if (result.status === 'failed') {
        console.log(`Task FAILED: ${task.title}`);
        console.log(`  Exceeded 15 rejections. Requires human intervention.`);
      } else {
        console.log(`Task rejected: ${task.title}`);
        console.log(`  Status: in_progress (rejection ${result.rejectionCount}/15)`);
        console.log(`  Reviewer: ${values.model}`);
        if (values.notes) {
          console.log(`  Notes: ${values.notes}`);
        }
      }
    }
  } finally {
    close();
  }
}

async function skipTaskCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      model: { type: 'string' },
      notes: { type: 'string' },
      partial: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids tasks skip <id> - Skip a task (external setup required)

USAGE:
  steroids tasks skip <id> [options]

OPTIONS:
  --model <model>   Model identifying the skip (required for LLM actors)
  --notes <text>    Reason for skipping (e.g., "Cloud SQL - marked SKIP in spec")
  --partial         Mark as partial (coded what we could, rest is external)
  -j, --json        Output as JSON
  -h, --help        Show help

DESCRIPTION:
  Use this when a task requires external/manual setup that cannot be automated:
  - Cloud infrastructure (Cloud SQL, GKE, etc.)
  - Manual account creation
  - License procurement
  - Hardware setup

  The task spec should indicate "SKIP" or "MANUAL" for these tasks.

  --partial: Use when you've implemented what you can, but the rest requires
             external action (e.g., created deployment YAML but can't provision).

EXAMPLES:
  steroids tasks skip abc123 --notes "Cloud SQL - spec says SKIP"
  steroids tasks skip abc123 --partial --notes "Created deployment, needs manual GKE setup"
`);
    return;
  }

  const identifier = positionals[0];
  const newStatus = values.partial ? 'partial' : 'skipped';

  const { db, close } = openDatabase();
  try {
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }

    if (!task) {
      console.error(`Task not found: ${identifier}`);
      process.exit(1);
    }

    const actor = values.model
      ? `model:${values.model}`
      : 'human:cli';

    // Get section name before updating
    const section = task.section_id ? getSection(db, task.section_id) : null;
    const sectionName = section?.name ?? null;
    const taskTitle = task.title;

    updateTaskStatus(db, task.id, newStatus as TaskStatus, actor, values.notes as string | undefined);

    // Refresh task to get updated status
    task = getTask(db, task.id)!;

    // Log activity for skipped/partial task
    const projectPath = resolve(process.cwd());
    logActivity(
      projectPath,
      'cli',  // CLI operations use 'cli' as runner ID
      task.id,
      taskTitle,
      sectionName,
      values.partial ? 'partial' : 'skipped'
    );

    if (values.json) {
      console.log(JSON.stringify({ task, skipped: true, partial: values.partial }, null, 2));
    } else {
      const statusLabel = values.partial ? 'PARTIAL' : 'SKIPPED';
      console.log(`Task ${statusLabel}: ${task.title}`);
      console.log(`  Status: ${newStatus}`);
      console.log(`  Actor: ${actor}`);
      if (values.notes) {
        console.log(`  Notes: ${values.notes}`);
      }
      console.log('');
      console.log('  Task will not block the runner. Move on to the next task.');
    }
  } finally {
    close();
  }
}

async function auditTask(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids tasks audit <id> - View task audit trail

USAGE:
  steroids tasks audit <id> [options]

OPTIONS:
  -j, --json        Output as JSON
  -h, --help        Show help
`);
    return;
  }

  const identifier = positionals[0];

  const { db, close } = openDatabase();
  try {
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }

    if (!task) {
      console.error(`Task not found: ${identifier}`);
      process.exit(1);
    }

    const entries = getTaskAudit(db, task.id);

    if (values.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    console.log(`Audit trail for: ${task.title}`);
    console.log(`Task ID: ${task.id}`);
    console.log('─'.repeat(80));
    console.log('TIMESTAMP            FROM         TO           ACTOR              NOTES');
    console.log('─'.repeat(80));

    for (const entry of entries) {
      const ts = entry.created_at.substring(0, 19).replace('T', ' ');
      const from = (entry.from_status ?? '-').padEnd(12);
      const to = entry.to_status.padEnd(12);
      const actor = entry.actor.padEnd(18);
      const notes = entry.notes ?? '-';
      console.log(`${ts}  ${from} ${to} ${actor} ${notes}`);
    }
  } finally {
    close();
  }
}
