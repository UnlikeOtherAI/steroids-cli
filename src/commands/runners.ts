import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids runners - Manage runner daemons
 */

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../config/loader.js';
import {
  startDaemon,
  canStartDaemon,
  listRunners,
  getRunner,
  unregisterRunner,
  type Runner,
} from '../runners/daemon.js';
import { checkLockStatus, isProcessAlive } from '../runners/lock.js';
import { wakeup, checkWakeupNeeded } from '../runners/wakeup.js';
import { cronStatus, cronInstall, cronUninstall } from '../runners/cron.js';
import { openDatabase } from '../database/connection.js';
import { getSection, getSectionByName, listSections } from '../database/queries.js';

const HELP = `
steroids runners - Manage runner daemons

USAGE:
  steroids runners <subcommand> [options]

SUBCOMMANDS:
  start               Start runner daemon
  stop                Stop runner(s)
  status              Show runner status
  list                List all runners
  logs                View daemon crash/output logs
  wakeup              Check and restart stale runners
  cron                Manage cron job

START OPTIONS:
  --detach            Run in background (daemonize)
  --project <path>    Project path to work on
  --section <id|name> Focus on a specific section only

STOP OPTIONS:
  --id <id>           Stop specific runner by ID
  --all               Stop all runners

LOGS OPTIONS:
  <pid>               Show logs for specific PID
  --tail <n>          Show last n lines (default: 50)
  --follow            Follow log output
  --clear             Clear all daemon logs

WAKEUP OPTIONS:
  --quiet             Suppress output (for cron)
  --dry-run           Check without acting

CRON SUBCOMMANDS:
  cron install        Install cron job (every minute)
  cron uninstall      Remove cron job
  cron status         Check cron status

GLOBAL OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids runners start                    # Start in foreground
  steroids runners start --detach           # Start in background
  steroids runners start --section "Phase 2" # Focus on specific section
  steroids runners stop                     # Stop current runner
  steroids runners status                   # Show status
  steroids runners list --json              # List all runners as JSON
  steroids runners logs                     # List available daemon logs
  steroids runners logs 12345               # View logs for PID 12345
  steroids runners logs --follow            # Follow latest log
  steroids runners wakeup --dry-run         # Check what would happen
  steroids runners cron install             # Install cron wake-up
`;

export async function runnersCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'start':
      await runStart(subArgs);
      break;
    case 'stop':
      await runStop(subArgs);
      break;
    case 'status':
      await runStatus(subArgs);
      break;
    case 'list':
      await runList(subArgs);
      break;
    case 'logs':
      await runLogs(subArgs);
      break;
    case 'wakeup':
      await runWakeup(subArgs, flags);
      break;
    case 'cron':
      await runCron(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function runStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      detach: { type: 'boolean', short: 'd', default: false },
      project: { type: 'string', short: 'p' },
      section: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids runners start - Start runner daemon

USAGE:
  steroids runners start [options]

OPTIONS:
  --detach            Run in background
  --project <path>    Project path
  --section <id|name> Focus on a specific section only
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  // Check if we can start
  // Default to cwd if --project not specified, to ensure proper per-project tracking
  // Always resolve to absolute path for consistent tracking across processes
  const projectPath = path.resolve((values.project as string | undefined) ?? process.cwd());
  const check = canStartDaemon(projectPath);
  if (!check.canStart && !check.reason?.includes('zombie')) {
    if (values.json) {
      console.log(
        JSON.stringify({
          success: false,
          error: check.reason,
          existingPid: check.existingPid,
        })
      );
    } else {
      console.error(`Cannot start: ${check.reason}`);
      if (check.existingPid) {
        console.error(`Existing runner PID: ${check.existingPid}`);
      }
    }
    process.exit(6);
  }

  // Resolve section if --section flag is provided
  let focusedSectionId: string | undefined;

  if (values.section) {
    const sectionInput = values.section as string;
    const { db, close } = openDatabase(projectPath);

    try {
      // Try to resolve by ID (exact or prefix match)
      let section;
      try {
        section = getSection(db, sectionInput);
      } catch (err) {
        // Handle ambiguous prefix error
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (values.json) {
          console.log(JSON.stringify({ success: false, error: errorMsg }));
        } else {
          console.error(`Error: ${errorMsg}`);
          console.error('');
          console.error('Available sections:');
          const sections = listSections(db);
          if (sections.length === 0) {
            console.error('  (no sections defined)');
          } else {
            for (const s of sections) {
              console.error(`  ${s.id.substring(0, 8)}  ${s.name}`);
            }
          }
        }
        close();
        process.exit(1);
      }

      // If not found by ID, try by name
      if (!section) {
        section = getSectionByName(db, sectionInput);
      }

      if (!section) {
        const errorMsg = `Section not found: ${sectionInput}`;
        if (values.json) {
          console.log(JSON.stringify({ success: false, error: errorMsg }));
        } else {
          console.error(`Error: ${errorMsg}`);
          console.error('');
          console.error('Available sections:');
          const sections = listSections(db);
          if (sections.length === 0) {
            console.error('  (no sections defined)');
          } else {
            for (const s of sections) {
              console.error(`  ${s.id.substring(0, 8)}  ${s.name}`);
            }
          }
        }
        close();
        process.exit(1);
      }

      // Check if section is skipped (Phase 0.6 feature)
      if (section.skipped === 1) {
        const errorMsg = `Section "${section.name}" is currently skipped`;
        if (values.json) {
          console.log(JSON.stringify({ success: false, error: errorMsg }));
        } else {
          console.error(`Error: ${errorMsg}`);
          console.error('');
          console.error(`Run 'steroids sections unskip "${section.name}"' to re-enable it.`);
        }
        close();
        process.exit(1);
      }

      focusedSectionId = section.id;
    } finally {
      close();
    }
  }

  if (values.detach) {
    // Spawn detached process - always pass --project for proper tracking
    const spawnArgs = [process.argv[1], 'runners', 'start', '--project', projectPath];

    // Pass --section if specified
    if (values.section) {
      spawnArgs.push('--section', values.section as string);
    }

    // Check config for daemon logging preference
    const config = loadConfig(projectPath);
    const daemonLogsEnabled = config.runners?.daemonLogs !== false;

    let logFile: string | undefined;
    let logFd: number | undefined;

    if (daemonLogsEnabled) {
      // Create logs directory and log file for daemon output
      const logsDir = path.join(os.homedir(), '.steroids', 'runners', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      // Use timestamp for now, will rename after we have PID
      const tempLogPath = path.join(logsDir, `daemon-${Date.now()}.log`);
      logFd = fs.openSync(tempLogPath, 'a');
      logFile = tempLogPath;
    }

    const child = spawn(
      process.execPath,
      spawnArgs,
      {
        detached: true,
        stdio: daemonLogsEnabled && logFd !== undefined
          ? ['ignore', logFd, logFd]
          : 'ignore',
      }
    );
    child.unref();

    // Clean up file descriptor and rename log file
    if (logFd !== undefined) {
      fs.closeSync(logFd);
    }

    let finalLogPath: string | undefined;
    if (logFile && child.pid) {
      const logsDir = path.dirname(logFile);
      finalLogPath = path.join(logsDir, `daemon-${child.pid}.log`);
      try {
        fs.renameSync(logFile, finalLogPath);
      } catch {
        finalLogPath = logFile; // Keep temp name if rename fails
      }
    }

    if (values.json) {
      console.log(JSON.stringify({
        success: true,
        pid: child.pid,
        detached: true,
        logFile: finalLogPath,
      }));
    } else {
      console.log(`Runner started in background (PID: ${child.pid})`);
      if (finalLogPath) {
        console.log(`  Log file: ${finalLogPath}`);
      }
    }
    return;
  }

  // Start in foreground
  await startDaemon({ projectPath, sectionId: focusedSectionId });
}

async function runStop(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      id: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids runners stop - Stop runner(s)

USAGE:
  steroids runners stop [options]

OPTIONS:
  --id <id>           Stop specific runner
  --all               Stop all runners
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const runners = listRunners();
  let stopped = 0;

  const runnersToStop = values.id
    ? runners.filter((r) => r.id === values.id || r.id.startsWith(values.id!))
    : values.all
      ? runners
      : runners.filter((r) => r.pid === process.pid || r.pid !== null);

  for (const runner of runnersToStop) {
    if (runner.pid && isProcessAlive(runner.pid)) {
      try {
        process.kill(runner.pid, 'SIGTERM');
        stopped++;
      } catch {
        // Process already dead
      }
    }
    unregisterRunner(runner.id);
  }

  if (values.json) {
    console.log(JSON.stringify({ success: true, stopped }));
  } else {
    console.log(`Stopped ${stopped} runner(s)`);
  }
}

async function runStatus(args: string[]): Promise<void> {
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
steroids runners status - Show runner status

USAGE:
  steroids runners status [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const lockStatus = checkLockStatus();
  const runners = listRunners();
  const activeRunner = runners.find((r) => r.pid && isProcessAlive(r.pid));

  const status = {
    locked: lockStatus.locked,
    lockPid: lockStatus.pid,
    isZombie: lockStatus.isZombie,
    activeRunner: activeRunner
      ? {
          id: activeRunner.id,
          pid: activeRunner.pid,
          status: activeRunner.status,
          project: activeRunner.project_path,
          currentTask: activeRunner.current_task_id,
          heartbeat: activeRunner.heartbeat_at,
        }
      : null,
    totalRunners: runners.length,
  };

  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (activeRunner) {
    console.log(`Runner Status: ACTIVE`);
    console.log(`  ID: ${activeRunner.id}`);
    console.log(`  PID: ${activeRunner.pid}`);
    console.log(`  Status: ${activeRunner.status}`);
    if (activeRunner.project_path) {
      console.log(`  Project: ${activeRunner.project_path}`);
    }
    if (activeRunner.current_task_id) {
      console.log(`  Current Task: ${activeRunner.current_task_id}`);
    }
    console.log(`  Last Heartbeat: ${activeRunner.heartbeat_at}`);
  } else if (lockStatus.isZombie) {
    console.log(`Runner Status: ZOMBIE`);
    console.log(`  Lock exists but process (PID: ${lockStatus.pid}) is dead`);
    console.log(`  Run 'steroids runners wakeup' to clean up`);
  } else {
    console.log(`Runner Status: INACTIVE`);
    console.log(`  No runner is currently active`);
  }
}

async function runList(args: string[]): Promise<void> {
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
steroids runners list - List all runners

USAGE:
  steroids runners list [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const runners = listRunners();

  if (values.json) {
    // For JSON output, enrich with section names if available
    const enrichedRunners = runners.map((runner) => {
      if (!runner.section_id || !runner.project_path) {
        return runner;
      }
      try {
        const { db, close } = openDatabase(runner.project_path);
        try {
          const section = getSection(db, runner.section_id);
          return { ...runner, section_name: section?.name };
        } finally {
          close();
        }
      } catch {
        return runner;
      }
    });
    console.log(JSON.stringify({ runners: enrichedRunners }, null, 2));
    return;
  }

  if (runners.length === 0) {
    console.log('No runners registered');
    return;
  }

  console.log('RUNNERS');
  console.log('─'.repeat(120));
  console.log('ID        STATUS      PID       PROJECT                           SECTION                           HEARTBEAT');
  console.log('─'.repeat(120));

  for (const runner of runners) {
    const shortId = runner.id.substring(0, 8);
    const status = runner.status.padEnd(10);
    const pid = (runner.pid?.toString() ?? '-').padEnd(9);
    const project = (runner.project_path ?? '-').substring(0, 30).padEnd(30);

    // Fetch section name if available
    let sectionDisplay = '-';
    if (runner.section_id && runner.project_path) {
      try {
        const { db, close } = openDatabase(runner.project_path);
        try {
          const section = getSection(db, runner.section_id);
          if (section) {
            sectionDisplay = section.name.substring(0, 30);
          }
        } finally {
          close();
        }
      } catch {
        // If we can't fetch the section name, just show the ID prefix
        sectionDisplay = runner.section_id.substring(0, 8);
      }
    }
    const section = sectionDisplay.padEnd(30);

    const heartbeat = runner.heartbeat_at.substring(11, 19);
    const alive = runner.pid && isProcessAlive(runner.pid) ? '' : ' (dead)';
    console.log(`${shortId}  ${status}  ${pid}  ${project}    ${section}    ${heartbeat}${alive}`);
  }
}

async function runLogs(args: string[]): Promise<void> {
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

async function runWakeup(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids runners wakeup - Check and restart stale runners

USAGE:
  steroids runners wakeup [options]

OPTIONS:
  --quiet             Suppress output (for cron)
  --dry-run           Check without acting
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const results = wakeup({
    quiet: values.quiet || flags.quiet || values.json || flags.json,
    dryRun: flags.dryRun,
  });

  if (values.json || flags.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  if (!values.quiet && !flags.quiet) {
    // Summarize results
    const started = results.filter(r => r.action === 'started').length;
    const cleaned = results.filter(r => r.action === 'cleaned').length;
    const wouldStart = results.filter(r => r.action === 'would_start').length;

    if (started > 0) {
      console.log(`Started ${started} runner(s)`);
    }
    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} stale runner(s)`);
    }
    if (wouldStart > 0) {
      console.log(`Would start ${wouldStart} runner(s) (dry-run)`);
    }
    if (started === 0 && cleaned === 0 && wouldStart === 0) {
      console.log('No action needed');
    }

    // Show per-project details
    for (const result of results) {
      if (result.projectPath) {
        const status = result.action === 'started' ? '✓' :
                       result.action === 'would_start' ? '~' : '-';
        console.log(`  ${status} ${result.projectPath}: ${result.reason}`);
      }
    }
  }
}

async function runCron(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(`
steroids runners cron - Manage cron job

USAGE:
  steroids runners cron <subcommand>

SUBCOMMANDS:
  install             Add cron job (every minute)
  uninstall           Remove cron job
  status              Check cron status

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  const { values } = parseArgs({
    args: subArgs,
    options: {
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: false,
  });

  switch (subcommand) {
    case 'install': {
      const result = cronInstall();
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
        if (result.error) {
          console.error(result.error);
        }
      }
      break;
    }
    case 'uninstall': {
      const result = cronUninstall();
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
      }
      break;
    }
    case 'status': {
      const status = cronStatus();
      if (values.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        if (status.installed) {
          console.log('Cron job: INSTALLED');
          console.log(`  Entry: ${status.entry}`);
        } else {
          console.log('Cron job: NOT INSTALLED');
          if (status.error) {
            console.log(`  ${status.error}`);
          }
        }
      }
      break;
    }
    default:
      console.error(`Unknown cron subcommand: ${subcommand}`);
      process.exit(1);
  }
}
