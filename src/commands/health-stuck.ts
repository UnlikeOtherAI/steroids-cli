import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids health check|incidents - Stuck task detection & incident management
 *
 * Routed from src/commands/health.ts to avoid bloating the health scoring command.
 */

import { parseArgs } from 'node:util';
import { parseDuration } from '../cli/flags.js';
import { generateHelp } from '../cli/help.js';
import { createOutput } from '../cli/output.js';
import { openDatabase } from '../database/connection.js';
import { loadConfig } from '../config/loader.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import { recoverStuckTasks } from '../health/stuck-task-recovery.js';

type HealthSubcommand = 'check' | 'incidents';

const HELP_CHECK = generateHelp({
  command: 'health check',
  description: 'Detect and (optionally) recover stuck tasks/runners',
  details: `Runs stuck-task detection (orphaned tasks, hanging invocations, zombie/dead runners).
If auto-recovery is enabled in config (health.autoRecover), it will attempt safe recovery actions.
Use --dry-run to preview actions without mutating any databases.`,
  usage: ['steroids health check [options]'],
  options: [
    { long: 'watch', description: 'Continuously run health check (Ctrl+C to stop)' },
    { long: 'watch-interval', description: 'Watch interval', values: '<duration> (e.g., 5s, 1m)', default: '5s' },
  ],
  examples: [
    { command: 'steroids health check', description: 'Run stuck-task health check once' },
    { command: 'steroids health check --watch', description: 'Watch for stuck tasks continuously' },
    { command: 'steroids health check --dry-run', description: 'Preview recovery actions without changes' },
    { command: 'steroids health check --json', description: 'Machine-readable output' },
  ],
  related: [
    { command: 'steroids health incidents', description: 'View incident history' },
    { command: 'steroids runners wakeup', description: 'Wake and recover stale runners across projects' },
  ],
  showExitCodes: true,
});

const HELP_INCIDENTS = generateHelp({
  command: 'health incidents',
  description: 'View and manage stuck-task incident history',
  details: `Incidents are logged when stuck-task recovery detects and handles problems.
Use --task to filter incidents for a specific task.
Use --clear to delete resolved incidents older than 7 days.`,
  usage: ['steroids health incidents [options]'],
  options: [
    { long: 'task', description: 'Filter incidents for a task ID/prefix', values: '<taskId>' },
    { long: 'limit', description: 'Max rows to show', values: '<n>', default: '50' },
    { long: 'clear', description: 'Delete resolved incidents older than 7 days' },
  ],
  examples: [
    { command: 'steroids health incidents', description: 'Show recent incidents' },
    { command: 'steroids health incidents --task abc123', description: 'Filter incidents for a task' },
    { command: 'steroids health incidents --clear', description: 'Clear old resolved incidents' },
  ],
  related: [{ command: 'steroids health check', description: 'Run stuck-task health check' }],
  showExitCodes: true,
});

function formatTimestampLocal(d: Date): string {
  return d.toLocaleString();
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function drawBox(lines: string[], width: number): string {
  const w = Math.max(20, width);
  const top = `\u250c${'\u2500'.repeat(w - 2)}\u2510`;
  const mid = `\u251c${'\u2500'.repeat(w - 2)}\u2524`;
  const bot = `\u2514${'\u2500'.repeat(w - 2)}\u2518`;

  const body = lines.map((l) => `\u2502${padRight(` ${l}`, w - 2)}\u2502`);
  return [top, body[0] ?? `\u2502${padRight(' ', w - 2)}\u2502`, mid, ...body.slice(1), bot].join('\n');
}

function yesNoMark(ok: boolean): string {
  return ok ? '\u2713' : '\u2717';
}

function describeSignals(result: Awaited<ReturnType<typeof recoverStuckTasks>>): string[] {
  const report = result.report;
  const orphaned = report.orphanedTasks.length;
  const hanging = report.hangingInvocations.length;
  const zombie = report.zombieRunners.length;
  const dead = report.deadRunners.length;

  const incidentCount = orphaned + hanging + zombie + dead;
  const lines: string[] = [];

  lines.push('HEALTH CHECK REPORT');
  lines.push(`Timestamp: ${formatTimestampLocal(report.timestamp)}`);
  lines.push('');
  lines.push(`Orphaned Tasks:        ${orphaned} ${yesNoMark(orphaned === 0)}`);
  lines.push(`Hanging Invocations:   ${hanging} ${yesNoMark(hanging === 0)}`);
  lines.push(`Zombie Runners:        ${zombie} ${yesNoMark(zombie === 0)}`);
  lines.push(`Dead Runners:          ${dead} ${yesNoMark(dead === 0)}`);

  if (report.dbInconsistencies.length > 0) {
    lines.push(`DB Inconsistencies:    ${report.dbInconsistencies.length} ${yesNoMark(false)}`);
  }

  lines.push('');
  lines.push(`Incidents Found: ${incidentCount}`);
  if (incidentCount > 0) {
    for (const t of report.orphanedTasks) {
      const mins = Math.round(t.secondsSinceUpdate / 60);
      lines.push(`  - orphaned_task: ${t.taskId} (${mins}min inactive)`);
    }
    for (const h of report.hangingInvocations) {
      if (h.secondsSinceActivity !== null) {
        const mins = Math.round(h.secondsSinceActivity / 60);
        lines.push(`  - hanging_invocation: ${h.taskId} (${h.phase}, ${mins}min silent)`);
      } else {
        const mins = Math.round(h.secondsSinceUpdate / 60);
        lines.push(`  - hanging_invocation: ${h.taskId} (${h.phase}, ${mins}min active)`);
      }
    }
    for (const r of report.zombieRunners) {
      const mins = Math.round(r.secondsSinceHeartbeat / 60);
      lines.push(`  - zombie_runner: ${r.runnerId} (${mins}min no heartbeat)`);
    }
    for (const r of report.deadRunners) {
      const mins = Math.round(r.secondsSinceHeartbeat / 60);
      lines.push(`  - dead_runner: ${r.runnerId} (${mins}min since heartbeat)`);
    }
  }

  lines.push('');
  lines.push(`Actions Taken: ${result.actions.length}`);
  for (const a of result.actions) {
    lines.push(`  - ${a.resolution}: ${a.reason}`);
  }

  if (result.skippedDueToSafetyLimit) {
    lines.push('');
    lines.push('Warning: Skipped recovery due to maxIncidentsPerHour safety limit.');
  }

  return lines;
}

export async function runHealthSubcommand(
  subcommand: HealthSubcommand,
  args: string[],
  flags: GlobalFlags
): Promise<void> {
  switch (subcommand) {
    case 'check':
      await runHealthCheck(args, flags);
      return;
    case 'incidents':
      await runHealthIncidents(args, flags);
      return;
    default: {
      const _exhaustive: never = subcommand;
      throw new Error(`Unknown health subcommand: ${_exhaustive}`);
    }
  }
}

async function runHealthCheck(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'health', subcommand: 'check', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      watch: { type: 'boolean', default: false },
      'watch-interval': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(HELP_CHECK);
    return;
  }

  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  const { db: projectDb, close: closeProject } = openDatabase(projectPath);
  const global = openGlobalDatabase();

  const runOnce = async () => {
    const result = await recoverStuckTasks({
      projectPath,
      projectDb,
      globalDb: global.db,
      config,
      dryRun: flags.dryRun,
    });

    if (out.isJson()) {
      out.success({
        timestamp: result.report.timestamp.toISOString(),
        counts: {
          orphanedTasks: result.report.orphanedTasks.length,
          hangingInvocations: result.report.hangingInvocations.length,
          zombieRunners: result.report.zombieRunners.length,
          deadRunners: result.report.deadRunners.length,
          dbInconsistencies: result.report.dbInconsistencies.length,
        },
        report: result.report,
        actions: result.actions,
        dryRun: flags.dryRun,
        skippedDueToSafetyLimit: result.skippedDueToSafetyLimit,
      });
      return;
    }

    if (values.watch) {
      process.stdout.write('\x1B[2J\x1B[0f');
    }

    out.log(drawBox(describeSignals(result), 61));
  };

  try {
    if (values.watch) {
      const intervalStr = (values['watch-interval'] as string | undefined) ?? '5s';
      const intervalMs = parseDuration(intervalStr);

      await runOnce();

      const intervalId = setInterval(() => {
        runOnce().catch((err) => {
          if (!out.isJson()) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Health check failed: ${msg}`);
          }
        });
      }, intervalMs);

      process.on('SIGINT', () => {
        clearInterval(intervalId);
        closeProject();
        global.close();
        if (!out.isJson()) console.log('\nStopped watching.');
        process.exit(0);
      });

      await new Promise(() => {});
    } else {
      await runOnce();
    }
  } finally {
    if (!values.watch) {
      closeProject();
      global.close();
    }
  }
}

type IncidentRow = {
  id: string;
  task_id: string | null;
  runner_id: string | null;
  failure_mode: string;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
  details: string | null;
  created_at: string;
};

function normalizeTaskPrefix(input: string): string {
  return input.trim();
}

async function runHealthIncidents(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'health', subcommand: 'incidents', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      task: { type: 'string' },
      limit: { type: 'string' },
      clear: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(HELP_INCIDENTS);
    return;
  }

  const projectPath = process.cwd();
  const { db, close } = openDatabase(projectPath);

  try {
    const limit = (() => {
      const raw = (values.limit as string | undefined) ?? '50';
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 50;
    })();

    if (values.clear) {
      const countRow = db
        .prepare(
          `SELECT COUNT(*) as c
           FROM incidents
           WHERE resolved_at IS NOT NULL
             AND resolved_at < datetime('now', '-7 days')`
        )
        .get() as { c: number } | undefined;
      const toDelete = countRow?.c ?? 0;

      if (!flags.dryRun) {
        db.prepare(
          `DELETE FROM incidents
           WHERE resolved_at IS NOT NULL
             AND resolved_at < datetime('now', '-7 days')`
        ).run();
      }

      if (out.isJson()) {
        out.success({ deleted: flags.dryRun ? 0 : toDelete, wouldDelete: flags.dryRun ? toDelete : 0 });
      } else {
        out.log(flags.dryRun ? `Would delete ${toDelete} incident(s).` : `Deleted ${toDelete} incident(s).`);
      }
      return;
    }

    const taskPrefix = values.task ? normalizeTaskPrefix(values.task as string) : null;

    const incidents = (() => {
      if (taskPrefix) {
        return db
          .prepare(
            `SELECT id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at
             FROM incidents
             WHERE task_id LIKE ?
             ORDER BY detected_at DESC
             LIMIT ?`
          )
          .all(`${taskPrefix}%`, limit) as IncidentRow[];
      }

      return db
        .prepare(
          `SELECT id, task_id, runner_id, failure_mode, detected_at, resolved_at, resolution, details, created_at
           FROM incidents
           ORDER BY detected_at DESC
           LIMIT ?`
        )
        .all(limit) as IncidentRow[];
    })();

    if (out.isJson()) {
      out.success({ total: incidents.length, incidents });
      return;
    }

    if (incidents.length === 0) {
      out.log('No incidents found.');
      return;
    }

    const rows = incidents.map((i) => {
      const resolved = i.resolved_at ? 'yes' : 'no';
      const task = i.task_id ?? '-';
      const runner = i.runner_id ?? '-';
      const resolution = i.resolution ?? '-';
      return [i.detected_at, i.failure_mode, task, runner, resolved, resolution];
    });

    out.table(
      ['detected_at', 'failure_mode', 'task', 'runner', 'resolved', 'resolution'],
      rows
    );
  } finally {
    close();
  }
}
