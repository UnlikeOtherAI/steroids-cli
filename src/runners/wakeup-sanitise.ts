/**
 * Periodic state sanitisation for projects in wakeup
 */

import { openDatabase } from '../database/connection.js';
import { openGlobalDatabase } from './global-db.js';
import { loadConfig } from '../config/loader.js';
import {
  parseReviewerDecisionFromInvocationLogContent,
} from './wakeup-sanitise-recovery.js';
import { reconcileInvocationRuntimeState } from './wakeup-sanitise-runtime.js';

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
  recoveredFailedTasks: number;
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

async function sanitiseProjectState(
  globalDb: ReturnType<typeof openGlobalDatabase>['db'],
  projectDb: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  dryRun: boolean,
  staleInvocationTimeoutSec: number
): Promise<SanitiseSummary> {
  const summary: SanitiseSummary = {
    ran: true,
    reason: 'ok',
    recoveredApprovals: 0,
    recoveredRejects: 0,
    closedStaleInvocations: 0,
    releasedTaskLocks: 0,
    releasedSectionLocks: 0,
    recoveredDisputedTasks: 0,
    recoveredFailedTasks: 0,
  };

  const runtimeSummary = await reconcileInvocationRuntimeState({
    globalDb,
    projectDb,
    projectPath,
    dryRun,
    staleInvocationTimeoutSec,
  });
  summary.recoveredApprovals += runtimeSummary.recoveredApprovals;
  summary.recoveredRejects += runtimeSummary.recoveredRejects;
  summary.closedStaleInvocations += runtimeSummary.closedStaleInvocations;
  summary.releasedTaskLocks += runtimeSummary.releasedTaskLocks;

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

    // S4: Recover failed/skipped tasks stuck > 30 min.
    // Resets to 'pending' — the task selector's S7 logic will route to 'review'
    // (skipping the coder) if the coder already succeeded for the task.
    // Clears failure_count/rejection_count and merge columns for a fresh attempt.
    // Guard: count S4 recoveries since the task last made progress (reached
    // in_progress/review/merge_pending). If the task keeps failing without
    // advancing past its stuck phase, stop after 3 attempts. If it progresses
    // to a new phase then fails at a different stage, the counter resets.
    try {
      const MAX_S4_RECOVERIES = 3;
      const failedRows = projectDb
        .prepare(
          `SELECT t.id, t.status FROM tasks t
           WHERE t.status IN ('failed', 'skipped')
             AND t.updated_at < datetime('now', '-30 minutes')
             AND (
               SELECT COUNT(*) FROM audit a
               WHERE a.task_id = t.id
                 AND a.to_status = 'pending'
                 AND a.notes LIKE '%Recovered by periodic sanitise%failed/skipped%'
                 AND a.created_at > COALESCE(
                   (SELECT MAX(a2.created_at) FROM audit a2
                    WHERE a2.task_id = t.id
                      AND a2.to_status IN ('in_progress', 'review', 'merge_pending')),
                   '1970-01-01'
                 )
             ) < ?`
        )
        .all(MAX_S4_RECOVERIES) as Array<{ id: string; status: string }>;

      if (failedRows.length > 0) {
        const ids = failedRows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        projectDb
          .prepare(
            `UPDATE tasks
             SET status = 'pending',
                 failure_count = 0,
                 rejection_count = 0,
                 merge_phase = NULL,
                 approved_sha = NULL,
                 rebase_attempts = 0,
                 merge_failure_count = 0,
                 conflict_count = 0,
                 blocked_reason = NULL,
                 last_failure_at = NULL,
                 updated_at = datetime('now')
             WHERE id IN (${placeholders})`
          )
          .run(...ids);

        const auditStmt = projectDb.prepare(
          `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
           VALUES (?, ?, 'pending', 'orchestrator', 'orchestrator',
                   'Recovered by periodic sanitise — failed/skipped task reset for retry (S7 routes to correct phase).',
                   datetime('now'))`
        );
        for (const row of failedRows) {
          auditStmt.run(row.id, row.status);
        }
        projectDb
          .prepare(`DELETE FROM task_locks WHERE task_id IN (${placeholders})`)
          .run(...ids);

        // S4b: Pull back active downstream tasks.
        // When a foundational task is un-skipped, any in_progress/review/merge_pending
        // tasks in transitively dependent sections must be reset to pending so they
        // don't run before their foundation is rebuilt.
        const recoveredSectionIds = new Set(
          projectDb
            .prepare(
              `SELECT DISTINCT section_id FROM tasks WHERE id IN (${placeholders})`
            )
            .all(...ids)
            .map((r: any) => r.section_id as string)
            .filter(Boolean)
        );

        if (recoveredSectionIds.size > 0) {
          // Walk section_dependencies transitively to find all downstream sections
          const downstream = new Set<string>();
          const queue = [...recoveredSectionIds];
          while (queue.length > 0) {
            const sectionId = queue.pop()!;
            const dependents = projectDb
              .prepare(
                'SELECT section_id FROM section_dependencies WHERE depends_on_section_id = ?'
              )
              .all(sectionId) as Array<{ section_id: string }>;
            for (const d of dependents) {
              if (!downstream.has(d.section_id)) {
                downstream.add(d.section_id);
                queue.push(d.section_id);
              }
            }
          }

          if (downstream.size > 0) {
            const dsArray = [...downstream];
            const dsPlaceholders = dsArray.map(() => '?').join(',');
            const pulled = projectDb
              .prepare(
                `SELECT id, status FROM tasks
                 WHERE section_id IN (${dsPlaceholders})
                   AND status IN ('in_progress', 'review', 'merge_pending')`
              )
              .all(...dsArray) as Array<{ id: string; status: string }>;

            if (pulled.length > 0) {
              const pullIds = pulled.map((r) => r.id);
              const pullPlaceholders = pullIds.map(() => '?').join(',');
              projectDb
                .prepare(
                  `UPDATE tasks
                   SET status = 'pending',
                       merge_phase = NULL,
                       approved_sha = NULL,
                       rebase_attempts = 0,
                       updated_at = datetime('now')
                   WHERE id IN (${pullPlaceholders})`
                )
                .run(...pullIds);

              const pullAudit = projectDb.prepare(
                `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
                 VALUES (?, ?, 'pending', 'orchestrator', 'orchestrator',
                         'Pulled back by S4b — upstream foundational task recovered, must complete first.',
                         datetime('now'))`
              );
              for (const p of pulled) {
                pullAudit.run(p.id, p.status);
              }
              projectDb
                .prepare(`DELETE FROM task_locks WHERE task_id IN (${pullPlaceholders})`)
                .run(...pullIds);

              summary.recoveredFailedTasks += pulled.length;
            }
          }
        }
      } else {
        // No failed rows found — still init the count
      }
      summary.recoveredFailedTasks += failedRows.length;
    } catch {
      // Safe to skip on schema mismatch
    }
  }

  return summary;
}

export async function runPeriodicSanitiseForProject(
  globalDb: ReturnType<typeof openGlobalDatabase>['db'],
  projectDb: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  dryRun: boolean
): Promise<SanitiseSummary> {
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
      recoveredFailedTasks: 0,
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
      recoveredFailedTasks: 0,
    };
  }

  const summary = await sanitiseProjectState(
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

export { parseReviewerDecisionFromInvocationLogContent };

export function sanitisedActionCount(summary: SanitiseSummary): number {
  return (
    summary.recoveredApprovals +
    summary.recoveredRejects +
    summary.closedStaleInvocations +
    summary.releasedTaskLocks +
    summary.releasedSectionLocks +
    summary.recoveredDisputedTasks +
    summary.recoveredFailedTasks
  );
}
