import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids locks - Manage task and section locks
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import {
  listTaskLocks,
  listSectionLocks,
  getTaskLock,
  getSectionLock,
} from '../locking/queries.js';
import {
  forceRelease as forceReleaseTaskLock,
} from '../locking/task-lock.js';
import {
  forceRelease as forceReleaseSectionLock,
} from '../locking/section-lock.js';
import {
  cleanupAllExpiredLocks,
  formatCleanupResultJson,
} from '../locking/cleanup.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'locks',
  description: 'Manage task and section locks',
  details: 'View and manage locks that prevent concurrent work on tasks and sections. Locks are acquired by runners and expire automatically.',
  usage: [
    'steroids locks [options]',
    'steroids locks <subcommand> [args] [options]',
  ],
  subcommands: [
    { name: '(default)', description: 'List all locks' },
    { name: 'list', description: 'List all current locks' },
    { name: 'show', args: '<task_id|section_id>', description: 'Show details of a specific lock' },
    { name: 'release', args: '<task_id|section_id>', description: 'Force release a lock (admin only)' },
    { name: 'cleanup', description: 'Release all expired locks' },
  ],
  options: [
    { long: 'type', description: 'Filter by type (list)', values: 'task | section | all', default: 'all' },
    { long: 'force', description: 'Force release lock (required for release)' },
  ],
  examples: [
    { command: 'steroids locks', description: 'List all locks' },
    { command: 'steroids locks list --type task', description: 'List task locks only' },
    { command: 'steroids locks show abc123', description: 'Show lock details' },
    { command: 'steroids locks release abc123 --force', description: 'Force release a lock' },
    { command: 'steroids locks cleanup', description: 'Clean expired locks' },
    { command: 'steroids locks cleanup --dry-run', description: 'Preview cleanup without doing it' },
  ],
  related: [
    { command: 'steroids runners', description: 'Manage runners' },
    { command: 'steroids tasks', description: 'Manage tasks' },
  ],
  sections: [
    {
      title: 'EXIT CODES',
      content: `0  Success
4  Lock not found
5  Permission denied (missing --force)
6  Task/section is locked by another runner`,
    },
  ],
  showExitCodes: false,
});

export async function locksCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag first
  if (flags.help) {
    console.log(HELP);
    return;
  }

  if (args.length === 0) {
    await listLocks([], flags);
    return;
  }

  const subcommand = args[0];

  if (subcommand.startsWith('-')) {
    await listLocks(args, flags);
    return;
  }

  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      await listLocks(subArgs, flags);
      break;
    case 'show':
      await showLock(subArgs, flags);
      break;
    case 'release':
      await releaseLock(subArgs, flags);
      break;
    case 'cleanup':
      await cleanupLocks(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function listLocks(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      type: { type: 'string', default: 'all' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const taskLocks = values.type === 'section' ? [] : listTaskLocks(db);
    const sectionLocks = values.type === 'task' ? [] : listSectionLocks(db);

    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'locks',
        subcommand: 'list',
        data: {
          task_locks: taskLocks.map(lock => ({
            task_id: lock.task_id,
            runner_id: lock.runner_id,
            acquired_at: lock.acquired_at,
            expires_at: lock.expires_at,
            heartbeat_at: lock.heartbeat_at,
          })),
          section_locks: sectionLocks.map(lock => ({
            section_id: lock.section_id,
            runner_id: lock.runner_id,
            acquired_at: lock.acquired_at,
            expires_at: lock.expires_at,
          })),
        },
        error: null,
      }, null, 2));
      return;
    }

    const totalLocks = taskLocks.length + sectionLocks.length;

    if (totalLocks === 0) {
      console.log('No active locks found.');
      return;
    }

    if (taskLocks.length > 0) {
      console.log('TASK LOCKS');
      console.log('-'.repeat(80));
      console.log('TASK ID                               RUNNER ID                         EXPIRES');
      console.log('-'.repeat(80));

      for (const lock of taskLocks) {
        const taskId = lock.task_id.substring(0, 36).padEnd(36);
        const runnerId = lock.runner_id.substring(0, 32).padEnd(32);
        const expires = formatExpiry(lock.expires_at);
        console.log(`${taskId}  ${runnerId}  ${expires}`);
      }
      console.log();
    }

    if (sectionLocks.length > 0) {
      console.log('SECTION LOCKS');
      console.log('-'.repeat(80));
      console.log('SECTION ID                            RUNNER ID                         EXPIRES');
      console.log('-'.repeat(80));

      for (const lock of sectionLocks) {
        const sectionId = lock.section_id.substring(0, 36).padEnd(36);
        const runnerId = lock.runner_id.substring(0, 32).padEnd(32);
        const expires = formatExpiry(lock.expires_at);
        console.log(`${sectionId}  ${runnerId}  ${expires}`);
      }
      console.log();
    }

    console.log(`Total: ${taskLocks.length} task lock(s), ${sectionLocks.length} section lock(s)`);
  } finally {
    close();
  }
}

async function showLock(args: string[], flags: GlobalFlags): Promise<void> {
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
steroids locks show <id> - Show lock details

USAGE:
  steroids locks show <task_id|section_id> [options]

OPTIONS:
  -j, --json        Output as JSON
  -h, --help        Show help
`);
    return;
  }

  const id = positionals[0];

  const { db, close } = openDatabase();
  try {
    // Try task lock first, then section lock
    const taskLock = getTaskLock(db, id);
    const sectionLock = taskLock ? null : getSectionLock(db, id);

    if (!taskLock && !sectionLock) {
      if (values.json) {
        console.log(JSON.stringify({
          success: false,
          command: 'locks',
          subcommand: 'show',
          data: null,
          error: {
            code: 'LOCK_NOT_FOUND',
            message: 'Lock does not exist',
            details: { id },
          },
        }, null, 2));
      } else {
        console.error(`Lock not found: ${id}`);
      }
      process.exit(4);
    }

    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'locks',
        subcommand: 'show',
        data: {
          type: taskLock ? 'task' : 'section',
          lock: taskLock ?? sectionLock,
        },
        error: null,
      }, null, 2));
      return;
    }

    if (taskLock) {
      console.log('TASK LOCK');
      console.log('-'.repeat(40));
      console.log(`Task ID:     ${taskLock.task_id}`);
      console.log(`Runner ID:   ${taskLock.runner_id}`);
      console.log(`Acquired:    ${taskLock.acquired_at}`);
      console.log(`Expires:     ${taskLock.expires_at} (${formatExpiry(taskLock.expires_at)})`);
      console.log(`Heartbeat:   ${taskLock.heartbeat_at}`);
    } else if (sectionLock) {
      console.log('SECTION LOCK');
      console.log('-'.repeat(40));
      console.log(`Section ID:  ${sectionLock.section_id}`);
      console.log(`Runner ID:   ${sectionLock.runner_id}`);
      console.log(`Acquired:    ${sectionLock.acquired_at}`);
      console.log(`Expires:     ${sectionLock.expires_at} (${formatExpiry(sectionLock.expires_at)})`);
    }
  } finally {
    close();
  }
}

async function releaseLock(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids locks release <id> - Force release a lock

USAGE:
  steroids locks release <task_id|section_id> --force [options]

OPTIONS:
  --force           Required flag to confirm force release
  -j, --json        Output as JSON
  -h, --help        Show help

NOTE:
  Force releasing a lock may cause issues if a runner is still working.
  Only use this for stuck or zombie locks.
`);
    return;
  }

  if (!values.force) {
    if (values.json) {
      console.log(JSON.stringify({
        success: false,
        command: 'locks',
        subcommand: 'release',
        data: null,
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Use --force to confirm force release',
          details: { id: positionals[0] },
        },
      }, null, 2));
    } else {
      console.error('Error: Use --force to confirm force release');
      console.error('Force releasing may cause issues if a runner is still working.');
    }
    process.exit(5);
  }

  const id = positionals[0];

  const { db, close } = openDatabase();
  try {
    // Try task lock first, then section lock
    const taskLock = getTaskLock(db, id);
    const sectionLock = taskLock ? null : getSectionLock(db, id);

    if (!taskLock && !sectionLock) {
      if (values.json) {
        console.log(JSON.stringify({
          success: false,
          command: 'locks',
          subcommand: 'release',
          data: null,
          error: {
            code: 'LOCK_NOT_FOUND',
            message: 'Lock does not exist',
            details: { id },
          },
        }, null, 2));
      } else {
        console.error(`Lock not found: ${id}`);
      }
      process.exit(4);
    }

    if (taskLock) {
      forceReleaseTaskLock(db, id);
    } else {
      forceReleaseSectionLock(db, id);
    }

    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'locks',
        subcommand: 'release',
        data: {
          type: taskLock ? 'task' : 'section',
          id,
          released: true,
        },
        error: null,
      }, null, 2));
    } else {
      console.log(`Lock released: ${id}`);
      console.log(`  Type: ${taskLock ? 'task' : 'section'}`);
    }
  } finally {
    close();
  }
}

async function cleanupLocks(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids locks cleanup - Release all expired locks

USAGE:
  steroids locks cleanup [options]

OPTIONS:
  --dry-run         Show what would be cleaned without doing it
  -j, --json        Output as JSON
  -h, --help        Show help
`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    const result = cleanupAllExpiredLocks(db, { dryRun: values['dry-run'] });

    if (values.json) {
      console.log(JSON.stringify(formatCleanupResultJson(result), null, 2));
      return;
    }

    const totalFound = result.taskLocks.found + result.sectionLocks.found;
    const totalCleaned = result.taskLocks.cleaned + result.sectionLocks.cleaned;

    if (totalFound === 0) {
      console.log('No expired locks found.');
      return;
    }

    if (values['dry-run']) {
      console.log('DRY RUN - Would clean the following locks:');
      console.log();
    }

    if (result.taskLocks.found > 0) {
      console.log(`Task locks: ${result.taskLocks.found} expired`);
      for (const lock of result.taskLocks.locks) {
        console.log(`  - ${lock.task_id} (runner: ${lock.runner_id.substring(0, 8)}...)`);
      }
    }

    if (result.sectionLocks.found > 0) {
      console.log(`Section locks: ${result.sectionLocks.found} expired`);
      for (const lock of result.sectionLocks.locks) {
        console.log(`  - ${lock.section_id} (runner: ${lock.runner_id.substring(0, 8)}...)`);
      }
    }

    if (!values['dry-run']) {
      console.log();
      console.log(`Cleaned: ${totalCleaned} lock(s)`);
    }
  } finally {
    close();
  }
}

// ============ Helpers ============

function formatExpiry(expiresAt: string): string {
  const expiryTime = new Date(expiresAt).getTime();
  const now = Date.now();
  const diffMs = expiryTime - now;

  if (diffMs < 0) {
    return 'EXPIRED';
  }

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
