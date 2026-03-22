/**
 * steroids monitor - Monitor system health and dispatch first responder
 *
 * Subcommands:
 *   status       Show current monitor configuration and state
 *   enable       Enable the monitor
 *   disable      Disable the monitor
 *   scan         Run a scan and print results
 *   run          Run full cycle (scan + rules, no first responder)
 *   respond      Dispatch first responder for a specific run (detached from wakeup)
 *   investigate  Alias for respond (backward compat)
 */

import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import { generateHelp } from '../cli/help.js';
import { openGlobalDatabase } from '../runners/global-db-connection.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface MonitorConfigRow {
  id: number;
  enabled: number;
  interval_seconds: number;
  first_responder_agents: string;
  response_preset: string;
  custom_prompt: string | null;
  escalation_rules: string;
  first_responder_timeout_seconds: number;
  updated_at: number;
}

interface MonitorRunRow {
  id: number;
  started_at: number;
  completed_at: number | null;
  outcome: string;
  scan_results: string | null;
  escalation_reason: string | null;
  first_responder_needed: number;
  first_responder_agent: string | null;
  first_responder_actions: string | null;
  first_responder_report: string | null;
  action_results: string | null;
  error: string | null;
}

// ── Help ───────────────────────────────────────────────────────────────────

const HELP = generateHelp({
  command: 'monitor',
  description: 'Monitor system health and dispatch first responder',
  details: `The monitor periodically scans all registered projects for anomalies
(stuck tasks, zombie runners, idle projects, etc.) and can dispatch an
AI first responder agent when escalation rules are triggered.`,
  usage: ['steroids monitor <subcommand> [options]'],
  subcommands: [
    { name: 'status', description: 'Show current monitor configuration and state' },
    { name: 'enable', description: 'Enable the monitor' },
    { name: 'disable', description: 'Disable the monitor' },
    { name: 'scan', description: 'Run a scan and print anomaly results' },
    { name: 'run', description: 'Run full cycle (scan + rules, no first responder)' },
    { name: 'respond', args: '--run-id <id>', description: 'Dispatch first responder for a monitor run' },
    { name: 'investigate', args: '--run-id <id>', description: 'Alias for respond' },
  ],
  options: [
    { long: 'run-id', description: 'Monitor run ID for first responder dispatch', values: '<id>' },
  ],
  examples: [
    { command: 'steroids monitor status', description: 'Show config and last run' },
    { command: 'steroids monitor enable', description: 'Enable the monitor' },
    { command: 'steroids monitor disable', description: 'Disable the monitor' },
    { command: 'steroids monitor scan', description: 'Run a scan now' },
    { command: 'steroids monitor run', description: 'Run full scan+rules cycle' },
    { command: 'steroids monitor respond --run-id 42', description: 'Dispatch first responder for run 42' },
  ],
  related: [
    { command: 'steroids health', description: 'Project health checks' },
    { command: 'steroids runners wakeup', description: 'Wake up stale runners' },
  ],
});

// ── Command entry point ────────────────────────────────────────────────────

export async function monitorCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (flags.help && args.length === 0) {
    console.log(HELP);
    return;
  }

  if (args.length === 0) {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'status':
      await runStatus(subArgs, flags);
      break;
    case 'enable':
      await runToggle(true, flags);
      break;
    case 'disable':
      await runToggle(false, flags);
      break;
    case 'scan':
      await runScanCmd(subArgs, flags);
      break;
    case 'run':
      await runCycleCmd(subArgs, flags);
      break;
    case 'respond':
    case 'investigate':
      await runRespondCmd(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

// ── status ─────────────────────────────────────────────────────────────────

async function runStatus(_args: string[], flags: GlobalFlags): Promise<void> {
  const { db, close } = openGlobalDatabase();
  try {
    const config = db.prepare(
      'SELECT * FROM monitor_config WHERE id = 1'
    ).get() as MonitorConfigRow | undefined;

    const lastRun = db.prepare(
      'SELECT * FROM monitor_runs ORDER BY started_at DESC LIMIT 1'
    ).get() as MonitorRunRow | undefined;

    if (flags.json) {
      console.log(JSON.stringify({ config: config ?? null, lastRun: lastRun ?? null }, null, 2));
      return;
    }

    if (!config) {
      console.log('Monitor not configured (no config row found).');
      return;
    }

    const escalation = safeJsonParse(config.escalation_rules);
    const agents = safeJsonParse(config.first_responder_agents);

    console.log('MONITOR STATUS');
    console.log('='.repeat(50));
    console.log(`  Enabled:            ${config.enabled ? 'yes' : 'no'}`);
    console.log(`  Interval:           ${config.interval_seconds}s`);
    console.log(`  Agent count:        ${Array.isArray(agents) ? agents.length : 0}`);
    console.log(`  Response preset:    ${config.response_preset}`);
    console.log(`  Min severity:       ${escalation?.min_severity ?? 'unknown'}`);
    console.log(`  FR timeout:         ${config.first_responder_timeout_seconds}s`);
    console.log(`  Last config update: ${config.updated_at ? new Date(config.updated_at).toISOString() : 'never'}`);
    console.log('');

    if (lastRun) {
      console.log('LAST RUN');
      console.log('-'.repeat(50));
      console.log(`  Run ID:       ${lastRun.id}`);
      console.log(`  Started:      ${new Date(lastRun.started_at).toISOString()}`);
      console.log(`  Completed:    ${lastRun.completed_at ? new Date(lastRun.completed_at).toISOString() : 'in progress'}`);
      console.log(`  Outcome:      ${lastRun.outcome}`);
      if (lastRun.escalation_reason) {
        console.log(`  Escalation:   ${lastRun.escalation_reason}`);
      }
      if (lastRun.error) {
        console.log(`  Error:        ${lastRun.error}`);
      }
    } else {
      console.log('No monitor runs recorded yet.');
    }
  } finally {
    close();
  }
}

// ── enable / disable ───────────────────────────────────────────────────────

async function runToggle(enable: boolean, flags: GlobalFlags): Promise<void> {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      'UPDATE monitor_config SET enabled = ?, updated_at = ? WHERE id = 1'
    ).run(enable ? 1 : 0, Date.now());

    if (flags.json) {
      console.log(JSON.stringify({ success: true, enabled: enable }));
    } else {
      console.log(`Monitor ${enable ? 'enabled' : 'disabled'}.`);
    }
  } finally {
    close();
  }
}

// ── scan ───────────────────────────────────────────────────────────────────

async function runScanCmd(_args: string[], flags: GlobalFlags): Promise<void> {
  const { runScan } = await import('../monitor/scanner.js');
  const result = await runScan();

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Scan complete: ${result.summary}`);
  console.log('');

  if (result.anomalies.length === 0) {
    console.log('No anomalies detected.');
    return;
  }

  console.log('ANOMALIES');
  console.log('-'.repeat(90));
  for (const a of result.anomalies) {
    const sev = a.severity.toUpperCase().padEnd(8);
    const type = a.type.padEnd(22);
    console.log(`  [${sev}] ${type} ${a.projectName}: ${a.details}`);
  }
  console.log('-'.repeat(90));
  console.log(`Total: ${result.anomalies.length} anomaly/anomalies`);
}

// ── run ────────────────────────────────────────────────────────────────────

async function runCycleCmd(_args: string[], flags: GlobalFlags): Promise<void> {
  const { runMonitorCycle } = await import('../monitor/loop.js');
  const result = await runMonitorCycle({ manual: true });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Monitor cycle complete.`);
  console.log(`  Outcome:    ${result.outcome}`);
  console.log(`  Anomalies:  ${result.anomalyCount}`);
  if (result.runId !== undefined) {
    console.log(`  Run ID:     ${result.runId}`);
  }
  if (result.escalationReason) {
    console.log(`  Escalation: ${result.escalationReason}`);
  }
  if (result.error) {
    console.error(`  Error:      ${result.error}`);
  }
}

// ── respond (first responder) ──────────────────────────────────────────────

async function runRespondCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'run-id': { type: 'string' },
      preset: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    console.log(`
steroids monitor respond - Dispatch first responder for a monitor run

USAGE:
  steroids monitor respond --run-id <id> [--preset <preset>]

OPTIONS:
  --run-id <id>      Monitor run ID to dispatch first responder for (required)
  --preset <preset>  Override response preset (stop_on_error, investigate_and_stop, fix_and_monitor, custom)
  -h, --help         Show help
`);
    return;
  }

  const runIdStr = values['run-id'] as string | undefined;
  if (!runIdStr) {
    console.error('Error: --run-id is required');
    process.exit(2);
  }

  const runId = parseInt(runIdStr, 10);
  if (isNaN(runId) || runId <= 0) {
    console.error(`Error: invalid run ID "${runIdStr}"`);
    process.exit(2);
  }

  // Read the monitor_runs row
  const { db, close } = openGlobalDatabase();
  let runRow: MonitorRunRow | undefined;
  let config: MonitorConfigRow | undefined;
  try {
    runRow = db.prepare('SELECT * FROM monitor_runs WHERE id = ?').get(runId) as MonitorRunRow | undefined;
    config = db.prepare('SELECT * FROM monitor_config WHERE id = 1').get() as MonitorConfigRow | undefined;
  } finally {
    close();
  }

  if (!runRow) {
    console.error(`Error: monitor run ${runId} not found`);
    process.exit(4);
  }

  if (!config) {
    console.error('Error: monitor_config row not found');
    process.exit(3);
  }

  // Parse scan results from the row
  const scanResults = safeJsonParse(runRow.scan_results);
  if (!scanResults) {
    updateRunError(runId, 'No scan_results in monitor_runs row');
    console.error('Error: no scan_results in monitor_runs row');
    process.exit(1);
  }

  // Parse first responder agents and response preset from config
  const agents = safeJsonParse(config.first_responder_agents) as
    Array<{ provider: string; model: string }> | null;
  const presetOverride = values.preset as string | undefined;
  const responsePreset = presetOverride || config.response_preset;

  if (!Array.isArray(agents) || agents.length === 0) {
    updateRunError(runId, 'No first responder agents configured');
    console.error('Error: no first responder agents configured');
    process.exit(1);
  }

  // Dynamically import the first responder agent module
  const { runFirstResponder } = await import('../monitor/investigator-agent.js');

  // Run the first responder
  try {
    const result = await runFirstResponder(
      agents,
      scanResults,
      responsePreset,
      config.custom_prompt,
    );

    // Determine outcome based on result
    const outcome = result.success ? 'first_responder_complete' : 'error';

    // Update the monitor_runs row with results
    const { db: db2, close: close2 } = openGlobalDatabase();
    try {
      db2.prepare(
        `UPDATE monitor_runs
         SET outcome = ?,
             first_responder_agent = ?,
             first_responder_report = ?,
             first_responder_actions = ?,
             action_results = ?,
             completed_at = ?,
             error = ?
         WHERE id = ?`
      ).run(
        outcome,
        result.agentUsed,
        result.diagnosis,
        JSON.stringify(result.actions),
        JSON.stringify(result.actionResults),
        Date.now(),
        result.error ?? null,
        runId,
      );
    } finally {
      close2();
    }

    if (flags.json) {
      console.log(JSON.stringify({
        success: result.success,
        runId,
        outcome,
        agent: result.agentUsed,
        diagnosis: result.diagnosis,
        actions: result.actions,
        actionResults: result.actionResults,
        error: result.error,
      }, null, 2));
    } else {
      if (result.success) {
        console.log(`First responder complete for run ${runId}.`);
        console.log(`  Agent:   ${result.agentUsed}`);
        console.log(`  Actions: ${result.actions.length}`);
        console.log('');
        console.log('DIAGNOSIS:');
        console.log(result.diagnosis);
      } else {
        console.error(`First responder failed for run ${runId}: ${result.error}`);
      }
    }

    // After successful fix, trigger a follow-up scan so the dashboard shows fresh state.
    // Do NOT pass manual:true — that bypasses duplicate detection and causes infinite dispatch chains (M1).
    if (result.success) {
      try {
        const { runMonitorCycle } = await import('../monitor/loop.js');
        await runMonitorCycle();
      } catch {
        // Follow-up scan is best-effort; don't fail the respond command
      }
    }

    if (!result.success) {
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown first responder error';
    updateRunError(runId, msg);

    if (flags.json) {
      console.log(JSON.stringify({ success: false, runId, error: msg }, null, 2));
    } else {
      console.error(`First responder failed for run ${runId}: ${msg}`);
    }
    process.exit(1);
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function safeJsonParse(str: string | null | undefined): any {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function updateRunError(runId: number, error: string): void {
  try {
    const { db, close } = openGlobalDatabase();
    try {
      db.prepare(
        `UPDATE monitor_runs SET outcome = 'error', error = ?, completed_at = ? WHERE id = ?`
      ).run(error, Date.now(), runId);
    } finally {
      close();
    }
  } catch {
    // Best-effort — don't mask the original error
  }
}
