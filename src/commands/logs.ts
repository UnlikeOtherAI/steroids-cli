/**
 * steroids logs - View invocation logs
 *
 * Subcommands:
 * - show: View logs for a specific task
 * - list: List log files
 * - tail: Tail logs in real-time
 * - purge: Purge old logs
 */

import { parseArgs } from 'node:util';
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  unlinkSync,
  rmSync,
  watch,
} from 'node:fs';
import { join, basename } from 'node:path';
import { openDatabase, isInitialized } from '../database/connection.js';
import { getTask, getTaskByTitle } from '../database/queries.js';

const STEROIDS_DIR = '.steroids';
const LOGS_DIR = 'logs';

interface LogFile {
  name: string;
  path: string;
  taskId: string | null;
  role: string | null;
  attempt: number | null;
  timestamp: Date;
  size: number;
}

const HELP = `
steroids logs - View invocation logs

USAGE:
  steroids logs <subcommand> [options]

SUBCOMMANDS:
  show <task-id>        View logs for a specific task
  list                  List log files
  tail                  Tail logs in real-time
  purge                 Purge old logs

SHOW OPTIONS:
  --full                Show complete output (no truncation)
  --attempt <n>         Show specific attempt number

LIST OPTIONS:
  --task <id>           Filter by task ID
  --role <role>         Filter by role: coder, reviewer

TAIL OPTIONS:
  --follow              Continue watching for new entries
  --lines <n>           Number of lines to show (default: 20)

PURGE OPTIONS:
  --older-than <dur>    Remove logs older than duration (e.g., 7d)
  --yes                 Skip confirmation prompt

EXAMPLES:
  steroids logs show a1b2c3d4
  steroids logs show a1b2c3d4 --full --attempt 2
  steroids logs list --task abc123 --role coder
  steroids logs tail --follow
  steroids logs purge --older-than 7d
`;

export async function logsCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'show':
      await showLogs(subArgs);
      break;
    case 'list':
      await listLogs(subArgs);
      break;
    case 'tail':
      await tailLogs(subArgs);
      break;
    case 'purge':
      await purgeLogs(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function showLogs(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      full: { type: 'boolean', default: false },
      attempt: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids logs show <task-id> - View logs for a task

USAGE:
  steroids logs show <task-id> [options]

OPTIONS:
  --full                Show complete output (no truncation)
  --attempt <n>         Show specific attempt number
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  if (!isInitialized(projectPath)) {
    console.error('Steroids not initialized. Run "steroids init" first.');
    process.exit(1);
  }

  const identifier = positionals[0];

  // Find task
  const { db, close } = openDatabase(projectPath);
  let taskId: string;
  try {
    let task = getTask(db, identifier);
    if (!task) {
      task = getTaskByTitle(db, identifier);
    }
    if (!task) {
      console.error(`Task not found: ${identifier}`);
      process.exit(1);
    }
    taskId = task.id;
  } finally {
    close();
  }

  const logsDir = join(projectPath, STEROIDS_DIR, LOGS_DIR);
  if (!existsSync(logsDir)) {
    console.log('No logs found.');
    return;
  }

  // Find log files for this task
  const logFiles = getLogFilesForTask(logsDir, taskId);

  if (logFiles.length === 0) {
    console.log(`No logs found for task ${taskId.substring(0, 8)}`);
    return;
  }

  // Filter by attempt if specified
  let filesToShow = logFiles;
  if (values.attempt) {
    const attemptNum = parseInt(values.attempt, 10);
    filesToShow = logFiles.filter(f => f.attempt === attemptNum);
    if (filesToShow.length === 0) {
      console.log(`No logs found for attempt ${attemptNum}`);
      return;
    }
  }

  // Sort by timestamp
  filesToShow.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (values.json) {
    const logData = filesToShow.map(f => ({
      file: f.name,
      role: f.role,
      attempt: f.attempt,
      timestamp: f.timestamp.toISOString(),
      size: f.size,
      content: readFileSync(f.path, 'utf-8'),
    }));
    console.log(JSON.stringify({
      success: true,
      command: 'logs show',
      data: {
        taskId,
        logs: logData,
      },
      error: null,
    }, null, 2));
    return;
  }

  for (const logFile of filesToShow) {
    console.log(`=== ${logFile.role || 'Unknown'} Attempt ${logFile.attempt || '?'} ===`);
    console.log(`Timestamp: ${logFile.timestamp.toISOString()}`);
    console.log(`Size: ${formatSize(logFile.size)}`);
    console.log('');

    let content = readFileSync(logFile.path, 'utf-8');

    if (!values.full && content.length > 2000) {
      content = content.substring(0, 2000) + '\n\n[Output truncated, use --full for complete]';
    }

    console.log(content);
    console.log('');
  }
}

async function listLogs(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      task: { type: 'string' },
      role: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids logs list - List log files

USAGE:
  steroids logs list [options]

OPTIONS:
  --task <id>           Filter by task ID
  --role <role>         Filter by role: coder, reviewer
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  const logsDir = join(projectPath, STEROIDS_DIR, LOGS_DIR);

  if (!existsSync(logsDir)) {
    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        command: 'logs list',
        data: { logs: [] },
        error: null,
      }, null, 2));
    } else {
      console.log('No logs found.');
    }
    return;
  }

  let logFiles = getAllLogFiles(logsDir);

  // Apply filters
  if (values.task) {
    logFiles = logFiles.filter(f =>
      f.taskId?.startsWith(values.task as string) ?? false
    );
  }

  if (values.role) {
    logFiles = logFiles.filter(f => f.role === values.role);
  }

  // Sort by timestamp descending
  logFiles.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'logs list',
      data: {
        logs: logFiles.map(f => ({
          file: f.name,
          taskId: f.taskId,
          role: f.role,
          attempt: f.attempt,
          timestamp: f.timestamp.toISOString(),
          size: f.size,
        })),
      },
      error: null,
    }, null, 2));
    return;
  }

  if (logFiles.length === 0) {
    console.log('No logs found.');
    return;
  }

  console.log('TIMESTAMP            TASK      ROLE      ATT  SIZE');
  console.log('\u2500'.repeat(55));

  for (const log of logFiles) {
    const timestamp = log.timestamp.toISOString().substring(0, 19).replace('T', ' ');
    const taskId = (log.taskId?.substring(0, 8) || '-').padEnd(10);
    const role = (log.role || '-').padEnd(10);
    const attempt = String(log.attempt || '-').padEnd(4);
    const size = formatSize(log.size);
    console.log(`${timestamp} ${taskId}${role}${attempt} ${size}`);
  }
}

async function tailLogs(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      follow: { type: 'boolean', short: 'f', default: false },
      lines: { type: 'string', default: '20' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids logs tail - Tail logs in real-time

USAGE:
  steroids logs tail [options]

OPTIONS:
  -f, --follow          Continue watching for new entries
  --lines <n>           Number of lines to show (default: 20)
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  const logsDir = join(projectPath, STEROIDS_DIR, LOGS_DIR);

  if (!existsSync(logsDir)) {
    console.log('No logs found.');
    return;
  }

  const numLines = parseInt(values.lines ?? '20', 10);

  // Get recent log entries
  const logFiles = getAllLogFiles(logsDir);
  logFiles.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Show recent entries
  const recentLogs = logFiles.slice(0, numLines);
  recentLogs.reverse(); // Show oldest first

  for (const log of recentLogs) {
    const timestamp = log.timestamp.toISOString().substring(11, 19);
    const taskId = log.taskId?.substring(0, 8) || 'unknown';
    const role = log.role || 'unknown';
    console.log(`[${timestamp}] ${taskId} ${role} (${formatSize(log.size)})`);
  }

  if (values.follow) {
    console.log('\nWatching for new logs... (Ctrl+C to stop)');

    // Watch for new files
    const watcher = watch(logsDir, (eventType, filename) => {
      if (eventType === 'rename' && filename) {
        const filePath = join(logsDir, filename);
        if (existsSync(filePath)) {
          const stat = statSync(filePath);
          if (stat.isFile()) {
            const timestamp = new Date().toISOString().substring(11, 19);
            console.log(`[${timestamp}] New log: ${filename}`);
          }
        }
      }
    });

    // Handle SIGINT
    process.on('SIGINT', () => {
      watcher.close();
      console.log('\nStopped watching.');
      process.exit(0);
    });

    // Keep process running
    await new Promise(() => {});
  }
}

async function purgeLogs(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      'older-than': { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids logs purge - Purge old logs

USAGE:
  steroids logs purge [options]

OPTIONS:
  --older-than <dur>    Remove logs older than duration (e.g., 7d)
  -y, --yes             Skip confirmation prompt
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  const projectPath = process.cwd();
  const logsDir = join(projectPath, STEROIDS_DIR, LOGS_DIR);

  if (!existsSync(logsDir)) {
    console.log('No logs found.');
    return;
  }

  let logFiles = getAllLogFiles(logsDir);

  if (values['older-than']) {
    const durationMs = parseDurationDays(values['older-than']);
    const cutoff = Date.now() - durationMs;
    logFiles = logFiles.filter(f => f.timestamp.getTime() < cutoff);
  }

  if (logFiles.length === 0) {
    console.log('No logs to purge.');
    return;
  }

  const totalSize = logFiles.reduce((sum, f) => sum + f.size, 0);

  if (!values.yes) {
    console.log(`Would purge ${logFiles.length} log files (${formatSize(totalSize)})`);
    console.log('Use --yes to confirm.');
    return;
  }

  for (const log of logFiles) {
    unlinkSync(log.path);
  }

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'logs purge',
      data: {
        purged: logFiles.length,
        freedBytes: totalSize,
      },
      error: null,
    }, null, 2));
  } else {
    console.log(`Purged ${logFiles.length} log files (${formatSize(totalSize)}).`);
  }
}

function getAllLogFiles(logsDir: string): LogFile[] {
  const files: LogFile[] = [];

  try {
    const entries = readdirSync(logsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.log') && !entry.name.endsWith('.txt')) continue;

      const filePath = join(logsDir, entry.name);
      const stat = statSync(filePath);

      const parsed = parseLogFileName(entry.name);

      files.push({
        name: entry.name,
        path: filePath,
        taskId: parsed.taskId,
        role: parsed.role,
        attempt: parsed.attempt,
        timestamp: stat.mtime,
        size: stat.size,
      });
    }
  } catch {
    // Directory read error
  }

  return files;
}

function getLogFilesForTask(logsDir: string, taskId: string): LogFile[] {
  const allFiles = getAllLogFiles(logsDir);
  return allFiles.filter(f =>
    f.taskId === taskId || f.taskId?.startsWith(taskId.substring(0, 8))
  );
}

function parseLogFileName(filename: string): {
  taskId: string | null;
  role: string | null;
  attempt: number | null;
} {
  // Expected formats:
  // {taskId}_{role}_{attempt}.log
  // {taskId}_{role}.log
  // {timestamp}_{taskId}_{role}.log

  const name = basename(filename, '.log');
  const parts = name.split('_');

  if (parts.length >= 2) {
    // Try to find task ID (UUID format)
    const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    const shortIdPattern = /^[0-9a-f]{8}$/i;

    for (let i = 0; i < parts.length; i++) {
      if (uuidPattern.test(parts[i]) || shortIdPattern.test(parts[i])) {
        const taskId = parts[i];
        const role = parts[i + 1] || null;
        const attemptStr = parts[i + 2];
        const attempt = attemptStr ? parseInt(attemptStr, 10) : null;

        return { taskId, role, attempt: isNaN(attempt ?? NaN) ? null : attempt };
      }
    }
  }

  return { taskId: null, role: null, attempt: null };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function parseDurationDays(duration: string): number {
  const match = duration.match(/^(\d+)(d|w|m)?$/);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}. Use format: 7d, 2w`);
  }

  const num = parseInt(match[1], 10);
  const unit = match[2] || 'd';

  switch (unit) {
    case 'd':
      return num * 24 * 60 * 60 * 1000;
    case 'w':
      return num * 7 * 24 * 60 * 60 * 1000;
    case 'm':
      return num * 30 * 24 * 60 * 60 * 1000;
    default:
      return num * 24 * 60 * 60 * 1000;
  }
}
