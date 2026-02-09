import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids tasks - Manage tasks
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
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
  listSections,
  getTaskInvocations,
  getRecentTaskInvocations,
  getInvocationCount,
  getOrCreateFeedbackSection,
  STATUS_MARKERS,
  type Task,
  type TaskStatus,
  type TaskInvocation,
} from '../database/queries.js';
import { outputJson as outputEnvelope, outputJsonError, createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';
import { generateHelp } from '../cli/help.js';
import {
  shouldSkipHooks,
  triggerTaskCreated,
  triggerTaskUpdated,
  triggerTaskCompleted,
  triggerTaskFailed,
  triggerSectionCompleted,
  triggerProjectCompleted,
  triggerHooksSafely,
} from '../hooks/integration.js';
import {
  isFileTracked,
  isFileDirty,
  getFileLastCommit,
  getFileContentHash,
} from '../git/status.js';

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
    { name: 'show', args: '<id|title>', description: 'Show task details with invocation logs' },
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
    { long: 'file', description: 'Anchor task to a committed file (add subcommand)', values: '<path>' },
    { long: 'line', description: 'Line number in anchored file (requires --file)', values: '<number>' },
    { long: 'feedback', description: 'Add to "Needs User Input" section (skipped, for human review)' },
    { long: 'partial', description: 'Mark as partial when skipping' },
    { long: 'no-hooks', description: 'Skip hook execution (global flag)' },
  ],
  examples: [
    { command: 'steroids tasks', description: 'List pending tasks' },
    { command: 'steroids tasks --status all', description: 'List all tasks' },
    { command: 'steroids tasks --status active', description: 'Show active tasks (in_progress + review)' },
    { command: 'steroids tasks --status skipped', description: 'See what needs manual action' },
    { command: 'steroids tasks --global --json', description: 'List tasks from all projects as JSON' },
    { command: 'steroids tasks add "Implement login" --section abc123 --source docs/spec.md', description: 'Add new task' },
    { command: 'steroids tasks add "Fix bug" --section abc123 --source spec.md --file src/utils.ts --line 42', description: 'Add task anchored to a file' },
    { command: 'steroids tasks add "Review execSync usage" --feedback', description: 'Add feedback task (skipped section)' },
    { command: 'steroids tasks update "Implement login" --status review', description: 'Update task status' },
    { command: 'steroids tasks approve abc123 --model claude-sonnet-4', description: 'Approve a task' },
    { command: 'steroids tasks approve abc123 --no-hooks', description: 'Approve without triggering hooks' },
    { command: 'steroids tasks reject abc123 --model codex --notes "Missing tests"', description: 'Reject a task' },
    { command: 'steroids tasks skip abc123 --notes "Cloud SQL - manual setup"', description: 'Skip a task' },
    { command: 'steroids tasks audit abc123', description: 'View task history' },
    { command: 'steroids tasks show abc123 --logs', description: 'Show task with LLM invocation logs' },
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
    case 'show':
      await showTask(subArgs, flags);
      break;
    case 'add':
      await addTask(subArgs, flags);
      break;
    case 'update':
      await updateTask(subArgs, flags);
      break;
    case 'approve':
      await approveTaskCmd(subArgs, flags);
      break;
    case 'reject':
      await rejectTaskCmd(subArgs, flags);
      break;
    case 'skip':
      await skipTaskCmd(subArgs, flags);
      break;
    case 'audit':
      await auditTask(subArgs, flags);
      break;
    case 'list':
      await listAllTasks(subArgs, flags);
      break;
    default:
      if (flags.json) {
        outputJsonError('tasks', subcommand, ErrorCode.INVALID_ARGUMENTS, `Unknown subcommand: ${subcommand}`);
      } else {
        console.error(`Unknown subcommand: ${subcommand}`);
        console.log(HELP);
      }
      process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
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
        if (outputJson) {
          outputJsonError('tasks', 'list', ErrorCode.SECTION_NOT_FOUND, `Section not found: ${values.section}`, {
            sectionId: values.section,
            hint: 'Use "steroids sections list" to see available sections.',
          });
        } else {
          console.error(`Section not found: ${values.section}`);
          console.error('Use "steroids sections list" to see available sections.');
        }
        process.exit(getExitCode(ErrorCode.SECTION_NOT_FOUND));
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

async function showTask(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'show', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      logs: { type: 'boolean', default: false },
      'logs-full': { type: 'boolean', default: false },
      limit: { type: 'string', default: '5' },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids tasks show <id|title> - Show task details with invocation logs

USAGE:
  steroids tasks show <id|title> [options]

OPTIONS:
  --logs              Show LLM invocation history (prompts/responses)
  --logs-full         Show full prompts and responses (verbose)
  --limit <n>         Limit number of invocations shown (default: 5)
  -h, --help          Show help

DESCRIPTION:
  Shows detailed information about a task including:
  - Task metadata (ID, title, status, section, spec file)
  - Rejection count and history
  - LLM invocation logs (with --logs flag)

EXAMPLES:
  steroids tasks show abc123                   # Basic task info
  steroids tasks show abc123 --logs            # Include LLM invocation summary
  steroids tasks show abc123 --logs-full       # Full prompts and responses
  steroids tasks show abc123 --logs --limit 10 # Show last 10 invocations
`);
    return;
  }

  const identifier = positionals[0];
  const showLogs = values.logs || values['logs-full'];
  const showFullLogs = values['logs-full'];
  const limit = parseInt(values.limit as string, 10) || 5;

  const { db, close } = openDatabase();
  try {
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }

    if (!task) {
      out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
      process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
    }

    // Get section info
    const section = task.section_id ? getSection(db, task.section_id) : null;

    // Get invocation counts
    const invocationCounts = getInvocationCount(db, task.id);

    // Get invocations if requested
    let invocations: TaskInvocation[] = [];
    if (showLogs) {
      invocations = getRecentTaskInvocations(db, task.id, limit);
    }

    // Get audit trail for rejection history
    const auditEntries = getTaskAudit(db, task.id);

    if (flags.json) {
      out.success({
        task,
        section: section ? { id: section.id, name: section.name } : null,
        invocationCounts,
        invocations: showLogs ? invocations : undefined,
        auditTrail: auditEntries,
      });
      return;
    }

    // Display task details
    console.log('─'.repeat(80));
    console.log('TASK DETAILS');
    console.log('─'.repeat(80));
    console.log(`ID:              ${task.id}`);
    console.log(`Title:           ${task.title}`);
    console.log(`Status:          ${STATUS_MARKERS[task.status]} ${task.status}`);
    console.log(`Section:         ${section ? section.name : '(none)'}`);
    console.log(`Spec File:       ${task.source_file ?? '(not set)'}`);
    if (task.file_path) {
      const lineStr = task.file_line ? `:${task.file_line}` : '';
      console.log(`File Anchor:     ${task.file_path}${lineStr}`);
      console.log(`File Commit:     ${task.file_commit_sha?.substring(0, 7) ?? '(unknown)'}`);
      console.log(`Content Hash:    ${task.file_content_hash?.substring(0, 12) ?? '(unknown)'}`);
    }
    console.log(`Rejections:      ${task.rejection_count}/15`);
    console.log(`Created:         ${task.created_at}`);
    console.log(`Updated:         ${task.updated_at}`);
    console.log('');
    console.log(`Invocations:     ${invocationCounts.coder} coder, ${invocationCounts.reviewer} reviewer (${invocationCounts.total} total)`);
    console.log('─'.repeat(80));

    if (showLogs && invocations.length > 0) {
      console.log('');
      console.log('LLM INVOCATIONS (most recent)');
      console.log('─'.repeat(80));

      for (const inv of invocations) {
        const ts = inv.created_at.substring(0, 19).replace('T', ' ');
        const status = inv.success ? 'OK' : (inv.timed_out ? 'TIMEOUT' : 'FAIL');
        const duration = (inv.duration_ms / 1000).toFixed(1) + 's';
        const rejNum = inv.rejection_number ? ` (rejection #${inv.rejection_number})` : '';

        console.log(`\n[${ts}] ${inv.role.toUpperCase()} - ${inv.provider}/${inv.model} - ${status} - ${duration}${rejNum}`);

        if (showFullLogs) {
          console.log('\n--- PROMPT ---');
          console.log(inv.prompt.substring(0, 5000) + (inv.prompt.length > 5000 ? '\n\n[...truncated...]' : ''));
          console.log('\n--- RESPONSE ---');
          const response = inv.response || '(no response)';
          console.log(response.substring(0, 3000) + (response.length > 3000 ? '\n\n[...truncated...]' : ''));
          if (inv.error) {
            console.log('\n--- ERROR ---');
            console.log(inv.error.substring(0, 1000));
          }
        } else {
          // Summary view
          const promptLines = inv.prompt.split('\n').length;
          const responseLines = (inv.response || '').split('\n').length;
          console.log(`  Prompt: ${promptLines} lines, ${inv.prompt.length} chars`);
          console.log(`  Response: ${responseLines} lines, ${(inv.response || '').length} chars`);
          if (inv.error) {
            console.log(`  Error: ${inv.error.substring(0, 100)}...`);
          }
        }
      }

      console.log('');
      console.log('─'.repeat(80));
      console.log(`Tip: Use --logs-full to see complete prompts and responses`);
    } else if (showLogs && invocations.length === 0) {
      console.log('');
      console.log('No invocations recorded for this task yet.');
      console.log('Invocations are recorded when coder/reviewer processes run.');
    }

    if (!showLogs && invocationCounts.total > 0) {
      console.log('');
      console.log(`Tip: Use --logs to see invocation history, --logs-full for full prompts`);
    }
  } finally {
    close();
  }
}

async function addTask(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'add', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      section: { type: 'string' },
      source: { type: 'string' },
      file: { type: 'string' },
      line: { type: 'string' },
      feedback: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    out.log(`
steroids tasks add <title> - Add a new task

USAGE:
  steroids tasks add <title> --section <id> --source <file> [options]
  steroids tasks add <title> --feedback [--file <path> --line <n>]

OPTIONS:
  --section <id>        Section ID (required unless --feedback)
  --source <file>       Specification file (required unless --feedback)
  --feedback            Add to "Needs User Input" section (skipped, for human review)
  --file <path>         Anchor task to a committed file
  --line <number>       Line number in the anchored file (requires --file)
  -h, --help            Show help

EXAMPLES:
  steroids tasks add "Implement login" --section abc123 --source docs/login-spec.md
  steroids tasks add "Fix null check" --section abc123 --source spec.md --file src/utils.ts --line 42
  steroids tasks add "Pre-existing execSync in queries.ts needs review" --feedback
  steroids tasks add "Should we use Redis or in-memory cache?" --feedback
`);
    return;
  }

  if (positionals.length === 0) {
    out.error(ErrorCode.INVALID_ARGUMENTS, 'task title required', {
      usage: 'steroids tasks add <title> --section <id> --source <file>',
    });
    process.exit(2);
  }

  if (!values.feedback && !values.section) {
    out.error(ErrorCode.INVALID_ARGUMENTS, '--section <id> is required (or use --feedback)', {
      usage: 'steroids tasks add <title> --section <id> --source <file>',
      hint: 'Every task must belong to a section. Use --feedback for advisory items.',
    });
    process.exit(2);
  }

  if (!values.feedback && !values.source) {
    out.error(ErrorCode.INVALID_ARGUMENTS, '--source <file> is required (or use --feedback)', {
      usage: 'steroids tasks add <title> --section <id> --source <file>',
      hint: 'Every task must reference a specification file. Use --feedback for advisory items.',
    });
    process.exit(2);
  }

  // Validate --line requires --file
  if (values.line && !values.file) {
    out.error(ErrorCode.INVALID_ARGUMENTS, '--line requires --file', {
      usage: 'steroids tasks add <title> --file <path> --line <number>',
      hint: 'You cannot specify a line number without a file.',
    });
    process.exit(2);
  }

  // Parse and validate line number
  let fileLine: number | undefined;
  if (values.line) {
    fileLine = parseInt(values.line, 10);
    if (isNaN(fileLine) || fileLine < 1) {
      out.error(ErrorCode.INVALID_ARGUMENTS, '--line must be a positive integer', {
        provided: values.line,
      });
      process.exit(2);
    }
  }

  // Resolve file anchor if --file is provided
  let filePath: string | undefined;
  let fileCommitSha: string | undefined;
  let fileContentHash: string | undefined;

  if (values.file) {
    const fullPath = resolve(process.cwd(), values.file);
    const normalizedPath = relative(process.cwd(), fullPath);

    if (normalizedPath.startsWith('..')) {
      out.error(ErrorCode.INVALID_ARGUMENTS, `File is outside the project directory: ${values.file}`, {
        file: values.file,
        hint: 'The file must be within the project directory.',
      });
      process.exit(2);
    }

    if (!existsSync(fullPath)) {
      out.error(ErrorCode.INVALID_ARGUMENTS, `File not found: ${normalizedPath}`, {
        file: normalizedPath,
        hint: 'The file must exist in the project directory.',
      });
      process.exit(2);
    }

    if (!isFileTracked(normalizedPath)) {
      out.error(ErrorCode.INVALID_ARGUMENTS, `File is not tracked by git: ${normalizedPath}`, {
        file: normalizedPath,
        hint: 'The file must be committed to the repository. Run: git add && git commit',
      });
      process.exit(2);
    }

    if (isFileDirty(normalizedPath)) {
      out.error(ErrorCode.INVALID_ARGUMENTS, `File has uncommitted changes: ${normalizedPath}`, {
        file: normalizedPath,
        hint: 'Commit your changes before anchoring a task to this file.',
      });
      process.exit(2);
    }

    filePath = normalizedPath;
    fileCommitSha = getFileLastCommit(normalizedPath) ?? undefined;
    fileContentHash = getFileContentHash(normalizedPath) ?? undefined;
  }

  const title = positionals.join(' ');

  const { db, close } = openDatabase();
  try {
    let section;
    if (values.feedback) {
      section = getOrCreateFeedbackSection(db);
    } else {
      section = getSection(db, values.section as string);
      if (!section) {
        out.error(ErrorCode.SECTION_NOT_FOUND, `Section not found: ${values.section}`, {
          sectionId: values.section,
          hint: 'Use "steroids sections list" to see available sections.',
        });
        process.exit(1);
      }
    }

    const task = createTask(db, title, {
      sectionId: section.id,
      sourceFile: values.source ?? undefined,
      filePath,
      fileLine,
      fileCommitSha,
      fileContentHash,
    });

    // Trigger task.created hooks
    if (!shouldSkipHooks(flags)) {
      await triggerHooksSafely(
        () => triggerTaskCreated(task, { verbose: flags.verbose }),
        { verbose: flags.verbose }
      );
    }

    out.success({ task, feedback: !!values.feedback });
    if (!flags.json) {
      out.log(`Task created: ${task.title}`);
      out.log(`  ID: ${task.id}`);
      out.log(`  Status: ${task.status}`);
      if (values.feedback) {
        out.log(`  Section: Needs User Input (skipped - for human review)`);
      }
      if (task.source_file) {
        out.log(`  Source: ${task.source_file}`);
      }
      if (task.file_path) {
        const lineStr = task.file_line ? `:${task.file_line}` : '';
        out.log(`  File: ${task.file_path}${lineStr}`);
        out.log(`  Commit: ${task.file_commit_sha?.substring(0, 7) ?? 'unknown'}`);
      }
    }
  } finally {
    close();
  }
}

async function updateTask(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'update', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      status: { type: 'string' },
      actor: { type: 'string', default: 'human:cli' },
      model: { type: 'string' },
      notes: { type: 'string' },
      'reset-rejections': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids tasks update <title|id> - Update task status

USAGE:
  steroids tasks update <title|id> [options]

OPTIONS:
  --status <status>     New status: pending | in_progress | review | completed
  --reset-rejections    Reset rejection count to 0 (keeps audit history)
  --actor <actor>       Actor making the change (default: human:cli)
  --model <model>       Model identifier (for LLM actors)
  --notes <text>        Notes for the reviewer (useful when submitting for review)
  -h, --help            Show help

EXAMPLES:
  steroids tasks update abc123 --status review
  steroids tasks update abc123 --status pending --reset-rejections
  steroids tasks update abc123 --status review --notes "Found existing implementation at commit xyz"
`);
    return;
  }

  if (!values.status && !values['reset-rejections']) {
    if (flags.json) {
      out.error(ErrorCode.INVALID_ARGUMENTS, '--status or --reset-rejections required');
    } else {
      console.error('Error: --status or --reset-rejections required');
    }
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
      if (flags.json) {
        out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
      } else {
        console.error(`Task not found: ${identifier}`);
      }
      process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
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
    const previousStatus = task.status;
    if (values.status) {
      updateTaskStatus(db, task.id, values.status as TaskStatus, actor, values.notes as string | undefined);
    }

    const updated = getTask(db, task.id);

    // Trigger task.updated hooks
    if (!shouldSkipHooks(flags) && updated) {
      await triggerHooksSafely(
        () => triggerTaskUpdated(updated, previousStatus, { verbose: flags.verbose }),
        { verbose: flags.verbose }
      );
    }

    if (flags.json) {
      out.success({ task: updated, rejectionReset: oldRejectionCount !== undefined, oldRejectionCount });
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

/**
 * Check if a section is completed after a task is marked complete
 */
async function checkSectionCompletion(
  db: Database.Database,
  sectionId: string | null,
  flags: GlobalFlags
): Promise<void> {
  if (!sectionId || shouldSkipHooks(flags)) {
    return;
  }

  // Get section info
  const section = getSection(db, sectionId);
  if (!section) {
    return;
  }

  // Check if all tasks in section are completed
  const sectionTasks = listTasks(db, { sectionId });
  const allCompleted = sectionTasks.every((t) => t.status === 'completed');

  if (allCompleted && sectionTasks.length > 0) {
    // Trigger section.completed hooks
    await triggerHooksSafely(
      () =>
        triggerSectionCompleted(
          {
            id: section.id,
            name: section.name,
            taskCount: sectionTasks.length,
          },
          sectionTasks.map((t) => ({ id: t.id, title: t.title })),
          { verbose: flags.verbose }
        ),
      { verbose: flags.verbose }
    );
  }
}

/**
 * Check if the entire project is completed after a task is marked complete
 */
async function checkProjectCompletion(
  db: Database.Database,
  flags: GlobalFlags
): Promise<void> {
  if (shouldSkipHooks(flags)) {
    return;
  }

  // Get all tasks
  const allTasks = listTasks(db, { status: 'all' });

  // Check if all tasks are completed
  const allCompleted = allTasks.every((t) => t.status === 'completed');

  if (allCompleted && allTasks.length > 0) {
    // Get sections
    const sections = listSections(db);

    // Get unique source files
    const files = Array.from(new Set(allTasks.map((t) => t.source_file).filter(Boolean))) as string[];

    // Trigger project.completed hooks
    await triggerHooksSafely(
      () =>
        triggerProjectCompleted(
          {
            totalTasks: allTasks.length,
            files,
            sectionCount: sections.length,
          },
          { verbose: flags.verbose }
        ),
      { verbose: flags.verbose }
    );
  }
}

async function approveTaskCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'approve', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      model: { type: 'string' },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids tasks approve <id> - Approve a task

USAGE:
  steroids tasks approve <id> [options]

OPTIONS:
  --model <model>   Model performing the review (required)
  --notes <text>    Approval notes
  -h, --help        Show help
`);
    return;
  }

  if (!values.model) {
    out.error(ErrorCode.INVALID_ARGUMENTS, '--model required');
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
      out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
      process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
    }

    approveTask(db, task.id, values.model, values.notes);

    const updated = getTask(db, task.id);

    // Trigger task.completed hooks
    if (!shouldSkipHooks(flags) && updated) {
      await triggerHooksSafely(
        () => triggerTaskCompleted(updated, { verbose: flags.verbose }),
        { verbose: flags.verbose }
      );

      // Check if section is now complete
      await checkSectionCompletion(db, updated.section_id, flags);

      // Check if entire project is now complete
      await checkProjectCompletion(db, flags);
    }

    out.success({ task: updated });
    if (!flags.json) {
      out.log(`Task approved: ${task.title}`);
      out.log(`  Status: completed`);
      out.log(`  Reviewer: ${values.model}`);
    }
  } finally {
    close();
  }
}

async function rejectTaskCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'reject', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      model: { type: 'string' },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids tasks reject <id> - Reject a task

USAGE:
  steroids tasks reject <id> [options]

OPTIONS:
  --model <model>   Model performing the review (required)
  --notes <text>    Rejection reason (important for coder)
  -h, --help        Show help
`);
    return;
  }

  if (!values.model) {
    out.error(ErrorCode.INVALID_ARGUMENTS, '--model required');
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
      out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
      process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
    }

    const result = rejectTask(db, task.id, values.model, values.notes);

    // Trigger task.failed hooks if task failed
    if (result.status === 'failed') {
      const failedTask = getTask(db, task.id);
      if (!shouldSkipHooks(flags) && failedTask) {
        await triggerHooksSafely(
          () => triggerTaskFailed(failedTask, 15, { verbose: flags.verbose }),
          { verbose: flags.verbose }
        );
      }
    }

    out.success({ task, result });
    if (!flags.json) {
      if (result.status === 'failed') {
        out.log(`Task FAILED: ${task.title}`);
        out.log(`  Exceeded 15 rejections. Requires human intervention.`);
      } else {
        out.log(`Task rejected: ${task.title}`);
        out.log(`  Status: in_progress (rejection ${result.rejectionCount}/15)`);
        out.log(`  Reviewer: ${values.model}`);
        if (values.notes) {
          out.log(`  Notes: ${values.notes}`);
        }
      }
    }
  } finally {
    close();
  }
}

async function skipTaskCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'skip', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      model: { type: 'string' },
      notes: { type: 'string' },
      partial: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids tasks skip <id> - Skip a task (external setup required)

USAGE:
  steroids tasks skip <id> [options]

OPTIONS:
  --model <model>   Model identifying the skip (required for LLM actors)
  --notes <text>    Reason for skipping (e.g., "Cloud SQL - marked SKIP in spec")
  --partial         Mark as partial (coded what we could, rest is external)
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
      out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
      process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
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

    out.success({ task, skipped: true, partial: values.partial });
    if (!flags.json) {
      const statusLabel = values.partial ? 'PARTIAL' : 'SKIPPED';
      out.log(`Task ${statusLabel}: ${task.title}`);
      out.log(`  Status: ${newStatus}`);
      out.log(`  Actor: ${actor}`);
      if (values.notes) {
        out.log(`  Notes: ${values.notes}`);
      }
      out.log('');
      out.log('  Task will not block the runner. Move on to the next task.');
    }
  } finally {
    close();
  }
}

async function auditTask(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'audit', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || positionals.length === 0) {
    out.log(`
steroids tasks audit <id> - View task audit trail

USAGE:
  steroids tasks audit <id> [options]

OPTIONS:
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
      out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
      process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
    }

    const entries = getTaskAudit(db, task.id);

    out.success({ task: { id: task.id, title: task.title }, auditTrail: entries });

    if (!flags.json) {
      out.log(`Audit trail for: ${task.title}`);
      out.log(`Task ID: ${task.id}`);
      out.log('─'.repeat(80));
      out.log('TIMESTAMP            FROM         TO           ACTOR              NOTES');
      out.log('─'.repeat(80));

      for (const entry of entries) {
        const ts = entry.created_at.substring(0, 19).replace('T', ' ');
        const from = (entry.from_status ?? '-').padEnd(12);
        const to = entry.to_status.padEnd(12);
        const actor = entry.actor.padEnd(18);
        const notes = entry.notes ?? '-';
        out.log(`${ts}  ${from} ${to} ${actor} ${notes}`);
      }
    }
  } finally {
    close();
  }
}
