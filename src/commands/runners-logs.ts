import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

export async function runLogs(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      tail: { type: 'string', short: 'n', default: '50' },
      follow: { type: 'boolean', short: 'f', default: false },
      clear: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids runners logs - View daemon crash/output logs

USAGE:
  steroids runners logs [pid] [options]

OPTIONS:
  <pid>               Show logs for specific daemon PID
  --tail <n>          Show last n lines (default: 50)
  --follow            Follow log output (latest log)
  --clear             Clear all daemon logs
  -j, --json          Output as JSON
  -h, --help          Show help

LOG LOCATION:
  Logs are stored in ~/.steroids/runners/logs/
  Each daemon gets its own log file: daemon-<pid>.log

  To disable daemon logging, set in config:
    steroids config set runners.daemonLogs false

EXAMPLES:
  steroids runners logs           # List available log files
  steroids runners logs 12345     # View logs for PID 12345
  steroids runners logs --follow  # Follow the latest log
  steroids runners logs --clear   # Remove all log files
`);
    return;
  }

  const logsDir = path.join(os.homedir(), '.steroids', 'runners', 'logs');

  // Handle --clear
  if (values.clear) {
    if (!fs.existsSync(logsDir)) {
      if (values.json) {
        console.log(JSON.stringify({ success: true, cleared: 0 }));
      } else {
        console.log('No logs directory found');
      }
      return;
    }
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    for (const file of files) {
      fs.unlinkSync(path.join(logsDir, file));
    }
    if (values.json) {
      console.log(JSON.stringify({ success: true, cleared: files.length }));
    } else {
      console.log(`Cleared ${files.length} log file(s)`);
    }
    return;
  }

  // Ensure logs directory exists
  if (!fs.existsSync(logsDir)) {
    if (values.json) {
      console.log(JSON.stringify({ logs: [], logsDir }));
    } else {
      console.log('No daemon logs found');
      console.log(`  Logs are stored in: ${logsDir}`);
    }
    return;
  }

  const logFiles = fs.readdirSync(logsDir)
    .filter((f) => f.startsWith('daemon-') && f.endsWith('.log'))
    .map((f) => {
      const filePath = path.join(logsDir, f);
      const stats = fs.statSync(filePath);
      const pidMatch = f.match(/daemon-(\d+)\.log/);
      return {
        file: f,
        path: filePath,
        pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
        size: stats.size,
        modified: stats.mtime,
      };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  // If a PID is specified, show that log
  if (positionals.length > 0) {
    const pidArg = positionals[0];
    const logFile = logFiles.find((l) => l.pid?.toString() === pidArg || l.file.includes(pidArg));

    if (!logFile) {
      console.error(`No log found for PID: ${pidArg}`);
      process.exit(1);
    }

    const content = fs.readFileSync(logFile.path, 'utf-8');
    const lines = content.split('\n');
    const tailLines = parseInt(values.tail as string, 10) || 50;
    const output = lines.slice(-tailLines).join('\n');

    if (values.json) {
      console.log(JSON.stringify({ pid: logFile.pid, path: logFile.path, content: output }));
    } else {
      console.log(`=== Daemon log for PID ${logFile.pid} ===`);
      console.log(`File: ${logFile.path}`);
      console.log(`Modified: ${logFile.modified.toISOString()}`);
      console.log('─'.repeat(60));
      console.log(output);
    }
    return;
  }

  // If --follow, tail the most recent log
  if (values.follow) {
    if (logFiles.length === 0) {
      console.error('No log files to follow');
      process.exit(1);
    }

    const latestLog = logFiles[0];
    console.log(`Following: ${latestLog.path} (PID: ${latestLog.pid})`);
    console.log('─'.repeat(60));

    // Use spawn to tail -f
    const tail = spawn('tail', ['-f', latestLog.path], { stdio: 'inherit' });
    tail.on('error', (err) => {
      console.error(`Error following log: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // List all log files
  if (values.json) {
    console.log(JSON.stringify({ logs: logFiles, logsDir }, null, 2));
    return;
  }

  if (logFiles.length === 0) {
    console.log('No daemon logs found');
    console.log(`  Logs are stored in: ${logsDir}`);
    return;
  }

  console.log('DAEMON LOGS');
  console.log('─'.repeat(80));
  console.log('PID         SIZE      MODIFIED                 FILE');
  console.log('─'.repeat(80));

  for (const log of logFiles) {
    const pid = (log.pid?.toString() ?? 'unknown').padEnd(10);
    const size = formatBytes(log.size).padEnd(9);
    const modified = log.modified.toISOString().substring(0, 19).padEnd(22);
    console.log(`${pid}  ${size}  ${modified}  ${log.file}`);
  }

  console.log('');
  console.log(`Logs directory: ${logsDir}`);
  console.log(`Use 'steroids runners logs <pid>' to view a specific log`);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
