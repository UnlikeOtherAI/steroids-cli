/**
 * Monitor loop — ties scanner, rules engine, and first responder together.
 *
 * Two entry points:
 * 1. monitorCheck() — called from wakeup, must complete in <5s.
 *    Runs scanner + rules, spawns detached first responder process if needed.
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
  first_responder_agents: string;
  response_preset: string;
  custom_prompt: string | null;
  escalation_rules: string;
  first_responder_timeout_seconds: number;
  updated_at: number;
}

export interface MonitorCycleResult {
  outcome: 'clean' | 'anomalies_found' | 'first_responder_dispatched' | 'skipped' | 'error';
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

function hasActiveFirstResponder(timeoutSeconds: number): boolean {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare(
      "SELECT id, started_at FROM monitor_runs WHERE outcome = 'first_responder_dispatched' LIMIT 1"
    ).get() as { id: number; started_at: number } | undefined;

    if (!row) return false;

    // Check if stale
    const ageMs = Date.now() - row.started_at;
    if (ageMs > timeoutSeconds * 1000) {
      // Mark as timed out
      db.prepare(
        "UPDATE monitor_runs SET outcome = 'error', error = 'First responder timed out', completed_at = ? WHERE id = ?"
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

function createRunRow(scanResult: ScanResult, escalationReason: string | null, firstResponderNeeded: boolean, outcomeOverride?: string): number {
  const { db, close } = openGlobalDatabase();
  try {
    const outcome = outcomeOverride
      ? outcomeOverride
      : firstResponderNeeded
        ? 'first_responder_dispatched'
        : scanResult.anomalies.length > 0
          ? 'anomalies_found'
          : 'clean';

    const result = db.prepare(
      `INSERT INTO monitor_runs (started_at, completed_at, outcome, scan_results, escalation_reason, first_responder_needed)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      scanResult.timestamp,
      firstResponderNeeded ? null : Date.now(),
      outcome,
      JSON.stringify(scanResult),
      escalationReason,
      firstResponderNeeded ? 1 : 0,
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

function spawnFirstResponder(runId: number, preset?: string): void {
  const entrypoint = resolveCliEntrypoint();
  if (!entrypoint) return;

  const args = [entrypoint, 'monitor', 'respond', '--run-id', String(runId)];
  if (preset) args.push('--preset', preset);

  const child = spawn(
    process.execPath,
    args,
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

/**
 * Compute anomaly fingerprint for a project: sorted anomaly types joined.
 */
function computeAnomalyFingerprint(scanResult: ScanResult, projectPath: string): string {
  return scanResult.anomalies
    .filter(a => a.projectPath === projectPath)
    .map(a => a.type)
    .sort()
    .join(',');
}

/**
 * Count previous remediation attempts for a project+fingerprint.
 */
function countRemediationAttempts(projectPath: string, fingerprint: string): number {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM monitor_remediation_attempts WHERE project_path = ? AND anomaly_fingerprint = ?'
    ).get(projectPath, fingerprint) as { count: number };
    return row.count;
  } finally {
    close();
  }
}

/**
 * Record a remediation attempt.
 */
function recordRemediationAttempt(projectPath: string, fingerprint: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      'INSERT INTO monitor_remediation_attempts (project_path, anomaly_fingerprint, attempted_at) VALUES (?, ?, ?)'
    ).run(projectPath, fingerprint, Date.now());
  } finally {
    close();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called from wakeup. Must complete in <5s (no LLM calls).
 * If escalation needed, spawns detached `steroids monitor respond`.
 */
export async function monitorCheck(): Promise<void> {
  const config = readConfig();
  if (!config || !config.enabled) return;

  // Check interval
  const lastRun = getLastRunStartedAt();
  if (Date.now() - lastRun < config.interval_seconds * 1000) return;

  // Check for active first responder (with stale timeout)
  if (hasActiveFirstResponder(config.first_responder_timeout_seconds)) return;

  // Run scan
  const scanResult = await runScan();

  // Skip if anomalies are identical to the last run (no new information)
  if (isDuplicateOfLastRun(scanResult)) return;

  // Apply rules
  const rules = safeJsonParse<EscalationRules>(config.escalation_rules, { min_severity: 'critical' });
  const decision = shouldEscalate(scanResult.anomalies, rules);

  // Create run row
  const agents = safeJsonParse<Array<{ provider: string; model: string }>>(config.first_responder_agents, []);
  const needsFirstResponder = decision.escalate && agents.length > 0;

  const runId = createRunRow(scanResult, decision.escalate ? decision.reason : null, needsFirstResponder);

  // Prune old runs
  pruneOldRuns(500);

  // If first responder needed, spawn detached process and record attempt
  if (needsFirstResponder) {
    const affectedProjects = [...new Set(scanResult.anomalies.map(a => a.projectPath))];
    for (const projectPath of affectedProjects) {
      const fingerprint = computeAnomalyFingerprint(scanResult, projectPath);
      recordRemediationAttempt(projectPath, fingerprint);
    }
    spawnFirstResponder(runId);
  }
}

/**
 * Manual trigger from API. Runs scan + rules inline and returns result.
 * Does NOT invoke the first responder LLM (that's a separate detached process).
 */
export async function runMonitorCycle(options?: { manual?: boolean; preset?: string; forceDispatch?: boolean }): Promise<MonitorCycleResult> {
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
      config?.first_responder_agents ?? null, [],
    );
    const needsFirstResponder = !!(decision.escalate || options?.forceDispatch) && agents.length > 0 && scanResult.anomalies.length > 0;

    const runId = createRunRow(scanResult, decision.escalate ? decision.reason : null, needsFirstResponder);

    pruneOldRuns(500);

    if (needsFirstResponder) {
      const affectedProjects = [...new Set(scanResult.anomalies.map(a => a.projectPath))];
      for (const projectPath of affectedProjects) {
        const fingerprint = computeAnomalyFingerprint(scanResult, projectPath);
        recordRemediationAttempt(projectPath, fingerprint);
      }
      spawnFirstResponder(runId, options?.preset);
      return {
        outcome: 'first_responder_dispatched',
        runId,
        anomalyCount: scanResult.anomalies.length,
        escalationReason: decision.reason ?? 'Manual dispatch',
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
