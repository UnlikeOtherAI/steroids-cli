import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids runners - Manage runner daemons
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config/loader.js';
import {
  startDaemon,
  canStartDaemon,
} from '../runners/daemon.js';
import { openDatabase } from '../database/connection.js';
import {
  getSection,
  getSectionByName,
  listSections,
} from '../database/queries.js';
import { generateHelp } from '../cli/help.js';
import {
  buildParallelRunPlan,
  CyclicDependencyError,
  getConfiguredMaxClones,
  launchParallelSession,
  parseSectionIds,
  printParallelPlan,
  spawnDetachedRunner,
  type ParallelWorkstreamPlan,
} from './runners-parallel.js';
import { runCron, runWakeup } from './runners-wakeup.js';
import { runList } from './runners-list.js';
import { runLogs } from './runners-logs.js';
import { runStop as runStopCommand, runStatus as runStatusCommand } from './runners-management.js';

const HELP = generateHelp({
  command: 'runners',
  description: 'Manage background runner daemons for automated task execution',
  details: `Runners are daemon processes that execute the orchestrator loop in the background.
Each project can have one active runner processing tasks.
Runners can be started manually or managed automatically via cron.`,
  usage: ['steroids runners <subcommand> [options]'],
  subcommands: [
    { name: 'start', description: 'Start runner daemon (foreground or background)' },
    { name: 'stop', description: 'Stop runner(s) for current or all projects' },
    { name: 'status', description: 'Show runner status for current project' },
    { name: 'list', description: 'List all runners across all projects' },
    { name: 'logs', args: '[pid]', description: 'View daemon crash/output logs' },
    { name: 'wakeup', description: 'Check and restart stale runners' },
    { name: 'cron', args: '<install|uninstall|status>', description: 'Manage cron job for auto-wakeup' },
  ],
  options: [
    { long: 'detach', description: 'Run in background (daemonize) - start subcommand' },
    { long: 'project', description: 'Project path to work on', values: '<path>' },
    { long: 'section', description: 'Focus on specific section only', values: '<id|name>' },
    { long: 'parallel', description: 'Run independent sections across multiple clones' },
    { long: 'max', description: 'Limit number of concurrent workstreams', values: '<n>' },
    { long: 'dry-run', description: 'Analyze plan and exit without cloning or spawning' },
    { long: 'id', description: 'Stop specific runner by ID - stop subcommand', values: '<id>' },
    { long: 'all', description: 'Stop all runners - stop subcommand' },
    { long: 'tree', description: 'Show tree view with projects/runners/tasks - list subcommand' },
    { long: 'tail', description: 'Show last n lines of logs', values: '<n>', default: '50' },
    { long: 'follow', description: 'Follow log output in real-time' },
    { long: 'clear', description: 'Clear all daemon logs' },
  ],
  examples: [
    { command: 'steroids runners start', description: 'Start in foreground' },
    { command: 'steroids runners start --detach', description: 'Start in background' },
    { command: 'steroids runners start --parallel', description: 'Analyze and run independent workstreams in parallel clones' },
    { command: 'steroids runners start --parallel --max 2', description: 'Run up to 2 workstreams concurrently' },
    { command: 'steroids runners start --parallel --dry-run', description: 'Show planned parallel workstreams and exit' },
    { command: 'steroids runners start --section "Phase 2"', description: 'Focus on specific section' },
    { command: 'steroids runners stop', description: 'Stop runner for current project' },
    { command: 'steroids runners stop --all', description: 'Stop all runners' },
    { command: 'steroids runners status', description: 'Show runner status' },
    { command: 'steroids runners list', description: 'List all runners (all projects)' },
    { command: 'steroids runners list --tree', description: 'Tree view with tasks' },
    { command: 'steroids runners list --json', description: 'JSON output' },
    { command: 'steroids runners logs', description: 'List available logs' },
    { command: 'steroids runners logs 12345', description: 'View logs for PID 12345' },
    { command: 'steroids runners logs --follow', description: 'Follow latest log' },
    { command: 'steroids runners wakeup', description: 'Restart stale runners' },
    { command: 'steroids runners cron install', description: 'Install cron wake-up' },
    { command: 'steroids runners cron status', description: 'Check cron status' },
  ],
  related: [
    { command: 'steroids loop', description: 'Run orchestrator loop manually' },
    { command: 'steroids tasks', description: 'View tasks being processed' },
  ],
  sections: [
    {
      title: 'MULTI-PROJECT',
      content: `Different projects can run runners in parallel (one per project).
The 'list' command shows runners from ALL registered projects.
Use 'wakeup' to check if any projects need runners restarted.`,
    },
  ],
});

export async function runnersCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'start':
      await runStart(subArgs, flags);
      break;
    case 'stop':
      await runStop(subArgs);
      break;
    case 'status':
      await runStatus(subArgs);
      break;
    case 'list':
      await runList(subArgs, flags);
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

async function runStart(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      detach: { type: 'boolean', short: 'd', default: false },
      project: { type: 'string', short: 'p' },
      section: { type: 'string' },
      parallel: { type: 'boolean', default: false },
      max: { type: 'string' },
      'section-ids': { type: 'string' },
      branch: { type: 'string' },
      'parallel-session-id': { type: 'string' },
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
  --parallel          Analyze dependency graph and run independent workstreams in parallel clones
  --max <n>           Limit number of parallel workstreams (overrides runners.parallel.maxClones)
  -j, --json          Output as JSON
  -h, --help          Show help
  --dry-run           Print analysis plan and exit
`);
    return;
  }

  const sectionIdsOption = values['section-ids'] as string | undefined;
  const parallelSessionId = values['parallel-session-id'] as string | undefined;
  const asJson = values.json || flags.json;

  if (values.parallel && values.section) {
    const errorMsg = '--parallel cannot be combined with --section';
    if (asJson) {
      console.log(JSON.stringify({ success: false, error: errorMsg }));
    } else {
      console.error(errorMsg);
    }
    process.exit(1);
  }

  // Check if we can start
  // Default to cwd if --project not specified, to ensure proper per-project tracking
  // Always resolve to absolute path for consistent tracking across processes
  const projectPath = path.resolve((values.project as string | undefined) ?? process.cwd());
  const check = canStartDaemon(projectPath);
  if (!check.canStart && !check.reason?.includes('zombie')) {
    if (asJson) {
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

  const runFromDetachedParent = values.detach && !values.parallel && !parallelSessionId && !sectionIdsOption;
  const sectionIdsFromSpawn = typeof sectionIdsOption === 'string'
    ? parseSectionIds(sectionIdsOption)
    : [];

  // Internal parallel runner invocation used by this command when spawning workspace runners.
  if (
    values.parallel
    && sectionIdsOption !== undefined
    && parallelSessionId
    && values.branch
  ) {
    if (sectionIdsFromSpawn.length === 0) {
      const errorMsg = 'Internal parallel runner received empty section ids';
      if (asJson) {
        console.log(JSON.stringify({ success: false, error: errorMsg }));
      } else {
        console.error(errorMsg);
      }
      process.exit(1);
    }

    await startDaemon({
      projectPath,
      sectionIds: sectionIdsFromSpawn,
      branchName: values.branch as string,
      parallelSessionId,
    });
    return;
  }

  // Resolve section if --section flag is provided
  let focusedSectionId: string | undefined;

  if (!values.parallel && values.section) {
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

  if (runFromDetachedParent) {
    // Spawn detached process - always pass --project for proper tracking
    const spawnArgs = [process.argv[1], 'runners', 'start', '--project', projectPath];

    // Pass --section if specified
    if (values.section) {
      spawnArgs.push('--section', values.section as string);
    }

    const {
      pid,
      logFile: finalLogPath,
    } = spawnDetachedRunner({
      projectPath,
      args: spawnArgs,
    });

    if (asJson) {
      console.log(JSON.stringify({
        success: true,
        pid,
        detached: true,
        logFile: finalLogPath,
      }));
    } else {
      console.log(`Runner started in background (PID: ${pid})`);
      if (finalLogPath) {
        console.log(`  Log file: ${finalLogPath}`);
      }
    }
    return;
  }

  if (values.parallel) {
    const maxFromCli = typeof values.max === 'string' ? values.max.trim() : undefined;
    let maxClones: number | undefined;
    if (maxFromCli !== undefined) {
      const parsedMax = Number.parseInt(maxFromCli, 10);
      if (!Number.isInteger(parsedMax) || parsedMax <= 0) {
        if (asJson) {
          console.log(JSON.stringify({ success: false, error: '--max must be a positive integer' }));
        } else {
          console.error('--max must be a positive integer');
        }
        process.exit(1);
      }
      maxClones = parsedMax;
    }

    let parallelPlan: ParallelWorkstreamPlan;
    try {
      parallelPlan = buildParallelRunPlan(projectPath, maxClones);
    } catch (error: unknown) {
      const message = error instanceof CyclicDependencyError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unable to create parallel plan';

      if (asJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(message);
      }
      process.exit(1);
    }

    if (flags.dryRun) {
      if (asJson) {
        console.log(JSON.stringify({ success: true, plan: parallelPlan }));
      } else {
        printParallelPlan(projectPath, parallelPlan);
      }
      return;
    }

    const sessionId = launchParallelSession(parallelPlan, projectPath);
    if (asJson) {
      console.log(JSON.stringify({ success: true, sessionId }));
    } else {
      console.log(`Started parallel session: ${sessionId}`);
    }
    return;
  }

  // Start in foreground
  await startDaemon({ projectPath, sectionId: focusedSectionId });
}

async function runStop(args: string[]): Promise<void> {
  return runStopCommand(args);
}

async function runStatus(args: string[]): Promise<void> {
  return runStatusCommand(args);
}
