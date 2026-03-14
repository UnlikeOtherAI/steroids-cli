import type { GlobalFlags } from '../cli/flags.js';
/**
 * Task dependency CLI commands: depends-on, no-depends-on
 */

import { parseArgs } from 'node:util';
import { withDatabase } from '../database/connection.js';
import {
  getTask,
  getTaskByTitle,
  addTaskDependency,
  removeTaskDependency,
  getTaskDependencies,
  STATUS_MARKERS,
} from '../database/queries.js';
import { createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';

/**
 * Resolve a task by ID prefix or title. Returns the task or exits with error.
 */
function resolveTask(db: any, identifier: string, out: ReturnType<typeof createOutput>): NonNullable<ReturnType<typeof getTask>> {
  let task = getTask(db, identifier);
  if (!task) {
    task = getTaskByTitle(db, identifier);
  }
  if (!task) {
    out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`, { identifier });
    process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
  }
  return task;
}

export async function addTaskDependencyCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'depends-on', flags });

  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids tasks depends-on <task-id> <depends-on-task-id> - Add task dependency

USAGE:
  steroids tasks depends-on <task-id> <depends-on-task-id>

ARGUMENTS:
  task-id              The task that depends on another
  depends-on-task-id   The task that must complete first

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids tasks depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    out.error(ErrorCode.INVALID_ARGUMENTS, 'Both task IDs required', {
      usage: 'steroids tasks depends-on <task-id> <depends-on-task-id>',
    });
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  const [taskIdInput, dependsOnIdInput] = positionals;

  if (flags.dryRun) {
    out.log(`Would add dependency: ${taskIdInput} depends on ${dependsOnIdInput}`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const task = resolveTask(db, taskIdInput, out);
    const depTask = resolveTask(db, dependsOnIdInput, out);

    try {
      const dependency = addTaskDependency(db, task.id, depTask.id);

      if (flags.json) {
        out.success({
          dependency: {
            task_id: dependency.task_id,
            depends_on_task_id: dependency.depends_on_task_id,
            task_title: task.title,
            depends_on_title: depTask.title,
          },
        });
      } else {
        out.log(`Dependency added: "${task.title}" depends on "${depTask.title}"`);
      }
    } catch (error: any) {
      out.error(ErrorCode.INVALID_ARGUMENTS, error.message, {
        taskId: task.id,
        dependsOnTaskId: depTask.id,
      });
      process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
    }
  });
}

export async function removeTaskDependencyCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'no-depends-on', flags });

  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids tasks no-depends-on <task-id> <depends-on-task-id> - Remove task dependency

USAGE:
  steroids tasks no-depends-on <task-id> <depends-on-task-id>

ARGUMENTS:
  task-id              The dependent task
  depends-on-task-id   The dependency to remove

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids tasks no-depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    out.error(ErrorCode.INVALID_ARGUMENTS, 'Both task IDs required', {
      usage: 'steroids tasks no-depends-on <task-id> <depends-on-task-id>',
    });
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  const [taskIdInput, dependsOnIdInput] = positionals;

  if (flags.dryRun) {
    out.log(`Would remove dependency: ${taskIdInput} no longer depends on ${dependsOnIdInput}`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const task = resolveTask(db, taskIdInput, out);
    const depTask = resolveTask(db, dependsOnIdInput, out);

    try {
      removeTaskDependency(db, task.id, depTask.id);

      if (flags.json) {
        out.success({
          removed: {
            task_id: task.id,
            depends_on_task_id: depTask.id,
            task_title: task.title,
            depends_on_title: depTask.title,
          },
        });
      } else {
        out.log(`Dependency removed: "${task.title}" no longer depends on "${depTask.title}"`);
      }
    } catch (error: any) {
      out.error(ErrorCode.INVALID_ARGUMENTS, error.message, {
        taskId: task.id,
        dependsOnTaskId: depTask.id,
      });
      process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
    }
  });
}

/**
 * Display task dependencies in audit/show output.
 * Returns the dependencies array for JSON inclusion.
 */
export function displayTaskDependencies(
  db: any,
  taskId: string,
  flags: GlobalFlags,
): ReturnType<typeof getTaskDependencies> {
  const deps = getTaskDependencies(db, taskId);

  if (deps.length > 0 && !flags.json) {
    console.log('');
    console.log('DEPENDENCIES (must complete first):');
    for (const dep of deps) {
      const marker = STATUS_MARKERS[dep.status] ?? '?';
      const shortId = dep.id.substring(0, 8);
      console.log(`  ${marker} ${shortId}  ${dep.title}  (${dep.status})`);
    }
  }

  return deps;
}
