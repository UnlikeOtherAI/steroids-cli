/**
 * First Responder Agent — structured action interface with provider fallback chain.
 *
 * Receives scan results, builds a prompt for an LLM, parses its structured
 * JSON response into actions, and executes them programmatically.
 */

import { spawn } from 'node:child_process';
import { openDatabase } from '../database/connection.js';
import { getProviderRegistry } from '../providers/registry.js';
import { resolveCliEntrypoint } from '../cli/entrypoint.js';
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
  | { action: 'disable_project'; projectPath: string; reason: string }
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
  actionResults: Array<{ action: string; success: boolean; reason?: string; error?: string }>;
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
  disable_project: ['projectPath', 'reason'],
  report_only: ['diagnosis'],
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const PRESET_INSTRUCTIONS: Record<string, string> = {
  stop_on_error: 'If you find any critical anomaly, emit a stop_all_runners action immediately. Do not attempt repairs.',
  investigate_and_stop: 'Diagnose the root cause. If the situation is dangerous, stop all runners. Otherwise, report only.',
  fix_and_monitor: 'Attempt to fix issues by resetting stuck tasks or killing zombie runners. Only stop all runners as a last resort.',
};

export function buildFirstResponderPrompt(
  scanResult: ScanResult,
  preset: string,
  customPrompt: string | null,
  remediationContext?: string,
): string {
  const presetText = preset === 'custom' && customPrompt
    ? customPrompt
    : PRESET_INSTRUCTIONS[preset] ?? PRESET_INSTRUCTIONS.investigate_and_stop;

  const anomalyList = scanResult.anomalies.length === 0
    ? 'No anomalies detected.'
    : scanResult.anomalies.map((a, i) =>
      `${i + 1}. [${a.severity.toUpperCase()}] ${a.type} — ${a.details}\n` +
      `   Project: ${a.projectName} (${a.projectPath})\n` +
      (a.taskId ? `   Task: ${a.taskId}${a.taskTitle ? ` — ${a.taskTitle}` : ''}\n` : '') +
      (a.runnerId ? `   Runner: ${a.runnerId}\n` : '') +
      `   Context: ${JSON.stringify(a.context)}`,
    ).join('\n\n');

  const remediationSection = remediationContext
    ? `\n## Remediation History\n\n${remediationContext}\n`
    : '';

  return `You are an automated first responder for the Steroids task runner system.

## Situation

Scan timestamp: ${new Date(scanResult.timestamp).toISOString()}
Projects scanned: ${scanResult.projectCount}
Summary: ${scanResult.summary}

## Anomalies

${anomalyList}
${remediationSection}
## Response Preset

${presetText}

## Instructions

Analyze the anomalies above and respond with a JSON object matching this schema:

{
  "diagnosis": "string — your analysis of what is wrong and why",
  "actions": [
    // Zero or more actions from the allowed set below
  ]
}

### Allowed Actions

- { "action": "reset_task", "projectPath": "<path>", "taskId": "<id>", "reason": "<why>" }
  Resets a stuck/failed task to pending (clears failure and rejection counts).

- { "action": "reset_project", "projectPath": "<path>", "reason": "<why>" }
  Resets ALL blocked/failed/skipped tasks in a project to pending and re-enables the project.
  Use when a project has multiple blocked_conflict or blocked_error tasks that need bulk recovery.

- { "action": "kill_runner", "runnerId": "<pid>", "reason": "<why>" }
  Sends SIGTERM to a specific runner process by PID.

- { "action": "stop_all_runners", "reason": "<why>" }
  Stops every active runner. Use only when the system is in a dangerous state.

- { "action": "trigger_wakeup", "reason": "<why>" }
  Triggers the wakeup cycle to restart runners and recover from idle states.

- { "action": "disable_project", "projectPath": "<path>", "reason": "<why>" }
  Disables an entire project. Use when repeated remediation attempts have failed (2-3 times) and the issue likely requires a code change to steroids itself, or the project is burning tokens in circles.

- { "action": "report_only", "diagnosis": "<summary>" }
  No action taken, just report findings. Use when anomalies are informational.

## Constraints

- You have NO shell access. You can ONLY use the actions listed above.
- Respond with valid JSON only — no markdown fences, no commentary outside the JSON.
- If no action is needed, use a single report_only action.
- Be conservative: prefer report_only over destructive actions unless the preset says otherwise.
- Only act on ENABLED projects. If a project is disabled, skip it.
- If you see the same anomalies for a project that have been attempted before (check the remediation context), and this is the 3rd+ attempt, use disable_project instead of trying to fix again.
- Blocking issues (blocked_task, idle_project, orphaned_task) MUST be acted upon — do NOT use report_only for these.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export function parseFirstResponderResponse(raw: string): FirstResponderResponse {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
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

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

export async function executeActions(
  actions: FirstResponderAction[],
): Promise<Array<{ action: string; success: boolean; reason?: string; error?: string }>> {
  const results: Array<{ action: string; success: boolean; reason?: string; error?: string }> = [];

  for (const entry of actions) {
    switch (entry.action) {
      case 'reset_task': {
        try {
          const { db, close } = openDatabase(entry.projectPath);
          try {
            db.prepare(
              `UPDATE tasks
               SET status = 'pending',
                   failure_count = 0,
                   rejection_count = 0,
                   merge_failure_count = 0,
                   conflict_count = 0,
                   last_failure_at = NULL,
                   updated_at = datetime('now')
               WHERE id = ?`,
            ).run(entry.taskId);
            results.push({ action: 'reset_task', success: true, reason: entry.reason });
          } finally {
            close();
          }
        } catch (err) {
          results.push({
            action: 'reset_task',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'reset_project': {
        try {
          const entrypoint = resolveCliEntrypoint();
          if (!entrypoint) {
            results.push({ action: 'reset_project', success: false, error: 'Could not resolve CLI entrypoint' });
            break;
          }
          const child = spawn(
            process.execPath,
            [entrypoint, 'tasks', 'reset', '--blocked', '--project', entry.projectPath],
            { stdio: 'ignore', detached: false },
          );
          await new Promise<void>((resolve, reject) => {
            child.on('close', (code) => {
              if (code === 0 || code === null) resolve();
              else reject(new Error(`tasks reset exited with code ${code}`));
            });
            child.on('error', reject);
          });
          results.push({ action: 'reset_project', success: true, reason: entry.reason });
        } catch (err) {
          results.push({
            action: 'reset_project',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'kill_runner': {
        try {
          const pid = parseInt(entry.runnerId, 10);
          if (isNaN(pid) || pid <= 0) {
            results.push({ action: 'kill_runner', success: false, error: `Invalid PID: ${entry.runnerId}` });
            break;
          }
          process.kill(pid, 'SIGTERM');
          results.push({ action: 'kill_runner', success: true, reason: entry.reason });
        } catch (err) {
          results.push({
            action: 'kill_runner',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'stop_all_runners': {
        try {
          const entrypoint = resolveCliEntrypoint();
          if (!entrypoint) {
            results.push({ action: 'stop_all_runners', success: false, error: 'Could not resolve CLI entrypoint' });
            break;
          }
          const child = spawn(process.execPath, [entrypoint, 'runners', 'stop', '--all'], {
            stdio: 'ignore',
            detached: false,
          });
          await new Promise<void>((resolve, reject) => {
            child.on('close', (code) => {
              if (code === 0 || code === null) resolve();
              else reject(new Error(`runners stop exited with code ${code}`));
            });
            child.on('error', reject);
          });
          results.push({ action: 'stop_all_runners', success: true, reason: entry.reason });
        } catch (err) {
          results.push({
            action: 'stop_all_runners',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'trigger_wakeup': {
        try {
          const entrypoint = resolveCliEntrypoint();
          if (!entrypoint) {
            results.push({ action: 'trigger_wakeup', success: false, error: 'Could not resolve CLI entrypoint' });
            break;
          }
          const child = spawn(process.execPath, [entrypoint, 'runners', 'wakeup'], {
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
          results.push({ action: 'trigger_wakeup', success: true, reason: entry.reason });
        } catch (err) {
          results.push({
            action: 'trigger_wakeup',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'disable_project': {
        try {
          const entrypoint = resolveCliEntrypoint();
          if (!entrypoint) {
            results.push({ action: 'disable_project', success: false, error: 'Could not resolve CLI entrypoint' });
            break;
          }
          const child = spawn(
            process.execPath,
            [entrypoint, 'projects', 'disable', '--path', entry.projectPath],
            { stdio: 'ignore', detached: false },
          );
          await new Promise<void>((resolve, reject) => {
            child.on('close', (code) => {
              if (code === 0 || code === null) resolve();
              else reject(new Error(`projects disable exited with code ${code}`));
            });
            child.on('error', reject);
          });
          results.push({ action: 'disable_project', success: true, reason: entry.reason });
        } catch (err) {
          results.push({
            action: 'disable_project',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'report_only': {
        results.push({ action: 'report_only', success: true, reason: entry.diagnosis });
        break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point — fallback chain
// ---------------------------------------------------------------------------

function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('rate') || msg.includes('limit') || msg.includes('timeout') || msg.includes('network');
}

export async function runFirstResponder(
  agents: Array<{ provider: string; model: string }>,
  scanResult: ScanResult,
  preset: string,
  customPrompt: string | null,
  remediationContext?: string,
): Promise<FirstResponderResult> {
  const registry = await getProviderRegistry();
  const prompt = buildFirstResponderPrompt(scanResult, preset, customPrompt, remediationContext);

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
        if (classified?.retryable) {
          console.warn(`[first-responder] Retryable error from ${agent.provider}: ${errMsg}`);
          continue;
        }
        return {
          success: false,
          agentUsed: `${agent.provider}/${agent.model}`,
          diagnosis: `Provider invocation failed: ${errMsg}`,
          actions: [],
          actionResults: [],
          error: errMsg,
        };
      }

      const response = parseFirstResponderResponse(result.stdout);
      const actionResults = await executeActions(response.actions);

      return {
        success: true,
        agentUsed: `${agent.provider}/${agent.model}`,
        diagnosis: response.diagnosis,
        actions: response.actions,
        actionResults,
      };
    } catch (err) {
      if (isRetryableError(err)) {
        console.warn(`[first-responder] Retryable error from ${agent.provider}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      return {
        success: false,
        agentUsed: `${agent.provider}/${agent.model}`,
        diagnosis: '',
        actions: [],
        actionResults: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    success: false,
    agentUsed: null,
    diagnosis: '',
    actions: [],
    actionResults: [],
    error: 'All agents exhausted — no provider was available or all returned retryable errors',
  };
}
