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
 *   ack          Acknowledge monitor alerts
 */

import { basename } from 'node:path';
import type { GlobalFlags } from '../cli/flags.js';
import { generateHelp } from '../cli/help.js';
import { openGlobalDatabase } from '../runners/global-db-connection.js';
import { runRespondCmd, runAckCmd } from './monitor-respond.js';

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
    { name: 'ack', args: '--alert-id <id> | --all', description: 'Acknowledge monitor alerts' },
  ],
  options: [
    { long: 'run-id', description: 'Monitor run ID for first responder dispatch', values: '<id>' },
    { long: 'alert-id', description: 'Alert ID to acknowledge', values: '<id>' },
    { long: 'all', description: 'Acknowledge all unacknowledged alerts' },
  ],
  examples: [
    { command: 'steroids monitor status', description: 'Show config and last run' },
    { command: 'steroids monitor enable', description: 'Enable the monitor' },
    { command: 'steroids monitor disable', description: 'Disable the monitor' },
    { command: 'steroids monitor scan', description: 'Run a scan now' },
    { command: 'steroids monitor run', description: 'Run full scan+rules cycle' },
    { command: 'steroids monitor respond --run-id 42', description: 'Dispatch first responder for run 42' },
    { command: 'steroids monitor ack --alert-id 1', description: 'Acknowledge alert #1' },
    { command: 'steroids monitor ack --all', description: 'Acknowledge all alerts' },
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
    case 'ack':
      await runAckCmd(subArgs, flags);
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

    // M8: Fetch unacknowledged alerts
    let alerts: Array<{ id: number; alert_type: string; project_path: string | null; message: string; created_at: number }> = [];
    try {
      alerts = db.prepare(
        'SELECT id, alert_type, project_path, message, created_at FROM monitor_alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT 10'
      ).all() as typeof alerts;
    } catch {
      // Table may not exist on older schema
    }

    if (flags.json) {
      console.log(JSON.stringify({ config: config ?? null, lastRun: lastRun ?? null, alerts }, null, 2));
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

    // M8: Show unacknowledged alerts
    if (alerts.length > 0) {
      console.log('');
      console.log('ALERTS (unacknowledged)');
      console.log('-'.repeat(50));
      for (const alert of alerts) {
        const project = alert.project_path ? basename(alert.project_path) : 'system';
        const age = Math.round((Date.now() - alert.created_at) / 60000);
        console.log(`  [#${alert.id}] ${project} (${age}m ago): ${alert.message}`);
      }
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

// ── Shared helpers ─────────────────────────────────────────────────────────

function safeJsonParse(str: string | null | undefined): any {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
