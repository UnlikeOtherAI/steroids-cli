/**
 * steroids stats - Global activity statistics
 */

import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors } from '../cli/colors.js';
import {
  getActivityStatsByProject,
  getActivityCount,
  purgeActivity,
} from '../runners/activity-log.js';

const HELP = `
steroids stats - Global activity statistics

USAGE:
  steroids stats [time-range] [options]
  steroids stats purge [time-range] [options]

TIME RANGE FORMAT:
  <number>              Hours (default unit)
  <number>h             Hours
  <number>m             Minutes
  <number>d             Days

  Default: 12 hours

SUBCOMMANDS:
  (none)            Show stats for time range (default)
  purge             Purge old activity log entries

STATS OPTIONS:
  -h, --help        Show help
  -j, --json        Output as JSON

PURGE OPTIONS:
  --force           Required for purging all entries (no time range)

EXAMPLES:
  steroids stats               # Stats for past 12 hours
  steroids stats 24            # Stats for past 24 hours
  steroids stats 60m           # Stats for past 60 minutes
  steroids stats 3d            # Stats for past 3 days
  steroids stats 30d           # Stats for past month
  steroids stats --json        # JSON output

  steroids stats purge 30d     # Keep last 30 days, delete older
  steroids stats purge 7d      # Keep last 7 days
  steroids stats purge --force # Delete ALL entries
`;

/**
 * Parse time range string into hours
 * Supports: 12, 12h, 60m, 3d
 */
function parseTimeRange(input: string): { hours: number; display: string } {
  const match = input.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/i);
  if (!match) {
    throw new Error(`Invalid time range: ${input}`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'h').toLowerCase();

  switch (unit) {
    case 'm': {
      const hours = value / 60;
      return { hours, display: `${value} minute${value !== 1 ? 's' : ''}` };
    }
    case 'h':
      return { hours: value, display: `${value} hour${value !== 1 ? 's' : ''}` };
    case 'd': {
      const hours = value * 24;
      return { hours, display: `${value} day${value !== 1 ? 's' : ''}` };
    }
    default:
      return { hours: value, display: `${value} hour${value !== 1 ? 's' : ''}` };
  }
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export async function statsCommand(
  args: string[],
  flags: GlobalFlags
): Promise<void> {
  const out = createOutput({ command: 'stats', flags });

  // Check for purge subcommand
  if (args[0] === 'purge') {
    await purgeCommand(args.slice(1), flags);
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  // Parse time range argument
  const timeRangeArg = positionals[0] || '12';
  let parsed: { hours: number; display: string };

  try {
    parsed = parseTimeRange(timeRangeArg);
  } catch (error) {
    out.error('INVALID_ARGUMENTS', (error as Error).message);
    process.exit(1);
  }

  const { hours, display } = parsed;

  // Get stats
  const projectStats = getActivityStatsByProject(hours);

  // Calculate time range
  const now = new Date();
  const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000);

  // Calculate totals
  const totals = {
    completed: 0,
    failed: 0,
    skipped: 0,
    partial: 0,
    disputed: 0,
    total: 0,
  };

  for (const project of projectStats) {
    totals.completed += project.completed;
    totals.failed += project.failed;
    totals.skipped += project.skipped;
    totals.partial += project.partial;
    totals.disputed += project.disputed;
    totals.total += project.total;
  }

  // Calculate tasks per hour
  const tasksPerHour = hours > 0 ? (totals.total / hours).toFixed(2) : '0';
  const successRate =
    totals.total > 0 ? ((totals.completed / totals.total) * 100).toFixed(1) : '0';

  // JSON output
  if (flags.json) {
    out.success({
      timeRange: {
        input: timeRangeArg,
        hours,
        display,
        start: startTime.toISOString(),
        end: now.toISOString(),
      },
      projects: projectStats.map((p) => ({
        path: p.project_path,
        name: p.project_name || basename(p.project_path),
        completed: p.completed,
        failed: p.failed,
        skipped: p.skipped,
        partial: p.partial,
        disputed: p.disputed,
        total: p.total,
        tasksPerHour: p.total > 0 ? (p.total / hours).toFixed(2) : '0',
        successRate:
          p.total > 0 ? ((p.completed / p.total) * 100).toFixed(1) : '0',
        firstActivity: p.first_activity,
        lastActivity: p.last_activity,
      })),
      totals: {
        ...totals,
        tasksPerHour,
        successRate,
      },
    });
    return;
  }

  // Human-readable output
  out.log('');
  out.log(colors.bold(`Stats for the past ${display}`));
  out.log(colors.dim(`${formatDate(startTime)} - ${formatDate(now)}`));
  out.log('');

  if (projectStats.length === 0) {
    out.log(colors.dim('No activity recorded in this time period.'));
    out.log('');
    return;
  }

  // Per-project stats
  out.log(colors.bold('By Project:'));
  out.log('─'.repeat(80));

  for (const project of projectStats) {
    const name = project.project_name || basename(project.project_path);
    const projectTasksPerHour =
      project.total > 0 ? (project.total / hours).toFixed(2) : '0';
    const projectSuccessRate =
      project.total > 0
        ? ((project.completed / project.total) * 100).toFixed(1)
        : '0';

    out.log('');
    out.log(`  ${colors.cyan(name)}`);
    out.log(`  ${colors.dim(project.project_path)}`);
    out.log('');
    out.log(
      `    ${colors.green('✓')} Completed: ${formatNumber(project.completed)}`
    );
    if (project.failed > 0) {
      out.log(
        `    ${colors.red('✗')} Failed:    ${formatNumber(project.failed)}`
      );
    }
    if (project.skipped > 0) {
      out.log(
        `    ${colors.yellow('○')} Skipped:   ${formatNumber(project.skipped)}`
      );
    }
    if (project.partial > 0) {
      out.log(
        `    ${colors.yellow('◐')} Partial:   ${formatNumber(project.partial)}`
      );
    }
    if (project.disputed > 0) {
      out.log(
        `    ${colors.magenta('!')} Disputed:  ${formatNumber(project.disputed)}`
      );
    }
    out.log('');
    out.log(
      `    Rate: ${projectTasksPerHour} tasks/hour  |  Success: ${projectSuccessRate}%`
    );
  }

  // Overall totals
  out.log('');
  out.log('─'.repeat(80));
  out.log(colors.bold('Overall:'));
  out.log('');
  out.log(`  ${colors.green('✓')} Completed: ${formatNumber(totals.completed)}`);
  if (totals.failed > 0) {
    out.log(`  ${colors.red('✗')} Failed:    ${formatNumber(totals.failed)}`);
  }
  if (totals.skipped > 0) {
    out.log(`  ${colors.yellow('○')} Skipped:   ${formatNumber(totals.skipped)}`);
  }
  if (totals.partial > 0) {
    out.log(`  ${colors.yellow('◐')} Partial:   ${formatNumber(totals.partial)}`);
  }
  if (totals.disputed > 0) {
    out.log(`  ${colors.magenta('!')} Disputed:  ${formatNumber(totals.disputed)}`);
  }
  out.log('');
  out.log(`  Total: ${formatNumber(totals.total)} tasks`);
  out.log(`  Rate:  ${tasksPerHour} tasks/hour`);
  out.log(`  Success Rate: ${successRate}%`);
  out.log('');
}

async function purgeCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'stats', subcommand: 'purge', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    out.log(`
steroids stats purge - Purge activity log entries

USAGE:
  steroids stats purge [time-range] [options]

ARGUMENTS:
  time-range        Keep entries newer than this, delete older
                    If not specified, delete ALL entries (requires --force)

OPTIONS:
  --force           Required when purging all entries
  -j, --json        Output as JSON
  -h, --help        Show help

EXAMPLES:
  steroids stats purge 30d       # Keep last 30 days
  steroids stats purge 7d        # Keep last 7 days
  steroids stats purge --force   # Delete ALL entries
`);
    return;
  }

  const timeRangeArg = positionals[0];
  let keepHours: number | undefined;
  let display: string;

  if (timeRangeArg) {
    try {
      const parsed = parseTimeRange(timeRangeArg);
      keepHours = parsed.hours;
      display = parsed.display;
    } catch (error) {
      out.error('INVALID_ARGUMENTS', (error as Error).message);
      process.exit(1);
    }
  } else {
    // No time range = purge all
    if (!values.force) {
      out.error(
        'REQUIRES_FORCE',
        'Purging ALL entries requires --force flag'
      );
      out.log('');
      out.log('To purge all activity log entries:');
      out.log('  steroids stats purge --force');
      out.log('');
      out.log('To keep recent entries:');
      out.log('  steroids stats purge 30d   # Keep last 30 days');
      process.exit(1);
    }
    display = 'all';
  }

  // Get count before purge
  const countBefore = getActivityCount();

  // Perform purge
  const deleted = purgeActivity(keepHours);

  if (flags.json) {
    out.success({
      deleted,
      countBefore,
      countAfter: countBefore - deleted,
      keepHours: keepHours ?? null,
      display,
    });
    return;
  }

  if (keepHours !== undefined) {
    out.log('');
    out.log(
      `Purged ${formatNumber(deleted)} activity log entries older than ${display}.`
    );
    out.log(`Remaining entries: ${formatNumber(countBefore - deleted)}`);
    out.log('');
  } else {
    out.log('');
    out.log(`Purged all ${formatNumber(deleted)} activity log entries.`);
    out.log('');
  }
}
