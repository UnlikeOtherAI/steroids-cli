import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import { cronInstall, cronStatus, cronUninstall } from '../runners/cron.js';
import { wakeup } from '../runners/wakeup.js';

export async function runWakeup(args: string[], flags: GlobalFlags): Promise<void> {
  // Hard timeout: wakeup is spawned by cron/launchd every 60s.
  // If the wakeup function itself hangs (locked DB, TCC blocking file access),
  // force-kill after 30s. SIGKILL is needed because process.exit() can also
  // hang if native addon destructors (better-sqlite3) try to fsync blocked paths.
  const WAKEUP_TIMEOUT_MS = 30_000;
  const killTimer = setTimeout(() => process.kill(process.pid, 'SIGKILL'), WAKEUP_TIMEOUT_MS);
  killTimer.unref();

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

  const results = await wakeup({
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

  // Two-phase exit for wakeup (cron/launchd spawns this every 60s):
  // 1. Try graceful exit first (exit code 0, clean shutdown)
  // 2. If process.exit() hangs (e.g. better-sqlite3 destructors fsyncing WAL
  //    files on TCC-protected paths), SIGKILL fires after 2s as a backstop.
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 2000).unref();
  process.exit(0);
}

export async function runCron(args: string[]): Promise<void> {
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
