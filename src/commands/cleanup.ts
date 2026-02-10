import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids cleanup - Cleanup utilities (non-destructive retention)
 *
 * Subcommands:
 * - logs: Clean up old invocation activity logs (.steroids/invocations/*.log)
 */

import { parseArgs } from 'node:util';
import { isInitialized } from '../database/connection.js';
import { generateHelp } from '../cli/help.js';
import { cleanupInvocationLogs } from '../cleanup/invocation-logs.js';

const HELP = generateHelp({
  command: 'cleanup',
  description: 'Cleanup utilities',
  details: `Cleanup operations that are safe to run regularly (retention-based).`,
  usage: [
    'steroids cleanup <subcommand> [options]',
  ],
  subcommands: [
    { name: 'logs', description: 'Clean up old invocation activity logs' },
  ],
  options: [
    { long: 'retention-days', description: 'Days to keep invocation activity logs (logs)', values: '<n>', default: '7' },
  ],
  examples: [
    { command: 'steroids cleanup logs', description: 'Delete invocation activity logs older than 7 days' },
    { command: 'steroids cleanup logs --retention-days 30', description: 'Keep 30 days of invocation activity logs' },
    { command: 'steroids cleanup logs --dry-run', description: 'Preview what would be deleted' },
  ],
  related: [
    { command: 'steroids logs', description: 'View invocation logs' },
    { command: 'steroids gc', description: 'Garbage collection' },
    { command: 'steroids purge', description: 'Purge old data' },
  ],
});

export async function cleanupCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'logs':
      await cleanupLogs(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function cleanupLogs(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'retention-days': { type: 'string', default: '7' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids cleanup logs - Clean up old invocation activity logs

USAGE:
  steroids cleanup logs [options]

OPTIONS:
  --retention-days <n>   Days to keep invocation activity logs (default: 7)
  --dry-run              Preview without deleting files (global)
  -j, --json             Output as JSON (global)
  -h, --help             Show help
`);
    return;
  }

  const projectPath = process.cwd();
  if (!isInitialized(projectPath)) {
    console.error('Steroids not initialized. Run "steroids init" first.');
    process.exit(1);
  }

  const retentionDays = parseInt(values['retention-days'] ?? '7', 10);
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    console.error(`Invalid --retention-days value: ${values['retention-days']}. Must be >= 0.`);
    process.exit(1);
  }

  const result = cleanupInvocationLogs(projectPath, { retentionDays, dryRun: flags.dryRun });

  if (flags.json) {
    console.log(JSON.stringify({
      success: true,
      command: 'cleanup logs',
      dryRun: flags.dryRun,
      data: {
        retentionDays,
        scannedFiles: result.scannedFiles,
        deletedFiles: result.deletedFiles,
        freedBytes: result.freedBytes,
      },
      error: null,
    }, null, 2));
    return;
  }

  const prefix = flags.dryRun ? 'Would delete' : 'Deleted';
  console.log(`${prefix} ${result.deletedFiles} invocation activity log file(s) (scanned ${result.scannedFiles}, freed ${formatSize(result.freedBytes)}).`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

