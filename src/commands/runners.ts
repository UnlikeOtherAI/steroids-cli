import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids runners - Manage runner daemons
 */

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
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

const HELP = `
steroids runners - Manage runner daemons

USAGE:
  steroids runners <subcommand> [options]

SUBCOMMANDS:
  start               Start runner daemon
  stop                Stop runner(s)
  status              Show runner status
  list                List all runners
  wakeup              Check and restart stale runners
  cron                Manage cron job

START OPTIONS:
  --detach            Run in background (daemonize)
  --project <path>    Project path to work on

STOP OPTIONS:
  --id <id>           Stop specific runner by ID
  --all               Stop all runners

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
  steroids runners stop                     # Stop current runner
  steroids runners status                   # Show status
  steroids runners list --json              # List all runners as JSON
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
    case 'wakeup':
      await runWakeup(subArgs);
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
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  // Check if we can start
  const check = canStartDaemon();
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

  if (values.detach) {
    // Spawn detached process
    const child = spawn(
      process.execPath,
      [process.argv[1], 'runners', 'start', '--project', values.project ?? process.cwd()],
      {
        detached: true,
        stdio: 'ignore',
      }
    );
    child.unref();

    if (values.json) {
      console.log(JSON.stringify({ success: true, pid: child.pid, detached: true }));
    } else {
      console.log(`Runner started in background (PID: ${child.pid})`);
    }
    return;
  }

  // Start in foreground
  await startDaemon({ projectPath: values.project });
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
    console.log(JSON.stringify({ runners }, null, 2));
    return;
  }

  if (runners.length === 0) {
    console.log('No runners registered');
    return;
  }

  console.log('RUNNERS');
  console.log('─'.repeat(90));
  console.log('ID        STATUS      PID       PROJECT                           HEARTBEAT');
  console.log('─'.repeat(90));

  for (const runner of runners) {
    const shortId = runner.id.substring(0, 8);
    const status = runner.status.padEnd(10);
    const pid = (runner.pid?.toString() ?? '-').padEnd(9);
    const project = (runner.project_path ?? '-').substring(0, 30).padEnd(30);
    const heartbeat = runner.heartbeat_at.substring(11, 19);
    const alive = runner.pid && isProcessAlive(runner.pid) ? '' : ' (dead)';
    console.log(`${shortId}  ${status}  ${pid}  ${project}    ${heartbeat}${alive}`);
  }
}

async function runWakeup(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      'dry-run': { type: 'boolean', default: false },
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

  const result = wakeup({
    quiet: values.quiet,
    dryRun: values['dry-run'],
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!values.quiet) {
    console.log(`Action: ${result.action}`);
    console.log(`Reason: ${result.reason}`);
    if (result.pid) {
      console.log(`PID: ${result.pid}`);
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
