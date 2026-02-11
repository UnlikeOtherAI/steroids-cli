/**
 * Credit exhaustion pause handler
 *
 * Reusable pause-and-poll logic for when a provider runs out of credits.
 * Used by both orchestrator-loop.ts (daemon path) and loop.ts (foreground path).
 */

import type Database from 'better-sqlite3';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { CreditExhaustionResult } from '../commands/loop-phases.js';
import {
  recordCreditIncident,
  resolveCreditIncident,
} from '../database/queries.js';

const POLL_INTERVAL_MS = 30_000; // 30 seconds

export interface CreditPauseOptions {
  /** Project path for config loading */
  projectPath: string;
  /** Project database for recording incidents */
  projectDb: Database.Database;
  /** Runner ID (for incident tracking and heartbeat) */
  runnerId?: string;
  /** Called to check if the loop should stop */
  shouldStop?: () => boolean;
  /** Called to update heartbeat during the pause */
  onHeartbeat?: () => void;
  /** If true, fail immediately instead of entering pause loop */
  once?: boolean;
}

export interface CreditPauseResult {
  /** Whether the pause was resolved (config changed) vs interrupted (shouldStop) */
  resumed: boolean;
}

/**
 * Handle a credit exhaustion event.
 *
 * In --once mode, throws immediately.
 * Otherwise, records an incident, fires hooks, prints output,
 * and polls for config changes every 30 seconds.
 */
export async function handleCreditExhaustion(
  alert: CreditExhaustionResult,
  options: CreditPauseOptions
): Promise<CreditPauseResult> {
  const { projectPath, projectDb, runnerId, shouldStop, onHeartbeat, once } = options;

  // --once mode: fail immediately
  if (once) {
    console.error('');
    console.error('============================================================');
    console.error('  OUT OF CREDITS');
    console.error('============================================================');
    console.error('');
    console.error(`  Provider: ${alert.provider} (model: ${alert.model})`);
    console.error(`  Role:     ${alert.role}`);
    console.error(`  Message:  ${alert.message}`);
    console.error('');
    console.error('  Running with --once flag, exiting immediately.');
    console.error('============================================================');
    throw new CreditExhaustionError(alert);
  }

  // Record incident (with deduplication)
  const incidentId = recordCreditIncident(projectDb, {
    provider: alert.provider,
    model: alert.model,
    role: alert.role,
    message: alert.message,
  }, runnerId);

  // Print console output
  console.log('');
  console.log('============================================================');
  console.log('  OUT OF CREDITS');
  console.log('============================================================');
  console.log('');
  console.log(`  Provider: ${alert.provider} (model: ${alert.model})`);
  console.log(`  Role:     ${alert.role}`);
  console.log(`  Message:  ${alert.message}`);
  console.log('');
  console.log('  The runner is paused. To resume, either:');
  console.log(`    1. Add credits to your ${alert.provider} account`);
  console.log(`    2. Change the ${alert.role} provider:`);
  console.log(`       steroids config set ai.${alert.role}.provider <new-provider>`);
  console.log('');
  console.log('  Checking for config changes every 30 seconds...');
  console.log('============================================================');

  // Snapshot original config
  const originalProvider = alert.provider;
  const originalModel = alert.model;

  // Poll for config change
  while (true) {
    if (shouldStop?.()) {
      resolveCreditIncident(projectDb, incidentId, 'none');
      return { resumed: false };
    }

    // Wait, but check shouldStop more frequently than the full interval
    const waited = await interruptibleSleep(POLL_INTERVAL_MS, shouldStop);
    if (!waited) {
      resolveCreditIncident(projectDb, incidentId, 'none');
      return { resumed: false };
    }

    // Update heartbeat so the wakeup system doesn't kill us
    onHeartbeat?.();

    // Check if config has changed
    const config = loadConfig(projectPath);
    const currentProvider = config.ai?.[alert.role]?.provider;
    const currentModel = config.ai?.[alert.role]?.model;

    if (currentProvider !== originalProvider || currentModel !== originalModel) {
      console.log(`\n  Configuration changed (${originalProvider}/${originalModel} → ${currentProvider}/${currentModel}). Resuming...`);
      resolveCreditIncident(projectDb, incidentId, 'config_changed');
      return { resumed: true };
    }
  }
}

/**
 * Sleep that can be interrupted by shouldStop returning true.
 * Returns true if the full sleep completed, false if interrupted.
 */
async function interruptibleSleep(
  ms: number,
  shouldStop?: () => boolean
): Promise<boolean> {
  const checkInterval = 2000; // Check every 2 seconds
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldStop?.()) return false;
    const remaining = ms - elapsed;
    const wait = Math.min(checkInterval, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
    elapsed += wait;
  }
  return true;
}

/**
 * Error thrown in --once mode when credits are exhausted
 */
export class CreditExhaustionError extends Error {
  public readonly alert: CreditExhaustionResult;

  constructor(alert: CreditExhaustionResult) {
    super(`Credit exhaustion: ${alert.provider}/${alert.model} (${alert.role}): ${alert.message}`);
    this.name = 'CreditExhaustionError';
    this.alert = alert;
  }
}

/**
 * Check a batch result for credit exhaustion using the provider's classifier.
 * Batch results have the same shape as InvokeResult.
 */
export function checkBatchCreditExhaustion(
  result: { success: boolean; exitCode: number; stdout: string; stderr: string; duration: number; timedOut: boolean },
  role: 'coder' | 'reviewer',
  projectPath: string
): CreditExhaustionResult | null {
  if (result.success) return null;

  const config = loadConfig(projectPath);
  const roleConfig = config.ai?.[role];
  const providerName = roleConfig?.provider;
  const modelName = roleConfig?.model;

  if (!providerName || !modelName) return null;

  const registry = getProviderRegistry();
  const provider = registry.tryGet(providerName);
  if (!provider) return null;

  const classification = provider.classifyResult(result);
  if (classification?.type === 'credit_exhaustion') {
    return {
      action: 'pause_credit_exhaustion',
      provider: providerName,
      model: modelName,
      role,
      message: classification.message,
    };
  }

  return null;
}
