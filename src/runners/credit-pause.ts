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
import {
  triggerCreditExhausted,
  triggerCreditResolved,
  triggerHooksSafely,
} from '../hooks/integration.js';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MESSAGE_LENGTH = 200;

export interface CreditPauseOptions {
  provider: string;
  model: string;
  role: 'orchestrator' | 'coder' | 'reviewer';
  message: string;
  runnerId: string;
  projectPath: string;
  db: Database.Database;
  shouldStop: () => boolean;
  onHeartbeat?: () => void;
  onceMode?: boolean;
}

export interface CreditPauseResult {
  resolved: boolean;
  resolution: 'config_changed' | 'stopped' | 'immediate_fail';
}

/**
 * Sanitize error message: truncate to MAX_MESSAGE_LENGTH chars
 */
function sanitizeMessage(message: string): string {
  if (!message) return '';
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return message.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';
}

/**
 * Handle a credit exhaustion event.
 *
 * Records the incident, fires hooks, prints CLI output,
 * and polls for config changes every 30 seconds.
 * In onceMode, prints the message and returns immediately.
 */
export async function handleCreditExhaustion(
  options: CreditPauseOptions
): Promise<CreditPauseResult> {
  const {
    provider, model, role, message,
    runnerId, projectPath, db, shouldStop, onHeartbeat, onceMode,
  } = options;

  const safeMessage = sanitizeMessage(message);

  // Record incident (with deduplication)
  const incidentId = recordCreditIncident(db, {
    provider, model, role, message: safeMessage,
  }, runnerId);

  // Fire credit.exhausted hook
  await triggerHooksSafely(() =>
    triggerCreditExhausted(
      { provider, model, role, message: safeMessage, runner_id: runnerId },
      { projectPath }
    )
  );

  // Print CLI output
  console.log('');
  console.log('============================================================');
  console.log('  OUT OF CREDITS');
  console.log('============================================================');
  console.log('');
  console.log(`  Provider: ${provider} (model: ${model})`);
  console.log(`  Role:     ${role}`);
  console.log(`  Message:  ${safeMessage}`);
  console.log('');
  console.log('  The runner is paused. To resume, either:');
  console.log(`    1. Add credits to your ${provider} account`);
  console.log(`    2. Change the ${role} provider:`);
  console.log(`       steroids config set ai.${role}.provider <new-provider>`);
  console.log('');
  console.log('  Checking for config changes every 30 seconds...');
  console.log('============================================================');

  // onceMode: return immediately
  if (onceMode) {
    return { resolved: false, resolution: 'immediate_fail' };
  }

  const creditData = { provider, model, role, message: safeMessage, runner_id: runnerId };

  // Poll for config change
  while (true) {
    if (shouldStop()) {
      resolveCreditIncident(db, incidentId, 'dismissed');
      return { resolved: false, resolution: 'stopped' };
    }

    // Wait, but check shouldStop more frequently than the full interval
    const waited = await interruptibleSleep(POLL_INTERVAL_MS, shouldStop);
    if (!waited) {
      resolveCreditIncident(db, incidentId, 'dismissed');
      return { resolved: false, resolution: 'stopped' };
    }

    // Update heartbeat so the wakeup system doesn't kill us
    onHeartbeat?.();

    // Check if config has changed
    const config = loadConfig(projectPath);
    const currentProvider = config.ai?.[role]?.provider;
    const currentModel = config.ai?.[role]?.model;

    if (currentProvider !== provider || currentModel !== model) {
      console.log(`\n  Configuration changed (${provider}/${model} → ${currentProvider}/${currentModel}). Resuming...`);
      resolveCreditIncident(db, incidentId, 'config_changed');

      // Fire credit.resolved hook
      await triggerHooksSafely(() =>
        triggerCreditResolved(creditData, 'config_changed', { projectPath })
      );

      return { resolved: true, resolution: 'config_changed' };
    }
  }
}

/**
 * Sleep that can be interrupted by shouldStop returning true.
 * Returns true if the full sleep completed, false if interrupted.
 */
async function interruptibleSleep(
  ms: number,
  shouldStop: () => boolean
): Promise<boolean> {
  const checkInterval = 2000; // Check every 2 seconds
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldStop()) return false;
    const remaining = ms - elapsed;
    const wait = Math.min(checkInterval, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
    elapsed += wait;
  }
  return true;
}

/**
 * Check a batch result for credit exhaustion using the provider's classifier.
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
