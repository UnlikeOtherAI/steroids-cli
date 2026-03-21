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

import { spawn } from 'node:child_process';
import { openDatabase } from '../database/connection.js';
import { getProviderRegistry } from '../providers/registry.js';
import { resolveCliEntrypoint } from '../cli/entrypoint.js';
import { buildFirstResponderPrompt } from './investigator-prompt.js';
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
  report_only: ['diagnosis'],
};

// Fields that update_task is allowed to modify (safety whitelist)
const UPDATABLE_TASK_FIELDS = new Set([
  'status', 'failure_count', 'rejection_count', 'merge_failure_count',
  'conflict_count', 'blocked_reason', 'description',
]);

// Valid task statuses for update_task
const VALID_TASK_STATUSES = new Set([
  'pending', 'in_progress', 'review', 'completed', 'failed', 'skipped',
  'disputed', 'blocked_conflict', 'blocked_error',
]);

// Re-export for backward compatibility
export { buildFirstResponderPrompt } from './investigator-prompt.js';

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
): Promise<Array<{ action: string; success: boolean; reason?: string; error?: string; output?: unknown }>> {
  const results: Array<{ action: string; success: boolean; reason?: string; error?: string; output?: unknown }> = [];

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

      case 'query_db': {
        try {
          // Safety: only SELECT statements allowed
          const sqlNorm = entry.sql.trim().toUpperCase();
          if (!sqlNorm.startsWith('SELECT')) {
            results.push({ action: 'query_db', success: false, error: 'Only SELECT statements are allowed', reason: entry.reason });
            break;
          }

          const { db, close } = openDatabase(entry.projectPath);
          try {
            const rows = db.prepare(entry.sql).all();
            // Limit output to prevent massive results
            const truncated = rows.length > 50 ? rows.slice(0, 50) : rows;
            results.push({
              action: 'query_db',
              success: true,
              reason: entry.reason,
              output: { rows: truncated, totalRows: rows.length, truncated: rows.length > 50 },
            });
          } finally {
            close();
          }
        } catch (err) {
          results.push({
            action: 'query_db',
            success: false,
            error: err instanceof Error ? err.message : String(err),
            reason: entry.reason,
          });
        }
        break;
      }

      case 'update_task': {
        try {
          const fields = entry.fields;
          if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
            results.push({ action: 'update_task', success: false, error: 'No fields specified' });
            break;
          }

          // Validate fields against whitelist
          const invalidFields = Object.keys(fields).filter(f => !UPDATABLE_TASK_FIELDS.has(f));
          if (invalidFields.length > 0) {
            results.push({
              action: 'update_task',
              success: false,
              error: `Fields not allowed: ${invalidFields.join(', ')}. Allowed: ${[...UPDATABLE_TASK_FIELDS].join(', ')}`,
            });
            break;
          }

          // Validate status values
          if (fields.status !== undefined && !VALID_TASK_STATUSES.has(String(fields.status))) {
            results.push({
              action: 'update_task',
              success: false,
              error: `Invalid status: ${fields.status}. Valid: ${[...VALID_TASK_STATUSES].join(', ')}`,
            });
            break;
          }

          const { db, close } = openDatabase(entry.projectPath);
          try {
            const sets: string[] = [];
            const params: unknown[] = [];
            for (const [key, value] of Object.entries(fields)) {
              sets.push(`${key} = ?`);
              params.push(value);
            }
            sets.push("updated_at = datetime('now')");
            params.push(entry.taskId);

            const result = db.prepare(
              `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`
            ).run(...params);

            results.push({
              action: 'update_task',
              success: true,
              reason: entry.reason,
              output: { fieldsUpdated: Object.keys(fields), rowsAffected: result.changes },
            });
          } finally {
            close();
          }
        } catch (err) {
          results.push({
            action: 'update_task',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'add_dependency': {
        try {
          const { db, close } = openDatabase(entry.projectPath);
          try {
            // Check for circular dependency
            const visited = new Set<string>();
            const checkCircular = (sId: string): boolean => {
              if (sId === entry.sectionId) return true;
              if (visited.has(sId)) return false;
              visited.add(sId);
              const deps = db.prepare(
                'SELECT depends_on_section_id FROM section_dependencies WHERE section_id = ?'
              ).all(sId) as Array<{ depends_on_section_id: string }>;
              return deps.some(d => checkCircular(d.depends_on_section_id));
            };

            if (checkCircular(entry.dependsOnSectionId)) {
              results.push({
                action: 'add_dependency',
                success: false,
                error: 'Would create a circular dependency',
                reason: entry.reason,
              });
              break;
            }

            // Generate UUID for the dependency row
            const id = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            db.prepare(
              'INSERT OR IGNORE INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
            ).run(id, entry.sectionId, entry.dependsOnSectionId);

            // Look up section names for documentation
            const fromSection = db.prepare('SELECT title FROM sections WHERE id = ?').get(entry.sectionId) as { title: string } | undefined;
            const toSection = db.prepare('SELECT title FROM sections WHERE id = ?').get(entry.dependsOnSectionId) as { title: string } | undefined;

            results.push({
              action: 'add_dependency',
              success: true,
              reason: entry.reason,
              output: {
                from: fromSection?.title ?? entry.sectionId,
                dependsOn: toSection?.title ?? entry.dependsOnSectionId,
              },
            });
          } finally {
            close();
          }
        } catch (err) {
          results.push({
            action: 'add_dependency',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'add_task_feedback': {
        try {
          const { db, close } = openDatabase(entry.projectPath);
          try {
            // Check if task_feedback table exists
            const tableExists = db.prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_feedback'"
            ).get();

            if (tableExists) {
              const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              db.prepare(
                `INSERT INTO task_feedback (id, task_id, feedback, source, created_at)
                 VALUES (?, ?, ?, 'monitor_first_responder', datetime('now'))`
              ).run(id, entry.taskId, entry.feedback);
            } else {
              // Fallback: update task description to include feedback
              const task = db.prepare('SELECT description FROM tasks WHERE id = ?').get(entry.taskId) as { description: string | null } | undefined;
              const existing = task?.description ?? '';
              const updated = existing
                ? `${existing}\n\n--- Monitor Feedback ---\n${entry.feedback}`
                : `--- Monitor Feedback ---\n${entry.feedback}`;
              db.prepare("UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ?").run(updated, entry.taskId);
            }

            results.push({
              action: 'add_task_feedback',
              success: true,
              reason: entry.reason,
              output: { taskId: entry.taskId, feedbackLength: entry.feedback.length },
            });
          } finally {
            close();
          }
        } catch (err) {
          results.push({
            action: 'add_task_feedback',
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
