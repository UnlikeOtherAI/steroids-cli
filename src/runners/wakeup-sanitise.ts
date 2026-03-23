/**
 * Periodic state sanitisation for projects in wakeup
 */

import { openDatabase } from '../database/connection.js';
import { openGlobalDatabase } from './global-db.js';
import { loadConfig } from '../config/loader.js';
import {
  type StaleInvocationRow,
  shouldSkipInvocation,
  isRunnerProcessDead,
  recoverOrphanedInvocation,
} from './wakeup-sanitise-recovery.js';
import { getProjectHash } from '../parallel/clone.js';

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
  recoveredDisputedTasks: number;
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

export { parseReviewerDecisionFromInvocationLogContent } from './wakeup-sanitise-recovery.js';

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
    recoveredDisputedTasks: 0,
  };

  const staleCutoffMs = Date.now() - staleInvocationTimeoutSec * 1000;
  // S1/S2: Include parallel session runners (workspace-prefixed paths don't match project_path directly)
  const activeRunnerTaskRows = globalDb
    .prepare(
      `SELECT r.current_task_id, r.parallel_session_id
       FROM runners r
       LEFT JOIN parallel_sessions ps ON ps.id = r.parallel_session_id
       WHERE (r.project_path = ? OR ps.project_path = ?)
         AND r.status = 'running'
         AND r.heartbeat_at > datetime('now', '-5 minutes')
         AND (r.current_task_id IS NOT NULL OR r.parallel_session_id IS NOT NULL)`
    )
    .all(projectPath, projectPath) as Array<{ current_task_id: string | null; parallel_session_id: string | null }>;
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
    const STALE_LOCK_TTL_MS = 90_000;
    const projectId = getProjectHash(projectPath);
    const mergeLockRows = globalDb
      .prepare('SELECT heartbeat_at FROM workspace_merge_locks WHERE project_id = ?')
      .all(projectId) as Array<{ heartbeat_at: string }>;
    const nowMs = Date.now();
    hasActiveMergeLock = mergeLockRows.some((row) => {
      const hbMs = Date.parse(row.heartbeat_at);
      return Number.isFinite(hbMs) && (nowMs - hbMs) < STALE_LOCK_TTL_MS;
    });
  } catch {
    hasActiveMergeLock = false;
  }

  // ── Pass 1: Stale invocations (exceeded timeout, any runner state) ──
  const staleInvocations = projectDb
    .prepare(
      `SELECT i.id, i.task_id, i.role, i.started_at_ms, i.runner_id, t.status AS task_status
       FROM task_invocations i
       LEFT JOIN tasks t ON t.id = i.task_id
       WHERE i.status = 'running'
         AND i.started_at_ms IS NOT NULL
         AND i.started_at_ms <= ?
       ORDER BY i.started_at_ms ASC`
    )
    .all(staleCutoffMs) as Array<StaleInvocationRow>;

  for (const row of staleInvocations) {
    if (shouldSkipInvocation(row, activeTaskIds, hasActiveMergeLock, hasActiveParallelRunner, globalDb)) {
      continue;
    }
    recoverOrphanedInvocation(projectDb, projectPath, row, dryRun, summary, 'stale timeout');
  }

  // ── Pass 2: Dead-runner orphans (runner process is dead, invocation >2 min old) ──
  // Catches invocations left 'running' by crashed/killed runners without waiting 30 min.
  const deadRunnerCutoffMs = Date.now() - 120_000;
  const recentRunningInvocations = projectDb
    .prepare(
      `SELECT i.id, i.task_id, i.role, i.started_at_ms, i.runner_id, t.status AS task_status
       FROM task_invocations i
       LEFT JOIN tasks t ON t.id = i.task_id
       WHERE i.status = 'running'
         AND i.started_at_ms IS NOT NULL
         AND i.started_at_ms > ?
         AND i.started_at_ms <= ?
       ORDER BY i.started_at_ms ASC`
    )
    .all(staleCutoffMs, deadRunnerCutoffMs) as Array<StaleInvocationRow>;

  for (const row of recentRunningInvocations) {
    const isRebaseRole = row.role === 'rebase_coder' || row.role === 'rebase_reviewer';
    if (activeTaskIds.has(row.task_id) || (hasActiveMergeLock && !isRebaseRole)) {
      continue;
    }
    // Only recover if we can confirm the runner process is dead
    if (!isRunnerProcessDead(row.runner_id, globalDb)) {
      continue;
    }
    recoverOrphanedInvocation(projectDb, projectPath, row, dryRun, summary, 'dead runner');
  }

  // ── Pass 3: Orphaned task locks (task has no running invocations and no active runner) ──
  if (!dryRun) {
    const orphanedLocks = projectDb
      .prepare(
        `SELECT tl.task_id FROM task_locks tl
         WHERE NOT EXISTS (
           SELECT 1 FROM task_invocations i
           WHERE i.task_id = tl.task_id AND i.status = 'running'
         )
         AND tl.task_id NOT IN (${
           activeTaskIds.size > 0
             ? [...activeTaskIds].map(() => '?').join(',')
             : "'__none__'"
         })`
      )
      .all(...(activeTaskIds.size > 0 ? [...activeTaskIds] : [])) as Array<{ task_id: string }>;

    if (orphanedLocks.length > 0) {
      const taskIds = orphanedLocks.map((r) => r.task_id);
      const placeholders = taskIds.map(() => '?').join(',');
      const released = projectDb
        .prepare(`DELETE FROM task_locks WHERE task_id IN (${placeholders})`)
        .run(...taskIds);
      summary.releasedTaskLocks += released.changes;
    }
  }

  if (!dryRun) {
    const releasedTaskLocks = projectDb
      .prepare(`DELETE FROM task_locks WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run();
    summary.releasedTaskLocks += releasedTaskLocks.changes;

    const releasedSectionLocks = projectDb
      .prepare(`DELETE FROM section_locks WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run();
    summary.releasedSectionLocks = releasedSectionLocks.changes;

    // S3: Recover disputed tasks stuck > 30 min with no active arbitration invocation.
    // Note: no code currently inserts role='arbitrator' invocations — the subquery is a
    // forward-looking guard. The 30-minute timeout is the effective sole guard today.
    try {
      const disputedRows = projectDb
        .prepare(
          `SELECT id FROM tasks
           WHERE status = 'disputed'
             AND updated_at < datetime('now', '-30 minutes')
             AND id NOT IN (
               SELECT task_id FROM task_invocations
               WHERE role = 'arbitrator' AND status = 'running'
             )`
        )
        .all() as Array<{ id: string }>;

      if (disputedRows.length > 0) {
        const ids = disputedRows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        projectDb
          .prepare(
            `UPDATE tasks SET status = 'pending', merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0, updated_at = datetime('now')
             WHERE id IN (${placeholders})`
          )
          .run(...ids);

        const auditStmt = projectDb.prepare(
          `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
           VALUES (?, 'disputed', 'pending', 'orchestrator', 'orchestrator',
                   'Recovered by periodic sanitise — disputed task stuck >30 min with no active arbitration.',
                   datetime('now'))`
        );
        for (const id of ids) {
          auditStmt.run(id);
        }
        // Release any locks held by disputed tasks
        projectDb
          .prepare(`DELETE FROM task_locks WHERE task_id IN (${placeholders})`)
          .run(...ids);
      }
      summary.recoveredDisputedTasks = disputedRows.length;
    } catch {
      // task_invocations may lack role column or audit table schema mismatch — safe to skip
    }
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
      recoveredDisputedTasks: 0,
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
      recoveredDisputedTasks: 0,
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
    summary.releasedSectionLocks +
    summary.recoveredDisputedTasks
  );
}
