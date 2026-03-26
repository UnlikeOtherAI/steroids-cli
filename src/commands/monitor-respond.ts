/**
 * Monitor respond + ack subcommands — extracted from monitor.ts for file-size limits.
 */

import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import {
  requiresManualInvestigationOverride,
  resolveStoredMonitorResponsePreset,
  validateResponsePreset,
} from '../monitor/response-mode.js';
import { openGlobalDatabase } from '../runners/global-db-connection.js';

// ── Types (shared with monitor.ts) ──────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────

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

// ── respond (first responder) ──────────────────────────────────────────

export async function runRespondCmd(args: string[], flags: GlobalFlags): Promise<void> {
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
  --preset <preset>  Override response mode (triage_only, fix_and_monitor, custom, plus legacy aliases)
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
  if (!presetOverride && requiresManualInvestigationOverride(config.response_preset)) {
    updateRunError(runId, 'Manual investigation from monitor_only requires an explicit override');
    console.error('Error: manual investigation from monitor_only requires --preset triage_only, fix_and_monitor, or custom');
    process.exit(2);
  }

  const requestedPreset = presetOverride || config.response_preset;
  const validationError = validateResponsePreset(requestedPreset, config.custom_prompt);
  if (validationError) {
    updateRunError(runId, validationError);
    console.error(`Error: ${validationError}`);
    process.exit(2);
  }
  const responsePreset = resolveStoredMonitorResponsePreset(requestedPreset);

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

// ── ack ───────────────────────────────────────────────────────────────────

export async function runAckCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'alert-id': { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    console.log(`
steroids monitor ack - Acknowledge monitor alerts

USAGE:
  steroids monitor ack --alert-id <id>
  steroids monitor ack --all

OPTIONS:
  --alert-id <id>  Acknowledge a specific alert by ID
  --all            Acknowledge all unacknowledged alerts
  -h, --help       Show help
`);
    return;
  }

  const alertIdStr = values['alert-id'] as string | undefined;
  const ackAll = values.all as boolean;

  if (!alertIdStr && !ackAll) {
    console.error('Error: --alert-id <id> or --all is required');
    process.exit(2);
  }

  const { db, close } = openGlobalDatabase();
  try {
    const now = Date.now();
    if (ackAll) {
      const result = db.prepare(
        'UPDATE monitor_alerts SET acknowledged = 1, acknowledged_at = ? WHERE acknowledged = 0'
      ).run(now);
      if (flags.json) {
        console.log(JSON.stringify({ success: true, acknowledged: result.changes }));
      } else {
        console.log(result.changes > 0
          ? `Acknowledged ${result.changes} alert(s).`
          : 'No unacknowledged alerts.');
      }
    } else {
      const alertId = parseInt(alertIdStr!, 10);
      if (isNaN(alertId) || alertId <= 0) {
        console.error(`Error: invalid alert ID "${alertIdStr}"`);
        process.exit(2);
      }
      const result = db.prepare(
        'UPDATE monitor_alerts SET acknowledged = 1, acknowledged_at = ? WHERE id = ? AND acknowledged = 0'
      ).run(now, alertId);
      if (result.changes === 0) {
        if (flags.json) {
          console.log(JSON.stringify({ success: false, error: 'Alert not found or already acknowledged' }));
        } else {
          console.error('Alert not found or already acknowledged.');
        }
        process.exit(1);
      }
      if (flags.json) {
        console.log(JSON.stringify({ success: true, alertId }));
      } else {
        console.log(`Alert #${alertId} acknowledged.`);
      }
    }
  } finally {
    close();
  }
}
