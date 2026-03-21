/**
 * Monitor loop — ties scanner, rules engine, and investigator together.
 *
 * Two entry points:
 * 1. monitorCheck() — called from wakeup, must complete in <5s.
 *    Runs scanner + rules, spawns detached investigate process if needed.
 * 2. runMonitorCycle() — manual trigger from API/CLI.
 *    Runs scanner + rules inline, returns result (no LLM invocation inline).
 */

import { spawn } from 'node:child_process';
import { openGlobalDatabase } from '../runners/global-db-connection.js';
import { resolveCliEntrypoint } from '../cli/entrypoint.js';
import { runScan, type ScanResult } from './scanner.js';
import { shouldEscalate, type EscalationRules } from './rules.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface MonitorConfig {
  enabled: number;
  interval_seconds: number;
  investigator_agents: string;
  response_preset: string;
  custom_prompt: string | null;
  escalation_rules: string;
  investigation_timeout_seconds: number;
  updated_at: number;
}

export interface MonitorCycleResult {
  outcome: 'clean' | 'anomalies_found' | 'investigation_dispatched' | 'skipped' | 'error';
  runId?: number;
  anomalyCount: number;
  escalationReason?: string;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

function readConfig(): MonitorConfig | null {
  const { db, close } = openGlobalDatabase();
  try {
    return db.prepare('SELECT * FROM monitor_config WHERE id = 1').get() as MonitorConfig | undefined ?? null;
  } finally {
    close();
  }
}

function getLastRunStartedAt(): number {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare(
      'SELECT started_at FROM monitor_runs ORDER BY started_at DESC LIMIT 1'
    ).get() as { started_at: number } | undefined;
    return row?.started_at ?? 0;
  } finally {
    close();
  }
}

function hasActiveInvestigation(timeoutSeconds: number): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare(
      "SELECT id, started_at FROM monitor_runs WHERE outcome = 'investigation_dispatched' LIMIT 1"
    ).get() as { id: number; started_at: number } | undefined;

    if (!row) return false;

    // Check if stale
    const ageMs = Date.now() - row.started_at;
    if (ageMs > timeoutSeconds * 1000) {
      // Mark as timed out
      db.prepare(
        "UPDATE monitor_runs SET outcome = 'error', error = 'Investigation timed out', completed_at = ? WHERE id = ?"
      ).run(Date.now(), row.id);
      return false;
    }

    return true;
  } finally {
    close();
  }
}

/**
 * Returns true if the new scan's anomalies are identical to the most recent run.
 * Compares a normalised fingerprint: sorted type+severity+projectPath+taskId tuples.
 */
function isDuplicateOfLastRun(scanResult: ScanResult): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare(
      'SELECT scan_results FROM monitor_runs ORDER BY started_at DESC LIMIT 1'
    ).get() as { scan_results: string | null } | undefined;
    if (!row?.scan_results) return false;

    const prev = safeJsonParse<ScanResult | null>(row.scan_results, null);
    if (!prev) return false;

    const fingerprint = (s: ScanResult) =>
      s.anomalies
        .map(a => `${a.type}|${a.severity}|${a.projectPath}|${a.taskId ?? ''}|${a.runnerId ?? ''}`)
        .sort()
        .join('\n');

    return fingerprint(scanResult) === fingerprint(prev);
  } finally {
    close();
  }
}

function createRunRow(scanResult: ScanResult, escalationReason: string | null, investigationNeeded: boolean): number {
  const { db, close } = openGlobalDatabase();
  try {
    const outcome = investigationNeeded
      ? 'investigation_dispatched'
      : scanResult.anomalies.length > 0
        ? 'anomalies_found'
        : 'clean';

    const result = db.prepare(
      `INSERT INTO monitor_runs (started_at, completed_at, outcome, scan_results, escalation_reason, investigation_needed)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      scanResult.timestamp,
      investigationNeeded ? null : Date.now(),
      outcome,
      JSON.stringify(scanResult),
      escalationReason,
      investigationNeeded ? 1 : 0,
    );
    return Number(result.lastInsertRowid);
  } finally {
    close();
  }
}

function pruneOldRuns(maxRows: number): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `DELETE FROM monitor_runs WHERE id NOT IN (
        SELECT id FROM monitor_runs ORDER BY started_at DESC LIMIT ?
      )`
    ).run(maxRows);
  } finally {
    close();
  }
}

function spawnInvestigator(runId: number): void {
  const entrypoint = resolveCliEntrypoint();
  if (!entrypoint) return;

  const child = spawn(
    process.execPath,
    [entrypoint, 'monitor', 'investigate', '--run-id', String(runId)],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called from wakeup. Must complete in <5s (no LLM calls).
 * If escalation needed, spawns detached `steroids monitor investigate`.
 */
export async function monitorCheck(): Promise<void> {
  const config = readConfig();
  if (!config || !config.enabled) return;

  // Check interval
  const lastRun = getLastRunStartedAt();
  if (Date.now() - lastRun < config.interval_seconds * 1000) return;

  // Check for active investigation (with stale timeout)
  if (hasActiveInvestigation(config.investigation_timeout_seconds)) return;

  // Run scan
  const scanResult = await runScan();

  // Skip if anomalies are identical to the last run (no new information)
  if (isDuplicateOfLastRun(scanResult)) return;

  // Apply rules
  const rules = safeJsonParse<EscalationRules>(config.escalation_rules, { min_severity: 'critical' });
  const decision = shouldEscalate(scanResult.anomalies, rules);

  // Create run row
  const agents = safeJsonParse<Array<{ provider: string; model: string }>>(config.investigator_agents, []);
  const needsInvestigation = decision.escalate && agents.length > 0;

  const runId = createRunRow(scanResult, decision.escalate ? decision.reason : null, needsInvestigation);

  // Prune old runs
  pruneOldRuns(500);

  // If investigation needed, spawn detached process
  if (needsInvestigation) {
    spawnInvestigator(runId);
  }
}

/**
 * Manual trigger from API. Runs scan + rules inline and returns result.
 * Does NOT invoke the investigator LLM (that's a separate detached process).
 */
export async function runMonitorCycle(options?: { manual?: boolean }): Promise<MonitorCycleResult> {
  try {
    const config = readConfig();
    const scanResult = await runScan();

    // Skip duplicate unless this is a manual trigger
    if (!options?.manual && isDuplicateOfLastRun(scanResult)) {
      return { outcome: 'skipped', anomalyCount: scanResult.anomalies.length };
    }

    const rules = safeJsonParse<EscalationRules>(
      config?.escalation_rules ?? null,
      { min_severity: 'critical' },
    );
    const decision = shouldEscalate(scanResult.anomalies, rules);

    const agents = safeJsonParse<Array<{ provider: string; model: string }>>(
      config?.investigator_agents ?? null, [],
    );
    const needsInvestigation = decision.escalate && agents.length > 0;

    const runId = createRunRow(scanResult, decision.escalate ? decision.reason : null, needsInvestigation);

    pruneOldRuns(500);

    if (needsInvestigation) {
      spawnInvestigator(runId);
      return {
        outcome: 'investigation_dispatched',
        runId,
        anomalyCount: scanResult.anomalies.length,
        escalationReason: decision.reason,
      };
    }

    return {
      outcome: scanResult.anomalies.length > 0 ? 'anomalies_found' : 'clean',
      runId,
      anomalyCount: scanResult.anomalies.length,
      escalationReason: decision.escalate ? decision.reason : undefined,
    };
  } catch (err) {
    return {
      outcome: 'error',
      anomalyCount: 0,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
