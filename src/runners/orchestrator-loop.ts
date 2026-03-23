/**
 * Orchestrator loop - core task processing logic
 * Used by both the daemon and the loop command
 */

import { openDatabase, getDbPath } from '../database/connection.js';
import { autoMigrate } from '../migrations/index.js';
import { getTask, getSection, incrementTaskFailureCount, clearTaskFailureCount, updateTaskStatus, listTasks, getInvocationCount } from '../database/queries.js';
import {
  selectNextTask,
  selectNextTaskWithLock,
  markTaskInProgress,
  releaseTaskLockAfterCompletion,
  getTaskCounts,
  type SelectedTaskWithLock,
} from '../orchestrator/task-selector.js';
import { loadConfig } from '../config/loader.js';
import { logActivity } from './activity-log.js';
import { getRegisteredProject } from './projects.js';
import { execFileSync } from 'node:child_process';
import { runCoderPhase, runReviewerPhase, type CreditExhaustionResult } from '../commands/loop-phases.js';
import { handleCreditExhaustion, handleAuthError } from './credit-pause.js';
import { withGlobalDatabase, openGlobalDatabase } from './global-db.js';
import { runBatchIteration, type BatchResult } from './orchestrator-batch.js';
import { ensureWorkspaceSteroidsSymlink, getProjectHash } from '../parallel/clone.js';
import type { PoolSlotContext } from '../workspace/types.js';
import { claimSlot, finalizeSlotPath, releaseSlot, partialReleaseSlot, resolveRemoteUrl, refreshSlotHeartbeat, getSlot } from '../workspace/pool.js';
import { pushWithRetries } from '../workspace/git-helpers.js';
import { prepareForTask } from '../workspace/git-lifecycle.js';
import { resolveEffectiveBranch } from '../git/branch-resolver.js';
import { refreshWorkspaceMergeLockHeartbeat } from '../workspace/merge-lock.js';
import { waitForPressureRelief } from './system-pressure.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupPoolSlot(
  poolSlotCtx: PoolSlotContext,
  db: import('better-sqlite3').Database,
  taskId: string,
  config: ReturnType<typeof loadConfig>,
): void {
  if (poolSlotCtx.heartbeatTimer) clearInterval(poolSlotCtx.heartbeatTimer);
  try {
    const currentSlot = getSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
    if (currentSlot?.status === 'awaiting_review') {
      let durabilityPushFailed = false;
      if (currentSlot.slot_path && currentSlot.task_branch && currentSlot.remote_url) {
        const pushResult = pushWithRetries(
          currentSlot.slot_path, 'origin', currentSlot.task_branch, 2, [2000, 8000], true
        );
        if (!pushResult.success) {
          durabilityPushFailed = true;
          console.warn(`[pool] Failed to push ${currentSlot.task_branch} before partial release: ${pushResult.error ?? 'unknown error'}`);
        }
      }
      if (durabilityPushFailed) {
        const failCount = incrementTaskFailureCount(db, taskId);
        const maxAttempts = config.health?.maxRecoveryAttempts ?? 3;
        if (failCount >= maxAttempts) {
          updateTaskStatus(db, taskId, 'skipped', 'orchestrator',
            `Auto-skipped: task branch push failed ${failCount} times. Remote may be unreachable or misconfigured.`);
          console.warn(`[pool] Push failure cap reached (${failCount}/${maxAttempts}); task skipped.`);
        } else {
          updateTaskStatus(db, taskId, 'pending', 'orchestrator',
            `Returned to pending because task branch push failed before review handoff (${failCount}/${maxAttempts})`);
        }
        releaseSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
      } else {
        clearTaskFailureCount(db, taskId);
        partialReleaseSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
      }
    } else {
      releaseSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
    }
  } catch {
    // Tolerate release failures — reconciliation handles cleanup
  }
}

function resolveSectionIds(sectionId?: string, sectionIds?: string[]): string[] | undefined {
  if (sectionIds && sectionIds.length > 0) {
    return sectionIds;
  }
  return sectionId ? [sectionId] : undefined;
}

function refreshParallelWorkstreamLease(
  parallelSessionId: string | undefined,
  projectPath: string,
  runnerId: string | undefined
): boolean {
  if (!parallelSessionId) {
    return true;
  }

  return withGlobalDatabase((db) => {
    const row = db
      .prepare(
        `SELECT id, claim_generation, runner_id
         FROM workstreams
         WHERE session_id = ?
           AND clone_path = ?
           AND status = 'running'
         LIMIT 1`
      )
      .get(parallelSessionId, projectPath) as
      | { id: string; claim_generation: number; runner_id: string | null }
      | undefined;

    if (!row) {
      return false;
    }

    const owner = runnerId ?? row.runner_id ?? `runner:${process.pid ?? 'unknown'}`;
    const result = db
      .prepare(
        `UPDATE workstreams
         SET runner_id = ?,
             lease_expires_at = datetime('now', '+120 seconds')
         WHERE id = ?
           AND status = 'running'
           AND claim_generation = ?`
      )
      .run(owner, row.id, row.claim_generation);

    return result.changes === 1;
  });
}

function resolveParallelSourceProjectPath(parallelSessionId: string | undefined): string | null {
  if (!parallelSessionId) {
    return null;
  }

  return withGlobalDatabase((db) => {
    const row = db
      .prepare('SELECT project_path FROM parallel_sessions WHERE id = ? LIMIT 1')
      .get(parallelSessionId) as { project_path: string } | undefined;
    return row?.project_path ?? null;
  });
}

function ensureParallelWorkspaceSteroids(
  workspacePath: string,
  sourceProjectPath: string | null
): void {
  if (!sourceProjectPath) {
    return;
  }

  ensureWorkspaceSteroidsSymlink(workspacePath, sourceProjectPath);
}

export interface LoopOptions {
  projectPath: string;
  once?: boolean;
  sectionId?: string;
  sectionIds?: string[];
  branchName?: string;
  parallelSessionId?: string;
  runnerId?: string;   // For activity logging
  onIteration?: (iteration: number) => void;
  onTaskStart?: (taskId: string, action: string) => void;
  onTaskComplete?: (taskId: string) => void;
  shouldStop?: () => boolean;
  onHeartbeat?: () => void;  // Called during credit exhaustion pause to keep heartbeat alive
}

/**
 * Run the orchestrator loop
 * Processes tasks until all are complete or shouldStop returns true
 */
export async function runOrchestratorLoop(options: LoopOptions): Promise<void> {
  const {
    projectPath,
    once = false,
    shouldStop,
    sectionId,
    sectionIds,
    branchName = 'main',
  } = options;
  const activeSectionIds = resolveSectionIds(sectionId, sectionIds);
  const parallelSourceProjectPath = resolveParallelSourceProjectPath(options.parallelSessionId);

  // Parallel workspaces use a `.steroids` symlink; repair it if a prior command deleted it.
  ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);

  const { db, close } = openDatabase(projectPath);

  // Auto-migrate database if needed
  const dbPath = getDbPath(projectPath);
  const migrationResult = autoMigrate(db, dbPath);
  if (migrationResult.applied) {
    console.log(`Applied ${migrationResult.migrations.length} migration(s): ${migrationResult.migrations.join(', ')}`);
  } else if (migrationResult.error) {
    console.error(`Migration error: ${migrationResult.error}`);
    close();
    throw new Error(`Database migration failed: ${migrationResult.error}`);
  }

  // Load batch mode config
  const config = loadConfig(projectPath);
  const batchMode = config.sections?.batchMode ?? false;
  const maxBatchSize = config.sections?.maxBatchSize ?? 10;

  try {
    let iteration = 0;

    while (true) {
      // Check if we should stop
      if (shouldStop?.()) {
        console.log('\nLoop stopped by signal');
        break;
      }

      // Check if project has been disabled
      const registeredProject = getRegisteredProject(projectPath);
      if (registeredProject && !registeredProject.enabled) {
        console.log('\nProject has been disabled. Stopping loop.');
        break;
      }

      iteration++;
      console.log(`\n─── Iteration ${iteration} ───\n`);
      options.onIteration?.(iteration);
      ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);
      if (!refreshParallelWorkstreamLease(options.parallelSessionId, projectPath, options.runnerId)) {
        console.log('Lease ownership lost for this workstream runner; stopping loop.');
        break;
      }
      // Batch mode: process multiple pending tasks at once
      if (batchMode && !activeSectionIds) {
        const batchResult: BatchResult = await runBatchIteration({
          db, projectPath, branchName, options, once,
          refreshLease: () => refreshParallelWorkstreamLease(options.parallelSessionId, projectPath, options.runnerId),
          ensureSteroids: () => ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath),
        }, maxBatchSize);
        if (batchResult === 'break') break;
        if (batchResult === 'continue') { await sleep(1000); continue; }
      }

      // Select next task — use locking when a runnerId is present (parallel mode)
      // to prevent two runners from picking the same task simultaneously.
      const selected = options.runnerId
        ? selectNextTaskWithLock(db, {
            runnerId: options.runnerId,
            sectionId: options.sectionId,
            sectionIds: options.sectionIds,
            parallelSessionId: options.parallelSessionId,
          })
        : selectNextTask(db, activeSectionIds);

      if (!selected) {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                      ALL TASKS COMPLETE                       ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
        break;
      }

      const { task, action } = selected;
      // heartbeat is only present when selectNextTaskWithLock was used
      const lockHeartbeat = 'lockResult' in selected
        ? (selected as SelectedTaskWithLock).heartbeat
        : undefined;

      console.log(`Task: ${task.title}`);
      console.log(`Action: ${action}`);
      console.log(`Status: ${task.status}`);

      // ── Invocation cap: prevent runaway loops from burning API quota ──
      const maxInvocations = config.health?.maxInvocationsPerTask ?? 150;
      if (maxInvocations > 0) {
        const invCounts = getInvocationCount(db, task.id);
        if (invCounts.total >= maxInvocations) {
          console.warn(`\n✗ Task ${task.id} reached invocation cap (${invCounts.total}/${maxInvocations}). Skipping to prevent quota waste.`);
          updateTaskStatus(
            db,
            task.id,
            'skipped',
            'orchestrator',
            `Auto-skipped: invocation cap reached (${invCounts.total} invocations, limit ${maxInvocations}). Likely stuck in a loop. Review task history and reset manually if needed.`
          );
          if (options.runnerId) {
            releaseTaskLockAfterCompletion(db, task.id, options.runnerId, lockHeartbeat);
          }
          continue;
        }
      }

      const pressureOk = await waitForPressureRelief();
      if (!pressureOk) {
        console.error('[pressure] System under sustained pressure — stopping runner to prevent crash');
        break;
      }

      let poolSlotCtx: PoolSlotContext | undefined;
      let poolGlobalDb: ReturnType<typeof openGlobalDatabase> | undefined;
      const sourceProjectPath = parallelSourceProjectPath ?? projectPath;

      if (options.runnerId) {
        try {
          const gdb = openGlobalDatabase();
          poolGlobalDb = gdb;
          const projectId = getProjectHash(sourceProjectPath);
          const remoteUrl = resolveRemoteUrl(sourceProjectPath);
          if (!remoteUrl) {
            console.warn(`[pool] Skipping pool mode for ${projectPath}: no remote URL. Pool requires a pushable remote.`);
          } else {
            const slot = claimSlot(gdb.db, projectId, options.runnerId, task.id);
            const finalSlot = finalizeSlotPath(gdb.db, slot.id, sourceProjectPath, remoteUrl);

            const heartbeatTimer = setInterval(() => {
              try {
                refreshSlotHeartbeat(gdb.db, finalSlot.id);
                // Also keep merge lock alive if one is held
                refreshWorkspaceMergeLockHeartbeat(gdb.db, projectId, options.runnerId!);
              } catch {
                // Tolerate heartbeat failures — reconciliation handles stale slots
              }
            }, 30_000);

            poolSlotCtx = { globalDb: gdb.db, slot: finalSlot, heartbeatTimer, localOnly: false };
          }
        } catch (error) {
          console.warn('Pool slot claim failed, running without pool:', (error as Error).message);
        }
      }

      let creditResult: CreditExhaustionResult | void = undefined;

      try {
        options.onTaskStart?.(task.id, action);
        lockHeartbeat?.start();
        if (action === 'start') {
          ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);
          markTaskInProgress(db, task.id);
          creditResult = await runCoderPhase(
            db,
            task,
            projectPath,
            'start',
            false,
            undefined,
            undefined,
            {
              parallelSessionId: options.parallelSessionId,
              runnerId: options.runnerId,
            },
            branchName,
            poolSlotCtx,
            sourceProjectPath
          );
        } else if (action === 'resume') {
          ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);
          creditResult = await runCoderPhase(
            db,
            task,
            projectPath,
            'resume',
            false,
            undefined,
            undefined,
            {
              parallelSessionId: options.parallelSessionId,
              runnerId: options.runnerId,
            },
            branchName,
            poolSlotCtx,
            sourceProjectPath
          );
        } else if (action === 'review') {
          // S7: Task selector may route pending tasks with prior coder work to review.
          // Transition status so the reviewer phase sees the task in 'review' status.
          // C1: Also update the in-memory object so downstream audit entries are accurate.
          if (task.status === 'pending') {
            updateTaskStatus(db, task.id, 'review', 'orchestrator');
            (task as any).status = 'review';
          }
          ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);

          // S7/I1: Fresh slot lacks branch metadata — prepare it so mergeToBase works.
          if (poolSlotCtx && !poolSlotCtx.slot.task_branch) {
            const prepResult = prepareForTask(
              poolSlotCtx.globalDb, poolSlotCtx.slot, task.id, projectPath, sourceProjectPath,
              resolveEffectiveBranch(db, task.section_id ?? null, config), config.git?.branch ?? null);
            if (prepResult.ok) {
              Object.assign(poolSlotCtx.slot, {
                task_branch: prepResult.taskBranch, base_branch: prepResult.baseBranch,
                starting_sha: prepResult.startingSha,
              });
            } else { console.warn(`[S7] Pool slot prep failed (blocked=${prepResult.blocked}): ${prepResult.reason}`); }
          }

          creditResult = await runReviewerPhase(
            db,
            task,
            projectPath,
            false,
            undefined,
            branchName,
            {
              parallelSessionId: options.parallelSessionId,
              runnerId: options.runnerId,
            },
            poolSlotCtx
          );
        }
      } finally {
        if (poolSlotCtx) cleanupPoolSlot(poolSlotCtx, db, task.id, config);
        if (poolGlobalDb) {
          try { poolGlobalDb.close(); } catch { /* ignore */ }
        }

        if (options.runnerId) {
          releaseTaskLockAfterCompletion(db, task.id, options.runnerId, lockHeartbeat);
        }
      }

      // Handle credit exhaustion or auth error result from single-task phase
      if (creditResult) {
        const pauseOptions = {
          ...creditResult,
          projectPath,
          runnerId: options.runnerId ?? 'daemon',
          db,
          shouldStop: options.shouldStop ?? (() => false),
          onHeartbeat: options.onHeartbeat,
          onceMode: options.once ?? false,
        };
        const pauseResult = creditResult.action === 'pause_auth_error'
          ? await handleAuthError(pauseOptions)
          : await handleCreditExhaustion(pauseOptions);
        if (!pauseResult.resolved) break;
        continue;
      }

      // Log activity if task reached terminal status
      if (options.runnerId) {
        const updatedTask = getTask(db, task.id);
        if (updatedTask && ['completed', 'failed', 'disputed', 'skipped'].includes(updatedTask.status)) {
          const section = updatedTask.section_id ? getSection(db, updatedTask.section_id) : null;
          const sectionName = section?.name ?? null;

          // Get commit message for completed tasks
          let commitMessage: string | null = null;
          if (updatedTask.status === 'completed') {
            try {
              commitMessage = execFileSync('git', ['log', '-1', '--format=%B'], {
                cwd: projectPath,
                encoding: 'utf-8',
              }).trim();
            } catch {
              // Ignore error
            }
          }

          logActivity(
            projectPath,
            options.runnerId,
            updatedTask.id,
            updatedTask.title,
            sectionName,
            updatedTask.status as 'completed' | 'failed' | 'disputed' | 'skipped',
            commitMessage
          );
        }
      }

      options.onTaskComplete?.(task.id);

      if (once) {
        console.log('\n[--once] Stopping after one iteration');
        break;
      }

      // Brief pause between iterations
      await sleep(1000);
    }

    // Final status
    const finalCounts = activeSectionIds && activeSectionIds.length === 1
      ? getTaskCounts(db, activeSectionIds[0])
      : getTaskCounts(db);
    console.log('\nFinal Status:');
    console.log(`  Completed: ${finalCounts.completed}`);
    console.log(`  Failed:    ${finalCounts.failed}`);
    console.log(`  Disputed:  ${finalCounts.disputed}`);
  } finally {
    close();
  }
}

