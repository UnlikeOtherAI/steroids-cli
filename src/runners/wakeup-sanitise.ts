/**
 * Periodic state sanitisation for projects in wakeup
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../database/connection.js';
import { openGlobalDatabase } from './global-db.js';
import { loadConfig } from '../config/loader.js';

export interface SanitiseSettings {
  enabled: boolean;
  intervalMinutes: number;
  staleInvocationTimeoutSec: number;
}

export interface SanitiseSummary {
  ran: boolean;
  reason: string;
  recoveredApprovals: number;
  recoveredRejects: number;
  closedStaleInvocations: number;
  releasedTaskLocks: number;
  releasedSectionLocks: number;
}

const DEFAULT_SANITISE_INTERVAL_MINUTES = 5;
const DEFAULT_SANITISE_INVOCATION_TIMEOUT_SEC = 1800;

export function getSanitiseSettings(projectPath: string): SanitiseSettings {
  const config = loadConfig(projectPath);
  const health = config.health ?? {};

  const enabled = health.sanitiseEnabled ?? true;
  const intervalMinutes = Math.max(
    1,
    Number(health.sanitiseIntervalMinutes ?? DEFAULT_SANITISE_INTERVAL_MINUTES)
  );
  const staleInvocationTimeoutSec = Math.max(
    60,
    Number(health.sanitiseInvocationTimeoutSec ?? DEFAULT_SANITISE_INVOCATION_TIMEOUT_SEC)
  );

  return { enabled, intervalMinutes, staleInvocationTimeoutSec };
}

function getSanitiseSchemaKey(projectPath: string): string {
  return `wakeup_sanitise_last_run::${projectPath}`;
}

export function shouldRunPeriodicSanitise(
  db: ReturnType<typeof openGlobalDatabase>['db'],
  projectPath: string,
  intervalMinutes: number
): boolean {
  const key = getSanitiseSchemaKey(projectPath);
  const row = db
    .prepare('SELECT value FROM _global_schema WHERE key = ?')
    .get(key) as { value: string } | undefined;

  if (!row?.value) {
    return true;
  }

  const due = db.prepare(
    `SELECT CASE
       WHEN datetime(?) <= datetime('now', ?)
       THEN 1 ELSE 0
     END AS due`
  ).get(row.value, `-${intervalMinutes} minutes`) as { due: number } | undefined;

  return (due?.due ?? 0) === 1;
}

function markPeriodicSanitiseRun(
  db: ReturnType<typeof openGlobalDatabase>['db'],
  projectPath: string
): void {
  db.prepare(
    `INSERT INTO _global_schema (key, value) VALUES (?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(getSanitiseSchemaKey(projectPath));
}

function parseReviewerDecisionFromLog(
  projectPath: string,
  invocationId: number
): 'approve' | 'reject' | null {
  const logPath = join(projectPath, '.steroids', 'invocations', `${invocationId}.log`);
  if (!existsSync(logPath)) {
    return null;
  }

  try {
    const raw = readFileSync(logPath, 'utf-8');
    if (raw.includes('DECISION: APPROVE')) {
      return 'approve';
    }
    if (raw.includes('DECISION: REJECT')) {
      return 'reject';
    }
  } catch {
    return null;
  }

  return null;
}

function sanitiseProjectState(
  globalDb: ReturnType<typeof openGlobalDatabase>['db'],
  projectDb: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  dryRun: boolean,
  staleInvocationTimeoutSec: number
): SanitiseSummary {
  const summary: SanitiseSummary = {
    ran: true,
    reason: 'ok',
    recoveredApprovals: 0,
    recoveredRejects: 0,
    closedStaleInvocations: 0,
    releasedTaskLocks: 0,
    releasedSectionLocks: 0,
  };

  const staleCutoffMs = Date.now() - staleInvocationTimeoutSec * 1000;
  const activeRunnerTaskRows = globalDb
    .prepare(
      `SELECT current_task_id, parallel_session_id
       FROM runners
       WHERE project_path = ?
         AND status = 'running'
         AND heartbeat_at > datetime('now', '-5 minutes')
         AND (current_task_id IS NOT NULL OR parallel_session_id IS NOT NULL)`
    )
    .all(projectPath) as Array<{ current_task_id: string | null; parallel_session_id: string | null }>;
  const activeTaskIds = new Set(
    activeRunnerTaskRows
      .map((row) => row.current_task_id)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
  );
  const hasActiveParallelRunner = activeRunnerTaskRows.some(
    (row) => typeof row.parallel_session_id === 'string' && row.parallel_session_id.length > 0
  );
  let hasActiveMergeLock = false;
  try {
    const mergeLockRows = projectDb
      .prepare('SELECT expires_at FROM merge_locks')
      .all() as Array<{ expires_at: string }>;
    const nowMs = Date.now();
    hasActiveMergeLock = mergeLockRows.some((row) => {
      const expiresAtMs = Date.parse(row.expires_at);
      return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
    });
  } catch {
    hasActiveMergeLock = false;
  }

  const hasActiveParallelContext = hasActiveParallelRunner || hasActiveMergeLock;

  const staleInvocations = projectDb
    .prepare(
      `SELECT i.id, i.task_id, i.role, i.started_at_ms, t.status AS task_status
       FROM task_invocations i
       LEFT JOIN tasks t ON t.id = i.task_id
       WHERE i.status = 'running'
         AND i.started_at_ms IS NOT NULL
         AND i.started_at_ms <= ?
       ORDER BY i.started_at_ms ASC`
    )
    .all(staleCutoffMs) as Array<{
    id: number;
    task_id: string;
    role: string;
    started_at_ms: number;
    task_status: string | null;
  }>;

  for (const row of staleInvocations) {
    if (activeTaskIds.has(row.task_id) || hasActiveParallelContext) {
      continue;
    }

    const completedAtMs = Date.now();
    const durationMs = Math.max(0, completedAtMs - row.started_at_ms);
    const reviewerDecision =
      row.role === 'reviewer'
        ? parseReviewerDecisionFromLog(projectPath, row.id)
        : null;

    if (!dryRun) {
      if (reviewerDecision === 'approve' && row.task_status === 'review') {
        projectDb
          .prepare(
            `UPDATE task_invocations
             SET status = 'completed',
                 success = 1,
                 timed_out = 0,
                 exit_code = 0,
                 completed_at_ms = ?,
                 duration_ms = ?,
                 error = COALESCE(error, 'Recovered by periodic sanitise (review approve token found).')
             WHERE id = ? AND status = 'running'`
          )
          .run(completedAtMs, durationMs, row.id);

        projectDb
          .prepare(
            `UPDATE tasks
             SET status = 'completed',
                 updated_at = datetime('now')
             WHERE id = ? AND status = 'review'`
          )
          .run(row.task_id);

        projectDb
          .prepare(
            `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
             SELECT ?, 'review', 'completed', 'orchestrator', 'orchestrator',
                    'Recovered by periodic sanitise from reviewer decision log (DECISION: APPROVE).',
                    datetime('now')
             WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'completed')`
          )
          .run(row.task_id, row.task_id);
      } else if (reviewerDecision === 'reject' && row.task_status === 'review') {
        projectDb
          .prepare(
            `UPDATE task_invocations
             SET status = 'completed',
                 success = 1,
                 timed_out = 0,
                 exit_code = 0,
                 completed_at_ms = ?,
                 duration_ms = ?,
                 error = COALESCE(error, 'Recovered by periodic sanitise (review reject token found).')
             WHERE id = ? AND status = 'running'`
          )
          .run(completedAtMs, durationMs, row.id);

        projectDb
          .prepare(
            `UPDATE tasks
             SET status = 'in_progress',
                 rejection_count = COALESCE(rejection_count, 0) + 1,
                 updated_at = datetime('now')
             WHERE id = ? AND status = 'review'`
          )
          .run(row.task_id);

        projectDb
          .prepare(
            `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
             SELECT ?, 'review', 'in_progress', 'orchestrator', 'orchestrator',
                    'Recovered by periodic sanitise from reviewer decision log (DECISION: REJECT).',
                    datetime('now')
             WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'in_progress')`
          )
          .run(row.task_id, row.task_id);
      } else {
        projectDb
          .prepare(
            `UPDATE task_invocations
             SET status = 'failed',
                 success = 0,
                 timed_out = 1,
                 exit_code = 1,
                 completed_at_ms = ?,
                 duration_ms = ?,
                 error = COALESCE(error, 'Periodic sanitise closed stale running invocation.')
             WHERE id = ? AND status = 'running'`
          )
          .run(completedAtMs, durationMs, row.id);
      }
    }

    if (reviewerDecision === 'approve' && row.task_status === 'review') {
      summary.recoveredApprovals += 1;
    } else if (reviewerDecision === 'reject' && row.task_status === 'review') {
      summary.recoveredRejects += 1;
    } else {
      summary.closedStaleInvocations += 1;
    }
  }

  if (!dryRun) {
    const releasedTaskLocks = projectDb
      .prepare(`DELETE FROM task_locks WHERE expires_at <= datetime('now')`)
      .run();
    summary.releasedTaskLocks = releasedTaskLocks.changes;

    const releasedSectionLocks = projectDb
      .prepare(`DELETE FROM section_locks WHERE expires_at <= datetime('now')`)
      .run();
    summary.releasedSectionLocks = releasedSectionLocks.changes;
  }

  return summary;
}

export function runPeriodicSanitiseForProject(
  globalDb: ReturnType<typeof openGlobalDatabase>['db'],
  projectDb: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  dryRun: boolean
): SanitiseSummary {
  const settings = getSanitiseSettings(projectPath);
  if (!settings.enabled) {
    return {
      ran: false,
      reason: 'disabled',
      recoveredApprovals: 0,
      recoveredRejects: 0,
      closedStaleInvocations: 0,
      releasedTaskLocks: 0,
      releasedSectionLocks: 0,
    };
  }

  if (!shouldRunPeriodicSanitise(globalDb, projectPath, settings.intervalMinutes)) {
    return {
      ran: false,
      reason: 'interval_not_due',
      recoveredApprovals: 0,
      recoveredRejects: 0,
      closedStaleInvocations: 0,
      releasedTaskLocks: 0,
      releasedSectionLocks: 0,
    };
  }

  const summary = sanitiseProjectState(
    globalDb,
    projectDb,
    projectPath,
    dryRun,
    settings.staleInvocationTimeoutSec
  );

  if (!dryRun) {
    markPeriodicSanitiseRun(globalDb, projectPath);
  }

  return summary;
}

export function sanitisedActionCount(summary: SanitiseSummary): number {
  return (
    summary.recoveredApprovals +
    summary.recoveredRejects +
    summary.closedStaleInvocations +
    summary.releasedTaskLocks +
    summary.releasedSectionLocks
  );
}
