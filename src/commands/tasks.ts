/**
 * steroids tasks - Manage tasks
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import {
  createTask,
  listTasks,
  getTask,
  getTaskByTitle,
  updateTaskStatus,
  approveTask,
  rejectTask,
  getTaskAudit,
  getSectionByName,
  STATUS_MARKERS,
  type TaskStatus,
} from '../database/queries.js';

const HELP = `
steroids tasks - Manage tasks

USAGE:
  steroids tasks [options]
  steroids tasks add <title> [options]
  steroids tasks update <title|id> [options]
  steroids tasks approve <id> [options]
  steroids tasks reject <id> [options]
  steroids tasks audit <id>

SUBCOMMANDS:
  (none)            List tasks (default)
  add               Add a new task
  update            Update task status
  approve           Approve a task (mark completed)
  reject            Reject a task (back to in_progress)
  audit             View task audit trail

LIST OPTIONS:
  -s, --status      Filter: pending | in_progress | review | completed | all
  --section         Filter by section name
  --search          Search in task titles
  -j, --json        Output as JSON

ADD OPTIONS:
  --section         Add under section
  --source <file>   Specification file (REQUIRED)

UPDATE OPTIONS:
  --status          New status: pending | in_progress | review | completed
  --actor           Actor making the change
  --model           Model identifier (for LLM actors)

APPROVE/REJECT OPTIONS:
  --model           Model performing the review (required)
  --notes           Review notes/comments

STATUS MARKERS:
  [ ] pending       Not started
  [-] in_progress   Being worked on
  [o] review        Ready for review
  [x] completed     Approved
  [!] disputed      Disagreement logged
  [F] failed        Exceeded 15 rejections

EXAMPLES:
  steroids tasks
  steroids tasks --status all
  steroids tasks add "Implement login" --section "Phase 1"
  steroids tasks update "Implement login" --status review
  steroids tasks approve abc123 --model claude-sonnet-4
  steroids tasks reject abc123 --model codex --notes "Missing tests"
`;

export async function tasksCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    // Default: list pending tasks
    await listAllTasks([]);
    return;
  }

  if (args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  // Check if first arg is a subcommand or a flag
  const subcommand = args[0];

  if (subcommand.startsWith('-')) {
    // It's a flag, so this is a list command
    await listAllTasks(args);
    return;
  }

  const subArgs = args.slice(1);

  switch (subcommand) {
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
    case 'audit':
      await auditTask(subArgs);
      break;
    case 'list':
      await listAllTasks(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function listAllTasks(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      status: { type: 'string', short: 's', default: 'pending' },
      section: { type: 'string' },
      search: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const { db, close } = openDatabase();
  try {
    let sectionId: string | undefined;

    if (values.section) {
      const section = getSectionByName(db, values.section);
      if (!section) {
        console.error(`Section not found: ${values.section}`);
        process.exit(1);
      }
      sectionId = section.id;
    }

    const tasks = listTasks(db, {
      status: values.status as TaskStatus | 'all',
      sectionId,
      search: values.search,
    });

    if (values.json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    if (tasks.length === 0) {
      console.log(`No ${values.status} tasks found.`);
      return;
    }

    console.log('TASKS');
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
  steroids tasks add <title> --source <file> [options]

OPTIONS:
  --source <file>       Specification file (REQUIRED)
  --section <name>      Add under section
  -j, --json            Output as JSON
  -h, --help            Show help

EXAMPLES:
  steroids tasks add "Implement login" --source docs/login-spec.md
  steroids tasks add "Fix bug" --source tmp/build-phases/02-CONFIGURATION.md --section "Phase 2"
`);
    return;
  }

  if (positionals.length === 0) {
    console.error('Error: task title required');
    console.error('Usage: steroids tasks add <title> --source <file>');
    process.exit(2);
  }

  if (!values.source) {
    console.error('Error: --source <file> is required');
    console.error('Every task must reference a specification file.');
    console.error('Usage: steroids tasks add <title> --source <file>');
    process.exit(2);
  }

  const title = positionals.join(' ');

  const { db, close } = openDatabase();
  try {
    let sectionId: string | undefined;

    if (values.section) {
      const section = getSectionByName(db, values.section);
      if (!section) {
        console.error(`Section not found: ${values.section}`);
        process.exit(1);
      }
      sectionId = section.id;
    }

    const task = createTask(db, title, {
      sectionId,
      sourceFile: values.source,
    });

    if (values.json) {
      console.log(JSON.stringify(task, null, 2));
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
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids tasks update <title|id> - Update task status

USAGE:
  steroids tasks update <title|id> [options]

OPTIONS:
  --status <status>   New status: pending | in_progress | review | completed
  --actor <actor>     Actor making the change (default: human:cli)
  --model <model>     Model identifier (for LLM actors)
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  if (!values.status) {
    console.error('Error: --status required');
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

    updateTaskStatus(db, task.id, values.status as TaskStatus, actor);

    const updated = getTask(db, task.id);

    if (values.json) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(`Task updated: ${task.title}`);
      console.log(`  Status: ${task.status} → ${values.status}`);
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
