import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids git - Git integration commands
 *
 * Subcommands:
 * - status: Show git status with task context
 * - push: Push with retry logic
 * - retry: Retry failed push
 * - log: Show commit log with task links
 */

import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isGitRepo, getGitStatus, hasUncommittedChanges } from '../git/status.js';
import { openDatabase, isInitialized } from '../database/connection.js';
import { getTask, listTasks } from '../database/queries.js';
import { generateHelp } from '../cli/help.js';

const STEROIDS_DIR = '.steroids';
const PUSH_STATE_FILE = 'push-state.json';

interface PushState {
  lastAttempt: string;
  attempts: number;
  lastError: string | null;
  pending: boolean;
}

const HELP = generateHelp({
  command: 'git',
  description: 'Git integration commands',
  details: 'Enhanced git commands with task context, retry logic, and push state tracking.',
  usage: [
    'steroids git <subcommand> [options]',
  ],
  subcommands: [
    { name: 'status', description: 'Show git status with task context' },
    { name: 'push', description: 'Push with retry logic' },
    { name: 'retry', description: 'Retry failed push' },
    { name: 'log', description: 'Show commit log with task links' },
  ],
  options: [
    { long: 'full', description: 'Show full status output (status)' },
    { long: 'force', description: 'Force push (use with caution) (push)' },
    { long: 'retries', description: 'Number of retry attempts (push)', values: '<n>', default: '3' },
    { long: 'limit', description: 'Number of commits to show (log)', values: '<n>', default: '10' },
    { long: 'with-tasks', description: 'Only show commits with task references (log)' },
  ],
  examples: [
    { command: 'steroids git status', description: 'Show git status with current task' },
    { command: 'steroids git status --full', description: 'Show full git status' },
    { command: 'steroids git push', description: 'Push with retry logic' },
    { command: 'steroids git push --force', description: 'Force push (use with caution)' },
    { command: 'steroids git retry', description: 'Retry failed push' },
    { command: 'steroids git log --limit 5', description: 'Show last 5 commits' },
    { command: 'steroids git log --with-tasks', description: 'Show commits with task references' },
  ],
  related: [
    { command: 'steroids tasks', description: 'Manage tasks' },
    { command: 'steroids loop', description: 'Run automation loop' },
  ],
});

export async function gitCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'status':
      await gitStatus(subArgs);
      break;
    case 'push':
      await gitPush(subArgs);
      break;
    case 'retry':
      await gitRetry(subArgs);
      break;
    case 'log':
      await gitLog(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function gitStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      full: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids git status - Show git status with task context

USAGE:
  steroids git status [options]

OPTIONS:
  --full                Show full status output
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();

  if (!isGitRepo(projectPath)) {
    console.error('Not a git repository.');
    process.exit(1);
  }

  // Get current branch
  let branch = 'unknown';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    // Failed to get branch
  }

  // Check for uncommitted changes
  const isDirty = hasUncommittedChanges(projectPath);
  const status = isDirty ? 'dirty' : 'clean';

  // Get last push time
  let lastPush: string | null = null;
  try {
    const reflog = execSync('git reflog show origin/HEAD -1 --format=%ci', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (reflog) {
      lastPush = reflog;
    }
  } catch {
    // No reflog available
  }

  // Count pending pushes (commits ahead of origin)
  let pendingPushes = 0;
  try {
    const ahead = execSync(`git rev-list --count origin/${branch}..HEAD`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    pendingPushes = parseInt(ahead, 10) || 0;
  } catch {
    // No upstream tracking
  }

  // Get current task context
  let currentTask: { id: string; title: string } | null = null;
  if (isInitialized(projectPath)) {
    const { db, close } = openDatabase(projectPath);
    try {
      const tasks = listTasks(db, { status: 'in_progress' });
      if (tasks.length > 0) {
        currentTask = { id: tasks[0].id, title: tasks[0].title };
      }
    } finally {
      close();
    }
  }

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'git status',
      data: {
        branch,
        status,
        lastPush,
        pendingPushes,
        currentTask,
      },
      error: null,
    }, null, 2));
    return;
  }

  console.log(`Branch: ${branch}`);
  console.log(`Status: ${status}`);
  console.log(`Last push: ${lastPush || 'unknown'}`);
  console.log(`Pending pushes: ${pendingPushes}`);

  if (currentTask) {
    console.log(`\nCurrent task: ${currentTask.title}`);
    console.log(`  ID: ${currentTask.id.substring(0, 8)}`);
  }

  if (values.full) {
    console.log('\n--- Full Status ---');
    const fullStatus = getGitStatus(projectPath, { ignoreWorkspaceNoise: false });
    if (fullStatus) {
      console.log(fullStatus);
    } else {
      console.log('No changes.');
    }
  }
}

async function gitPush(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      force: { type: 'boolean', default: false },
      retries: { type: 'string', default: '3' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids git push - Push with retry logic

USAGE:
  steroids git push [options]

OPTIONS:
  --force               Force push (use with caution)
  --retries <n>         Number of retry attempts (default: 3)
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();

  if (!isGitRepo(projectPath)) {
    console.error('Not a git repository.');
    process.exit(1);
  }

  const maxRetries = parseInt(values.retries ?? '3', 10);
  const forceFlag = values.force ? '--force' : '';

  let success = false;
  let lastError: string | null = null;
  let attempts = 0;

  for (let i = 0; i < maxRetries; i++) {
    attempts++;
    try {
      const cmd = `git push ${forceFlag}`.trim();
      execSync(cmd, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: values.json ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      });
      success = true;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';

      if (i < maxRetries - 1) {
        // Wait before retry (exponential backoff)
        const delay = Math.pow(2, i) * 1000;
        if (!values.json) {
          console.log(`Push failed, retrying in ${delay / 1000}s...`);
        }
        await sleep(delay);
      }
    }
  }

  // Save push state
  savePushState(projectPath, {
    lastAttempt: new Date().toISOString(),
    attempts,
    lastError: success ? null : lastError,
    pending: !success,
  });

  if (values.json) {
    console.log(JSON.stringify({
      success,
      command: 'git push',
      data: {
        attempts,
        force: values.force ?? false,
      },
      error: success ? null : lastError,
    }, null, 2));
  } else {
    if (success) {
      console.log('\u2713 Push successful');
    } else {
      console.error(`\u2717 Push failed after ${attempts} attempts`);
      console.error(`  Error: ${lastError}`);
      console.error('  Run "steroids git retry" to try again.');
    }
  }

  if (!success) {
    process.exit(1);
  }
}

async function gitRetry(args: string[]): Promise<void> {
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
steroids git retry - Retry failed push

USAGE:
  steroids git retry [options]

OPTIONS:
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();

  if (!isGitRepo(projectPath)) {
    console.error('Not a git repository.');
    process.exit(1);
  }

  const state = loadPushState(projectPath);

  if (!state || !state.pending) {
    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'git retry',
        data: { message: 'No pending push to retry' },
        error: null,
      }, null, 2));
    } else {
      console.log('No pending push to retry.');
    }
    return;
  }

  console.log(`Last attempt: ${state.lastAttempt}`);
  console.log(`Previous attempts: ${state.attempts}`);
  console.log(`Last error: ${state.lastError}`);
  console.log('');

  // Attempt push again
  await gitPush(['--retries', '3', ...(values.json ? ['--json'] : [])]);
}

async function gitLog(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      limit: { type: 'string', default: '10' },
      'with-tasks': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids git log - Show commit log with task links

USAGE:
  steroids git log [options]

OPTIONS:
  --limit <n>           Number of commits to show (default: 10)
  --with-tasks          Only show commits with task references
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();

  if (!isGitRepo(projectPath)) {
    console.error('Not a git repository.');
    process.exit(1);
  }

  const limit = parseInt(values.limit ?? '10', 10);

  // Get commit log
  let commits: Array<{
    hash: string;
    date: string;
    message: string;
    taskId: string | null;
  }> = [];

  try {
    const log = execSync(
      `git log --format="%h|%ci|%s" -n ${limit * 2}`,
      {
        cwd: projectPath,
        encoding: 'utf-8',
      }
    ).trim();

    if (log) {
      const lines = log.split('\n');
      for (const line of lines) {
        const [hash, date, ...messageParts] = line.split('|');
        const message = messageParts.join('|');

        // Try to extract task ID from commit message
        // Look for patterns like: [abc123], task:abc123, (abc123)
        const taskMatch = message.match(/\[([a-f0-9]{6,8})\]|task:([a-f0-9]{6,8})|\(([a-f0-9]{6,8})\)/i);
        const taskId = taskMatch
          ? (taskMatch[1] || taskMatch[2] || taskMatch[3])
          : null;

        commits.push({
          hash,
          date: date.substring(0, 10), // Just the date part
          message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
          taskId,
        });
      }
    }
  } catch {
    console.error('Failed to get git log.');
    process.exit(1);
  }

  // Filter by task reference if requested
  if (values['with-tasks']) {
    commits = commits.filter(c => c.taskId !== null);
  }

  // Apply limit
  commits = commits.slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'git log',
      data: { commits },
      error: null,
    }, null, 2));
    return;
  }

  if (commits.length === 0) {
    console.log('No commits found.');
    return;
  }

  console.log('COMMIT    DATE        TASK      MESSAGE');
  console.log('\u2500'.repeat(70));

  for (const commit of commits) {
    const hash = commit.hash.padEnd(10);
    const date = commit.date.padEnd(12);
    const task = (commit.taskId || '-').padEnd(10);
    console.log(`${hash}${date}${task}${commit.message}`);
  }
}

function savePushState(projectPath: string, state: PushState): void {
  const steroidsDir = join(projectPath, STEROIDS_DIR);
  if (!existsSync(steroidsDir)) {
    return; // Steroids not initialized
  }

  const statePath = join(steroidsDir, PUSH_STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadPushState(projectPath: string): PushState | null {
  const statePath = join(projectPath, STEROIDS_DIR, PUSH_STATE_FILE);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
