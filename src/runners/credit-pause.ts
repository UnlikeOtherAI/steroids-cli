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
import { getRegisteredProject, setProjectHibernation } from './projects.js';

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
  resolution: 'config_changed' | 'stopped' | 'immediate_fail' | 'hibernating';
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
 * and sets the project to a hibernating state.
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

  // Calculate backoff schedule
  const projectInfo = getRegisteredProject(projectPath);
  const currentTier = projectInfo?.hibernation_tier ?? 0;
  const newTier = currentTier + 1;
  
  // Attempt 1: 5 minutes. Attempt 2+: 30 minutes.
  const backoffMinutes = newTier === 1 ? 5 : 30;
  const backoffUntilMs = Date.now() + (backoffMinutes * 60 * 1000);
  const backoffUntilISO = new Date(backoffUntilMs).toISOString();

  // Print CLI output
  console.log('');
  console.log('============================================================');
  console.log('  PROVIDER CAPACITY / TOKEN LIMIT REACHED');
  console.log('============================================================');
  console.log('');
  console.log(`  Provider: ${provider} (model: ${model})`);
  console.log(`  Role:     ${role}`);
  console.log(`  Message:  ${safeMessage}`);
  console.log('');
  console.log(`  The project is entering hibernation (Tier ${newTier}).`);
  console.log(`  Will sleep for ${backoffMinutes} minutes and ping the provider.`);
  console.log('  The runner will now exit to conserve resources.');
  console.log('============================================================');

  // Put project into hibernation state
  setProjectHibernation(projectPath, newTier, backoffUntilISO);

  // Return immediately so runner exits
  return { resolved: false, resolution: 'hibernating' };
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
export async function checkBatchCreditExhaustion(
  result: { success: boolean; exitCode: number; stdout: string; stderr: string; duration: number; timedOut: boolean },
  role: 'coder' | 'reviewer',
  projectPath: string
): Promise<CreditExhaustionResult | null> {
  if (result.success) return null;

  const config = loadConfig(projectPath);
  const roleConfig = config.ai?.[role];
  const providerName = roleConfig?.provider;
  const modelName = roleConfig?.model;

  if (!providerName || !modelName) return null;

  const registry = await getProviderRegistry();
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

  if (classification?.type === 'rate_limit') {
    return {
      action: 'rate_limit',
      provider: providerName,
      model: modelName,
      role,
      message: classification.message,
      retryAfterMs: classification.retryAfterMs,
    };
  }

  return null;
}
