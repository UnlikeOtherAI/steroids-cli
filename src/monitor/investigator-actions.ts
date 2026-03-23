/**
 * First Responder action executors — extracted from investigator-agent.ts.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../database/connection.js';
import { hasSuccessfulCoderWork } from '../database/queries.js';
import { openGlobalDatabase } from '../runners/global-db-connection.js';
import { resolveCliEntrypoint } from '../cli/entrypoint.js';
import { getProjectHash } from '../parallel/clone.js';
import type { FirstResponderAction } from './investigator-agent.js';
import { cleanupBlockedTaskBranch } from './investigator-helpers.js';

// Fields that update_task is allowed to modify (safety whitelist)
const UPDATABLE_TASK_FIELDS = new Set([
  'status', 'failure_count', 'rejection_count', 'merge_failure_count',
  'conflict_count', 'blocked_reason', 'description',
  'merge_phase', 'approved_sha', 'rebase_attempts',
]);

// Valid task statuses for update_task
const VALID_TASK_STATUSES = new Set([
  'pending', 'in_progress', 'review', 'merge_pending', 'completed', 'failed', 'skipped',
  'disputed', 'blocked_conflict', 'blocked_error',
]);

// Valid anomaly types for suppress_anomaly
const VALID_ANOMALY_TYPES = new Set([
  'orphaned_task', 'hanging_invocation', 'zombie_runner', 'dead_runner',
  'db_inconsistency', 'credit_exhaustion', 'failed_task', 'skipped_task',
  'idle_project', 'high_invocations', 'repeated_failures', 'blocked_task',
  'stale_merge_lock', 'stuck_merge_phase', 'disputed_task',
]);

export type ActionResult = { action: string; success: boolean; reason?: string; error?: string; output?: unknown };

export async function executeActions(
  actions: FirstResponderAction[],
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const entry of actions) {
    switch (entry.action) {
      case 'reset_task': {
        try {
          const { db, close } = openDatabase(entry.projectPath);
          try {
            // S4: Check current status — blocked_conflict tasks need branch cleanup
            const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(entry.taskId) as { status: string } | undefined;
            const isBlockedConflict = taskRow?.status === 'blocked_conflict';

            if (isBlockedConflict) {
              cleanupBlockedTaskBranch(entry.projectPath, entry.taskId);
            }

            // S7: If coder already succeeded, reset to 'review' instead of 'pending'
            // to skip the coder phase and go straight to review.
            // Exception: blocked_conflict tasks had their branch deleted (S4), so they need a full restart.
            const coderSucceeded = !isBlockedConflict && hasSuccessfulCoderWork(db, entry.taskId);
            const targetStatus = coderSucceeded ? 'review' : 'pending';

            const fromStatus = taskRow?.status ?? 'unknown';
            db.prepare(
              `UPDATE tasks
               SET status = ?,
                   failure_count = 0,
                   rejection_count = CASE WHEN ? = 'review' THEN rejection_count ELSE 0 END,
                   merge_failure_count = 0,
                   conflict_count = 0,
                   last_failure_at = NULL,
                   merge_phase = NULL,
                   approved_sha = NULL,
                   rebase_attempts = 0,
                   updated_at = datetime('now')
               WHERE id = ?`,
            ).run(targetStatus, targetStatus, entry.taskId);

            db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(entry.taskId);
            const notes = coderSucceeded
              ? `S7: ${entry.reason ?? 'FR reset_task'} (coder succeeded previously — routing to review)`
              : (entry.reason ?? 'FR reset_task');
            db.prepare(
              `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
               VALUES (?, ?, ?, 'first_responder', 'orchestrator', ?, datetime('now'))`,
            ).run(entry.taskId, fromStatus, targetStatus, notes);

            results.push({ action: 'reset_task', success: true, reason: entry.reason, output: { targetStatus } });
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
          const { db, close } = openDatabase(entry.projectPath);
          try {
            const result = db.prepare(
              `UPDATE tasks
               SET status = 'pending',
                   failure_count = 0,
                   rejection_count = 0,
                   merge_failure_count = 0,
                   conflict_count = 0,
                   last_failure_at = NULL,
                   updated_at = datetime('now')
               WHERE status IN ('failed', 'skipped', 'blocked_conflict', 'blocked_error')`
            ).run();
            results.push({
              action: 'reset_project',
              success: true,
              reason: entry.reason,
              output: { tasksReset: result.changes },
            });
          } finally {
            close();
          }
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
          const sqlNorm = entry.sql.trim().toUpperCase();
          if (!sqlNorm.startsWith('SELECT')) {
            results.push({ action: 'query_db', success: false, error: 'Only SELECT statements are allowed', reason: entry.reason });
            break;
          }

          const { db, close } = openDatabase(entry.projectPath);
          try {
            const rows = db.prepare(entry.sql).all();
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

          const invalidFields = Object.keys(fields).filter(f => !UPDATABLE_TASK_FIELDS.has(f));
          if (invalidFields.length > 0) {
            results.push({
              action: 'update_task',
              success: false,
              error: `Fields not allowed: ${invalidFields.join(', ')}. Allowed: ${[...UPDATABLE_TASK_FIELDS].join(', ')}`,
            });
            break;
          }

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

            const id = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            db.prepare(
              'INSERT OR IGNORE INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
            ).run(id, entry.sectionId, entry.dependsOnSectionId);

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

      case 'suppress_anomaly': {
        if (!VALID_ANOMALY_TYPES.has(entry.anomalyType)) {
          results.push({
            action: 'suppress_anomaly',
            success: false,
            error: `Invalid anomaly type: ${entry.anomalyType}. Valid: ${[...VALID_ANOMALY_TYPES].join(', ')}`,
          });
          break;
        }
        try {
          const { db, close } = openGlobalDatabase();
          try {
            const hours = Math.max(1, Math.min(Number(entry.duration_hours) || 1, 168));
            const now = Date.now();
            const expiresAt = now + hours * 60 * 60 * 1000;
            db.prepare(
              `INSERT INTO monitor_suppressions (project_path, anomaly_type, reason, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(project_path, anomaly_type) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at`
            ).run(entry.projectPath, entry.anomalyType, entry.reason, now, expiresAt);
            results.push({
              action: 'suppress_anomaly',
              success: true,
              reason: entry.reason,
              output: { projectPath: entry.projectPath, anomalyType: entry.anomalyType, expiresInHours: hours },
            });
          } finally {
            close();
          }
        } catch (err) {
          results.push({
            action: 'suppress_anomaly',
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

      case 'release_merge_lock': {
        try {
          const pid = getProjectHash(entry.projectPath);
          const { db: gdb, close } = openGlobalDatabase();
          try {
            gdb.prepare('DELETE FROM workspace_merge_locks WHERE project_id = ?').run(pid);
            results.push({ action: 'release_merge_lock', success: true, reason: entry.diagnosis });
          } finally { close(); }
        } catch (err) {
          results.push({ action: 'release_merge_lock', success: false, error: String(err) });
        }
        break;
      }

      case 'reset_merge_phase': {
        try {
          const { db, close } = openDatabase(entry.projectPath);
          try {
            const taskId = entry.taskId;
            if (!taskId) throw new Error('taskId required');
            db.prepare(
              `UPDATE tasks SET merge_phase = 'queued', rebase_attempts = 0, updated_at = datetime('now')
               WHERE id = ? AND status = 'merge_pending'`
            ).run(taskId);
            results.push({ action: 'reset_merge_phase', success: true, reason: entry.diagnosis });
          } finally { close(); }
        } catch (err) {
          results.push({ action: 'reset_merge_phase', success: false, error: String(err) });
        }
        break;
      }
    }
  }

  return results;
}

