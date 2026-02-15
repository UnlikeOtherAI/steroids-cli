import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { listRunners, unregisterRunner } from '../runners/daemon.js';
import { checkLockStatus, isProcessAlive } from '../runners/lock.js';

export async function runStop(args: string[]): Promise<void> {
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

  // Capture stop context for logging
  const stopContext = {
    calledFrom: process.cwd(),
    callerPid: process.pid,
    timestamp: new Date().toISOString(),
    user: process.env.USER || process.env.USERNAME || 'unknown',
    args: {
      id: values.id,
      all: values.all,
    },
  };

  const runners = listRunners();
  let stopped = 0;
  const stoppedRunners: { id: string; pid: number | null; project: string | null }[] = [];

  const runnersToStop = values.id
    ? runners.filter((r) => r.id === values.id || r.id.startsWith(values.id!))
    : values.all
      ? runners
      : runners.filter((r) => r.pid === process.pid || r.pid !== null);

  // Log stop action to daemon logs
  const logsDir = path.join(os.homedir(), '.steroids', 'runners', 'logs');
  const stopLogPath = path.join(logsDir, 'stop-audit.log');
  fs.mkdirSync(logsDir, { recursive: true });

  for (const runner of runnersToStop) {
    if (runner.pid && isProcessAlive(runner.pid)) {
      try {
        process.kill(runner.pid, 'SIGTERM');
        stopped++;
        stoppedRunners.push({
          id: runner.id,
          pid: runner.pid,
          project: runner.project_path,
        });

        // Log each stop to audit log
        const logEntry = {
          ...stopContext,
          action: 'stop',
          runner: {
            id: runner.id,
            pid: runner.pid,
            project: runner.project_path,
          },
        };
        fs.appendFileSync(stopLogPath, JSON.stringify(logEntry) + '\n');
      } catch {
        // Process already dead
      }
    }
    unregisterRunner(runner.id);
  }

  if (values.json) {
    console.log(JSON.stringify({
      success: true,
      stopped,
      stoppedRunners,
      context: stopContext,
    }));
  } else {
    console.log(`Stopped ${stopped} runner(s)`);
    if (stopped > 0 && !values.all) {
      console.log(`  Called from: ${stopContext.calledFrom}`);
      console.log(`  Audit log: ${stopLogPath}`);
    }
  }
}

export async function runStatus(args: string[]): Promise<void> {
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
