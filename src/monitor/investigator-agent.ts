/**
 * First Responder Agent — structured action interface with provider fallback chain.
 *
 * Receives scan results, builds a prompt for an LLM, parses its structured
 * JSON response into actions, and executes them programmatically.
 *
 * The agent can:
 * - Reset tasks, projects, kill runners, trigger wakeups
 * - Query project databases for debugging (read-only SQL)
 * - Update task fields (status, dependencies, feedback)
 * - Add section dependencies to fix ordering issues
 * - Add task feedback notes for future coder/reviewer runs
 *
 * Every action is fully documented in the run results for accountability.
 */

import { getProviderRegistry } from '../providers/registry.js';
import { buildFirstResponderPrompt } from './investigator-prompt.js';
import { executeActions } from './investigator-actions.js';
import {
  getMonitorResponsePolicy,
  type StoredMonitorResponsePreset,
} from './response-mode.js';
import type { ScanResult } from './scanner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FirstResponderAction =
  | { action: 'reset_task'; projectPath: string; taskId: string; reason: string }
  | { action: 'reset_project'; projectPath: string; reason: string }
  | { action: 'kill_runner'; runnerId: string; reason: string }
  | { action: 'stop_all_runners'; reason: string }
  | { action: 'trigger_wakeup'; reason: string }
  | { action: 'query_db'; projectPath: string; sql: string; reason: string }
  | { action: 'update_task'; projectPath: string; taskId: string; fields: Record<string, unknown>; reason: string }
  | { action: 'add_dependency'; projectPath: string; sectionId: string; dependsOnSectionId: string; reason: string }
  | { action: 'add_task_feedback'; projectPath: string; taskId: string; feedback: string; reason: string }
  | { action: 'suppress_anomaly'; projectPath: string; anomalyType: string; duration_hours: number; reason: string }
  | { action: 'release_merge_lock'; projectPath: string; diagnosis: string }
  | { action: 'reset_merge_phase'; projectPath: string; taskId: string; diagnosis: string }
  | { action: 'report_only'; diagnosis: string };

export interface FirstResponderResponse {
  diagnosis: string;
  actions: FirstResponderAction[];
}

export interface FirstResponderResult {
  success: boolean;
  agentUsed: string | null;
  diagnosis: string;
  actions: FirstResponderAction[];
  actionResults: Array<{ action: string; success: boolean; reason?: string; error?: string; output?: unknown }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Allowed action schemas (used in prompt + validation)
// ---------------------------------------------------------------------------

const ALLOWED_ACTIONS: Record<string, string[]> = {
  reset_task: ['projectPath', 'taskId', 'reason'],
  reset_project: ['projectPath', 'reason'],
  kill_runner: ['runnerId', 'reason'],
  stop_all_runners: ['reason'],
  trigger_wakeup: ['reason'],
  query_db: ['projectPath', 'sql', 'reason'],
  update_task: ['projectPath', 'taskId', 'fields', 'reason'],
  add_dependency: ['projectPath', 'sectionId', 'dependsOnSectionId', 'reason'],
  add_task_feedback: ['projectPath', 'taskId', 'feedback', 'reason'],
  suppress_anomaly: ['projectPath', 'anomalyType', 'duration_hours', 'reason'],
  release_merge_lock: ['projectPath', 'diagnosis'],
  reset_merge_phase: ['projectPath', 'taskId', 'diagnosis'],
  report_only: ['diagnosis'],
};

// Re-export for backward compatibility
export { buildFirstResponderPrompt } from './investigator-prompt.js';
export { executeActions } from './investigator-actions.js';

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Extract the last valid JSON object from a string that may contain
 * preamble text, thinking output, or markdown fences before the JSON.
 */
function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();

  // Try the whole string first (fast path)
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Try markdown-fenced JSON
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
  }

  // Scan for the last top-level { ... } block (handles "thinking text" + JSON)
  let depth = 0;
  let lastEnd = -1;
  let lastStart = -1;
  let inString = false;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] === '"' && (i === 0 || trimmed[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (trimmed[i] === '}') {
      if (depth === 0) lastEnd = i;
      depth++;
    } else if (trimmed[i] === '{') {
      depth--;
      if (depth === 0 && lastEnd !== -1) {
        lastStart = i;
        break;
      }
    }
  }
  if (lastStart !== -1 && lastEnd !== -1) {
    try { return JSON.parse(trimmed.slice(lastStart, lastEnd + 1)); } catch { /* fall through */ }
  }

  return null;
}

export function parseFirstResponderResponse(raw: string): FirstResponderResponse {
  const parsed = extractJsonObject(raw);

  if (parsed === null) {
    return {
      diagnosis: raw,
      actions: [{ action: 'report_only', diagnosis: 'Failed to parse response' }],
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      diagnosis: raw,
      actions: [{ action: 'report_only', diagnosis: 'Response was not a JSON object' }],
    };
  }

  const obj = parsed as Record<string, unknown>;
  const diagnosis = typeof obj.diagnosis === 'string' ? obj.diagnosis : String(obj.diagnosis ?? '');

  if (!Array.isArray(obj.actions)) {
    return { diagnosis, actions: [{ action: 'report_only', diagnosis }] };
  }

  const validActions: FirstResponderAction[] = [];

  for (const item of obj.actions) {
    if (typeof item !== 'object' || item === null) {
      console.warn('[first-responder] Skipping non-object action entry');
      continue;
    }

    const entry = item as Record<string, unknown>;
    const actionName = String(entry.action ?? '');
    const requiredFields = ALLOWED_ACTIONS[actionName];

    if (!requiredFields) {
      console.warn(`[first-responder] Skipping unknown action: ${actionName}`);
      continue;
    }

    const missingFields = requiredFields.filter((f) => entry[f] === undefined || entry[f] === null);
    if (missingFields.length > 0) {
      console.warn(`[first-responder] Skipping ${actionName}: missing fields ${missingFields.join(', ')}`);
      continue;
    }

    validActions.push(entry as unknown as FirstResponderAction);
  }

  if (validActions.length === 0 && obj.actions.length > 0) {
    return { diagnosis, actions: [{ action: 'report_only', diagnosis: 'All actions were invalid' }] };
  }

  return { diagnosis, actions: validActions };
}

function filterActionsForPreset(
  actions: FirstResponderAction[],
  preset: StoredMonitorResponsePreset,
  diagnosis: string,
): FirstResponderAction[] {
  const policy = getMonitorResponsePolicy(preset);
  const filtered = actions.filter((action) => {
    const allowed = policy.allowedActions.has(action.action);
    if (!allowed) {
      console.warn(`[first-responder] Dropping disallowed ${action.action} action for ${policy.preset}`);
    }
    return allowed;
  });

  if (filtered.length > 0 || actions.length === 0 || !policy.allowedActions.has('report_only')) {
    return filtered;
  }

  return [{ action: 'report_only', diagnosis }];
}

// ---------------------------------------------------------------------------
// Main entry point — fallback chain
// ---------------------------------------------------------------------------

export async function runFirstResponder(
  agents: Array<{ provider: string; model: string }>,
  scanResult: ScanResult,
  preset: StoredMonitorResponsePreset,
  customPrompt: string | null,
  remediationContext?: string,
): Promise<FirstResponderResult> {
  const registry = await getProviderRegistry();
  const prompt = buildFirstResponderPrompt(scanResult, preset, customPrompt, remediationContext);
  const policy = getMonitorResponsePolicy(preset);

  for (const agent of agents) {
    let provider;
    try {
      provider = registry.tryGet(agent.provider);
    } catch {
      continue;
    }
    if (!provider) continue;

    // Check availability
    try {
      if (!(await provider.isAvailable())) {
        console.warn(`[first-responder] Provider ${agent.provider} not available, skipping`);
        continue;
      }
    } catch {
      continue;
    }

    // Check backoff (provider may not expose this — import directly)
    try {
      const { getProviderBackoffRemainingMs } = await import('../runners/global-db-backoffs.js');
      const remaining = getProviderBackoffRemainingMs(agent.provider);
      if (remaining > 0) {
        console.warn(`[first-responder] Provider ${agent.provider} backed off for ${Math.ceil(remaining / 1000)}s, skipping`);
        continue;
      }
    } catch {
      // Backoff check not available — proceed anyway
    }

    try {
      const result = await provider.invoke(prompt, { model: agent.model });

      if (!result.success) {
        const classified = provider.classifyResult(result);
        const errMsg = classified?.message ?? result.stderr.slice(0, 200);
        // M3: Always try next provider on failure — don't hard-stop on non-retryable errors
        console.warn(`[first-responder] Error from ${agent.provider}: ${errMsg}`);
        continue;
      }

      const response = parseFirstResponderResponse(result.stdout);
      const filteredActions: FirstResponderAction[] = filterActionsForPreset(
        response.actions,
        preset,
        response.diagnosis,
      );

      // M6: If FR returned only report_only but scan has actionable anomalies, inject fallback actions.
      // Uses reset_task for task-level anomalies (94.9% success) over trigger_wakeup (0% for idle_project).
      const ACTIONABLE_TYPES = new Set(['blocked_task', 'failed_task', 'orphaned_task', 'hanging_invocation', 'zombie_runner', 'dead_runner']);
      const actionableAnomalies = scanResult.anomalies.filter(a => ACTIONABLE_TYPES.has(a.type));
      const onlyReportOnly = filteredActions.length === 0 || filteredActions.every(a => a.action === 'report_only');
      let finalActions: FirstResponderAction[] = filteredActions;
      if (policy.allowFallbackRepairInjection && actionableAnomalies.length > 0 && onlyReportOnly) {
        const repairActions: FirstResponderAction[] = [];
        const taskAnomaly = actionableAnomalies.find(a => a.taskId);
        if (taskAnomaly) {
          repairActions.push({
            action: 'reset_task',
            projectPath: taskAnomaly.projectPath,
            taskId: taskAnomaly.taskId!,
            reason: 'M6: FR returned only report_only for actionable anomalies; injecting reset_task',
          });
        } else {
          repairActions.push({
            action: 'trigger_wakeup',
            reason: 'M6: FR returned only report_only for actionable anomalies; injecting wakeup',
          });
        }
        finalActions = [...filteredActions, ...repairActions];
      }

      const actionResults = await executeActions(finalActions);

      return {
        success: true,
        agentUsed: `${agent.provider}/${agent.model}`,
        diagnosis: response.diagnosis,
        actions: finalActions,
        actionResults,
      };
    } catch (err) {
      // M3: Always try next provider on any error
      console.warn(`[first-responder] Error from ${agent.provider}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }

  return {
    success: false,
    agentUsed: null,
    diagnosis: '',
    actions: [],
    actionResults: [],
    error: 'All agents exhausted — no provider was available or all returned errors',
  };
}
