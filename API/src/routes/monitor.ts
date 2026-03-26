/**
 * Monitor API routes
 * Config CRUD, run history, and manual scan/run triggers.
 */

import { Router, Request, Response } from 'express';
import {
  getCanonicalResponseMode,
  requiresManualInvestigationOverride,
  validateResponsePreset,
} from '../../../src/monitor/response-mode.js';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';
import {
  formatRunRow,
  type MonitorConfigRow,
  type MonitorRunRow,
  safeJsonParse,
} from './monitor-shared.js';

const router = Router();

// ── Config endpoints ─────────────────────────────────────────────────────────

router.get('/monitor/config', (_req: Request, res: Response) => {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare('SELECT * FROM monitor_config WHERE id = 1').get() as MonitorConfigRow | undefined;
    if (!row) {
      res.json({ success: true, config: null });
      return;
    }
    res.json({
      success: true,
      config: {
        enabled: Boolean(row.enabled),
        interval_seconds: row.interval_seconds,
        first_responder_agents: safeJsonParse<unknown[]>(row.first_responder_agents, []),
        response_preset: row.response_preset,
        canonical_response_mode: getCanonicalResponseMode(row.response_preset),
        response_preset_deprecated: row.response_preset !== getCanonicalResponseMode(row.response_preset),
        custom_prompt: row.custom_prompt,
        escalation_rules: safeJsonParse<Record<string, unknown>>(row.escalation_rules, { min_severity: 'critical' }),
        first_responder_timeout_seconds: row.first_responder_timeout_seconds,
        updated_at: row.updated_at,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to read monitor config',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.put('/monitor/config', (req: Request, res: Response) => {
  const {
    enabled,
    interval_seconds,
    first_responder_agents,
    response_preset,
    custom_prompt,
    escalation_rules,
    first_responder_timeout_seconds,
  } = req.body;

  const { db, close } = openGlobalDatabase();
  try {
    const existing = db.prepare('SELECT * FROM monitor_config WHERE id = 1').get() as MonitorConfigRow | undefined;
    if (!existing) {
      res.status(500).json({ success: false, error: 'Monitor config row not found' });
      return;
    }

    const nextPreset = response_preset !== undefined ? response_preset : existing.response_preset;
    const nextCustomPrompt = custom_prompt !== undefined ? (custom_prompt === null ? null : String(custom_prompt)) : existing.custom_prompt;
    const validationError = validateResponsePreset(nextPreset, nextCustomPrompt);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    if (enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    if (interval_seconds !== undefined) {
      sets.push('interval_seconds = ?');
      params.push(Number(interval_seconds));
    }
    if (first_responder_agents !== undefined) {
      sets.push('first_responder_agents = ?');
      params.push(JSON.stringify(first_responder_agents));
    }
    if (response_preset !== undefined) {
      sets.push('response_preset = ?');
      params.push(String(response_preset));
    }
    if (custom_prompt !== undefined) {
      sets.push('custom_prompt = ?');
      params.push(nextCustomPrompt);
    }
    if (escalation_rules !== undefined) {
      sets.push('escalation_rules = ?');
      params.push(JSON.stringify(escalation_rules));
    }
    if (first_responder_timeout_seconds !== undefined) {
      sets.push('first_responder_timeout_seconds = ?');
      params.push(Number(first_responder_timeout_seconds));
    }

    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    sets.push('updated_at = ?');
    params.push(Date.now());

    db.prepare(`UPDATE monitor_config SET ${sets.join(', ')} WHERE id = 1`).run(...params);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to update monitor config',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

// ── Run history endpoints ────────────────────────────────────────────────────

router.get('/monitor/runs', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const { db, close } = openGlobalDatabase();
  try {
    const runs = db
      .prepare('SELECT * FROM monitor_runs ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as MonitorRunRow[];

    const total = (db.prepare('SELECT COUNT(*) as count FROM monitor_runs').get() as { count: number }).count;

    res.json({
      success: true,
      total,
      runs: runs.map(formatRunRow),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list monitor runs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.get('/monitor/runs/:id', (req: Request, res: Response) => {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare('SELECT * FROM monitor_runs WHERE id = ?')
      .get(Number(req.params.id)) as MonitorRunRow | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    res.json({ success: true, run: formatRunRow(row) });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get monitor run',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.post('/monitor/runs/clear', (_req: Request, res: Response) => {
  const { db, close } = openGlobalDatabase();
  try {
    const result = db.prepare('DELETE FROM monitor_runs').run();
    res.json({ success: true, deleted: result.changes });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to clear monitor runs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

// ── Manual trigger endpoints ─────────────────────────────────────────────────

router.post('/monitor/scan', async (_req: Request, res: Response) => {
  try {
    const { runScan } = await import('../../../dist/monitor/scanner.js');
    const result = await runScan();
    res.json({ success: true, scan: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Scan failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/monitor/run', async (req: Request, res: Response) => {
  const preset = typeof req.body?.preset === 'string' ? req.body.preset : undefined;
  const forceDispatch = req.body?.forceDispatch === true;

  // Idempotency: reject if first responder already in progress
  const { db, close } = openGlobalDatabase();
  try {
    const config = db.prepare('SELECT * FROM monitor_config WHERE id = 1').get() as MonitorConfigRow | undefined;
    if (!config) {
      res.status(500).json({ success: false, error: 'Monitor config row not found' });
      close();
      return;
    }
    const validationError = validateResponsePreset(preset ?? config?.response_preset, config?.custom_prompt ?? null);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      close();
      return;
    }

    const active = db
      .prepare("SELECT id FROM monitor_runs WHERE outcome = 'first_responder_dispatched'")
      .get() as { id: number } | undefined;

    if (active) {
      res.status(409).json({
        success: false,
        error: 'First responder already in progress',
        run_id: active.id,
      });
      close();
      return;
    }
    close();

    const { runMonitorCycle } = await import('../../../dist/monitor/loop.js');
    const result = await runMonitorCycle({ manual: true, preset, forceDispatch });
    res.json({ success: true, result });
  } catch (error) {
    try { close(); } catch { /* already closed */ }
    res.status(500).json({
      success: false,
      error: 'Monitor run failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ── Dispatch first responder for a specific run ──────────────────────────────

router.post('/monitor/runs/:id/investigate', async (req: Request, res: Response) => {
  const runId = Number(req.params.id);
  const preset = typeof req.body?.preset === 'string' ? req.body.preset : undefined;
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare('SELECT * FROM monitor_runs WHERE id = ?')
      .get(runId) as MonitorRunRow | undefined;
    const config = db.prepare('SELECT * FROM monitor_config WHERE id = 1').get() as MonitorConfigRow | undefined;

    if (!row) {
      res.status(404).json({ success: false, error: 'Run not found' });
      close();
      return;
    }
    if (!config) {
      res.status(500).json({ success: false, error: 'Monitor config row not found' });
      close();
      return;
    }
    if (!preset && requiresManualInvestigationOverride(config.response_preset)) {
      res.status(400).json({
        success: false,
        error: 'Manual investigation from monitor_only requires an explicit preset override',
      });
      close();
      return;
    }
    const validationError = validateResponsePreset(preset ?? config.response_preset, config.custom_prompt);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      close();
      return;
    }

    // Check if first responder already active
    const active = db
      .prepare("SELECT id FROM monitor_runs WHERE outcome = 'first_responder_dispatched'")
      .get() as { id: number } | undefined;

    if (active) {
      res.status(409).json({
        success: false,
        error: 'First responder already in progress',
        run_id: active.id,
      });
      close();
      return;
    }

    // Mark this run as first_responder_dispatched
    db.prepare(
      "UPDATE monitor_runs SET outcome = 'first_responder_dispatched', completed_at = NULL WHERE id = ?"
    ).run(runId);
    close();

    // Spawn detached first responder process
    const { spawn } = await import('node:child_process');
    const { resolveCliEntrypoint } = await import('../../../dist/cli/entrypoint.js');
    const entrypoint = resolveCliEntrypoint();
    if (!entrypoint) {
      // Revert outcome
      const { db: db2, close: close2 } = openGlobalDatabase();
      try {
        db2.prepare("UPDATE monitor_runs SET outcome = 'error', error = 'CLI entrypoint not found' WHERE id = ?").run(runId);
      } finally { close2(); }
      res.status(500).json({ success: false, error: 'CLI entrypoint not found' });
      return;
    }

    const cliArgs = [entrypoint, 'monitor', 'respond', '--run-id', String(runId)];
    if (preset) cliArgs.push('--preset', preset);

    const child = spawn(
      process.execPath,
      cliArgs,
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    res.json({ success: true, run_id: runId, status: 'first_responder_dispatched' });

  } catch (error) {
    try { close(); } catch { /* already closed */ }
    res.status(500).json({
      success: false,
      error: 'Failed to start first responder',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ── GitHub integration ────────────────────────────────────────────────────────

router.get('/monitor/gh-available', async (_req: Request, res: Response) => {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 5000 });
    res.json({ available: true });
  } catch {
    res.json({ available: false });
  }
});

router.post('/monitor/runs/:id/report-issue', async (req: Request, res: Response) => {
  const runId = Number(req.params.id);
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare('SELECT * FROM monitor_runs WHERE id = ?')
      .get(runId) as MonitorRunRow | undefined;
    close();

    if (!row) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    const scanResults = safeJsonParse(row.scan_results, null) as {
      anomalies?: Array<{ type: string; severity: string; message: string; projectName?: string }>;
    } | null;
    const anomalies = scanResults?.anomalies ?? [];
    if (anomalies.length === 0) {
      res.status(400).json({ success: false, error: 'No anomalies to report' });
      return;
    }

    const report = row.first_responder_report ?? '';
    const actions = safeJsonParse(row.first_responder_actions, []) as Array<{ tool: string; input: string }>;
    const actionResults = safeJsonParse(row.action_results, []) as Array<{ success: boolean; output?: string }>;

    // Build issue body
    const anomalyList = anomalies
      .map((a, i) => `${i + 1}. **[${a.severity}]** ${a.message}${a.projectName ? ` (${a.projectName})` : ''}`)
      .join('\n');

    const actionList = actions.length > 0
      ? actions.map((a, i) => {
          const result = actionResults[i];
          return `- **${a.tool}**: ${result?.success ? 'Success' : 'Failed'}`;
        }).join('\n')
      : '_No actions taken_';

    const body = `## Monitor Run #${runId}

**Detected at:** ${new Date(row.started_at).toISOString()}
**Outcome:** ${row.outcome}

### Anomalies

${anomalyList}

### First Responder Report

${report || '_No report available_'}

### Actions Taken

${actionList}

---
_Auto-reported by steroids monitor_`;

    const title = `[Monitor] ${anomalies.length} anomaly/anomalies detected (run #${runId})`;

    // Use gh to create issue (execFileSync prevents shell injection)
    const { execFileSync } = await import('node:child_process');
    const result = execFileSync(
      'gh',
      ['issue', 'create', '--title', title, '--body', body, '--label', 'monitor,auto-reported'],
      { stdio: 'pipe', timeout: 30000, encoding: 'utf-8' }
    );

    const issueUrl = result.trim();
    res.json({ success: true, issueUrl });
  } catch (error) {
    try { close(); } catch { /* already closed */ }
    res.status(500).json({
      success: false,
      error: 'Failed to create issue',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
