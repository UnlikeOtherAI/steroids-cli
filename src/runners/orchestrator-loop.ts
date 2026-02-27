/**
 * Orchestrator loop - core task processing logic
 * Used by both the daemon and the loop command
 */

import { openDatabase, getDbPath } from '../database/connection.js';
import { autoMigrate } from '../migrations/index.js';
import { getTask, getSection, incrementTaskFailureCount, updateTaskStatus, listTasks } from '../database/queries.js';
import {
  selectNextTask,
  selectNextTaskWithLock,
  selectTaskBatch,
  markTaskInProgress,
  releaseTaskLockAfterCompletion,
  getTaskCounts,
  type SelectedTaskWithLock,
} from '../orchestrator/task-selector.js';
import { invokeCoderBatch } from '../orchestrator/coder.js';
import { loadConfig } from '../config/loader.js';
import { invokeReviewerBatch } from '../orchestrator/reviewer.js';
import { logActivity } from './activity-log.js';
import { getRegisteredProject } from './projects.js';
import { execSync } from 'node:child_process';
import { runCoderPhase, runReviewerPhase, type CreditExhaustionResult } from '../commands/loop-phases.js';
import { handleCreditExhaustion, checkBatchCreditExhaustion } from './credit-pause.js';
import { pushToRemote } from '../git/push.js';
import { withGlobalDatabase, openGlobalDatabase } from './global-db.js';
import { ensureWorkspaceSteroidsSymlink, getProjectHash } from '../parallel/clone.js';
import type { PoolSlotContext } from '../workspace/types.js';
import { claimSlot, finalizeSlotPath, releaseSlot, partialReleaseSlot, resolveRemoteUrl, refreshSlotHeartbeat, getSlot } from '../workspace/pool.js';
import { refreshWorkspaceMergeLockHeartbeat } from '../workspace/merge-lock.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Only active when not focusing on a specific section and batch mode is enabled
      if (batchMode && !activeSectionIds) {
        const batch = selectTaskBatch(db, maxBatchSize);
        if (batch && batch.tasks.length > 0) {
          console.log(`[BATCH MODE] Section "${batch.sectionName}" - ${batch.tasks.length} tasks`);

          // Mark all tasks as in_progress
          if (!refreshParallelWorkstreamLease(options.parallelSessionId, projectPath, options.runnerId)) {
            console.log('Lease ownership lost during batch processing; stopping loop.');
            break;
          }
          for (const task of batch.tasks) {
            markTaskInProgress(db, task.id);
            options.onTaskStart?.(task.id, 'batch');
          }

          // Invoke batch coder
          ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);
          console.log('\n>>> Invoking BATCH CODER...\n');
          const batchCoderResult = await invokeCoderBatch(batch.tasks, batch.sectionName, projectPath);

          // Always check for credit/rate_limit exhaustion (returns null on success)
          const coderCreditAlert = await checkBatchCreditExhaustion(batchCoderResult, 'coder', projectPath);
          if (coderCreditAlert) {
            const pauseResult = await handleCreditExhaustion({
              ...coderCreditAlert,
              projectPath,
              runnerId: options.runnerId ?? 'daemon',
              db,
              shouldStop: options.shouldStop ?? (() => false),
              onHeartbeat: options.onHeartbeat,
              onceMode: options.once ?? false,
            });
            if (!pauseResult.resolved) break;
            continue;
          }

          if (batchCoderResult.timedOut || !batchCoderResult.success) {
            const coderConfig = loadConfig(projectPath).ai?.coder;
            const providerName = coderConfig?.provider ?? 'unknown';
            const modelName = coderConfig?.model ?? 'unknown';
            const output = (batchCoderResult.stderr || batchCoderResult.stdout || '').trim();
            handleBatchProviderFailure(
              db,
              batch.tasks,
              'coder',
              providerName,
              modelName,
              batchCoderResult.exitCode ?? 1,
              output
            );

            const batchHasWork = batch.tasks.some((task) => {
              const current = getTask(db, task.id);
              return !!current && current.status === 'pending';
            });
            if (batchHasWork) {
              continue;
            }

            break;
          }

          // Check which tasks are now in review status
          const tasksInReview = batch.tasks
            .map(t => getTask(db, t.id))
            .filter((t): t is NonNullable<typeof t> => t !== null && t.status === 'review');

          if (tasksInReview.length > 0) {
            console.log(`\n[BATCH MODE] ${tasksInReview.length} tasks ready for batch review\n`);

            // Invoke batch reviewer
            ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);
            console.log('\n>>> Invoking BATCH REVIEWER...\n');
            const batchReviewerResult = await invokeReviewerBatch(tasksInReview, batch.sectionName, projectPath);

            // Always check for credit/rate_limit exhaustion (returns null on success)
            const reviewerCreditAlert = await checkBatchCreditExhaustion(batchReviewerResult, 'reviewer', projectPath);
            if (reviewerCreditAlert) {
              const pauseResult = await handleCreditExhaustion({
                ...reviewerCreditAlert,
                projectPath,
                runnerId: options.runnerId ?? 'daemon',
                db,
                shouldStop: options.shouldStop ?? (() => false),
                onHeartbeat: options.onHeartbeat,
                onceMode: options.once ?? false,
              });
              if (!pauseResult.resolved) break;
              continue;
            }

            if (batchReviewerResult.timedOut || !batchReviewerResult.success) {
              const reviewerConfig = loadConfig(projectPath).ai?.reviewer;
              const providerName = reviewerConfig?.provider ?? 'unknown';
              const modelName = reviewerConfig?.model ?? 'unknown';
              const output = (batchReviewerResult.stderr || batchReviewerResult.stdout || '').trim();
              handleBatchProviderFailure(
                db,
                tasksInReview,
                'reviewer',
                providerName,
                modelName,
                batchReviewerResult.exitCode ?? 1,
                output
              );

              const batchHasWork = tasksInReview.some((task) => {
                const current = getTask(db, task.id);
                return !!current && current.status === 'pending';
              });
              if (batchHasWork) {
                continue;
              }

              break;
            }

            // Handle results for each reviewed task
            for (const task of tasksInReview) {
              const updatedTask = getTask(db, task.id);
              if (!updatedTask) continue;

              const section = task.section_id ? getSection(db, task.section_id) : null;
              const sectionName = section?.name ?? null;

              if (updatedTask.status === 'completed' && options.runnerId) {
                // Get commit message for activity log
                let commitMessage: string | null = null;
                try {
                  commitMessage = execSync('git log -1 --format=%B', {
                    cwd: projectPath,
                    encoding: 'utf-8',
                  }).trim();
                } catch {
                  // Ignore error
                }

                logActivity(
                  projectPath,
                  options.runnerId,
                  task.id,
                  task.title,
                  sectionName,
                  'completed',
                  commitMessage
                );
              } else if (updatedTask.status === 'failed' && options.runnerId) {
                logActivity(
                  projectPath,
                  options.runnerId,
                  task.id,
                  task.title,
                  sectionName,
                  'failed'
                );
              } else if (updatedTask.status === 'disputed' && options.runnerId) {
                logActivity(
                  projectPath,
                  options.runnerId,
                  task.id,
                  task.title,
                  sectionName,
                  'disputed'
                );
              } else if (updatedTask.status === 'skipped' && options.runnerId) {
                logActivity(
                  projectPath,
                  options.runnerId,
                  task.id,
                  task.title,
                  sectionName,
                  'skipped'
                );
              }
            }

            // Push changes after batch review if any tasks were approved
            const approvedTasks = tasksInReview.filter(t => {
              const updated = getTask(db, t.id);
              return updated?.status === 'completed';
            });

            if (approvedTasks.length > 0) {
              if (!refreshParallelWorkstreamLease(options.parallelSessionId, projectPath, options.runnerId)) {
                console.log('Lease ownership lost before batch push; skipping remaining work in this runner.');
                break;
              }
              const pushResult = pushToRemote(projectPath, 'origin', branchName);
              if (pushResult.success) {
                console.log('Pushing batch changes to git...');
                console.log(`Pushed ${approvedTasks.length} approved task(s)`);
              } else {
                console.warn('Failed to push batch changes:', pushResult.error);
              }
            }
          }

          // Notify completion for each task
          for (const task of batch.tasks) {
            options.onTaskComplete?.(task.id);
          }

          if (once) {
            console.log('\n[--once] Stopping after one batch');
            break;
          }

          await sleep(1000);
          continue;
        }
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

      // ── Workspace pool: claim slot, start heartbeat ──
      let poolSlotCtx: PoolSlotContext | undefined;
      let poolGlobalDb: ReturnType<typeof openGlobalDatabase> | undefined;

      if (options.runnerId) {
        try {
          const gdb = openGlobalDatabase();
          poolGlobalDb = gdb;
          const projectId = getProjectHash(projectPath);
          const remoteUrl = resolveRemoteUrl(projectPath);
          const localOnly = remoteUrl === null;
          const slot = claimSlot(gdb.db, projectId, options.runnerId, task.id);
          const finalSlot = finalizeSlotPath(gdb.db, slot.id, projectPath, remoteUrl);

          const heartbeatTimer = setInterval(() => {
            try {
              refreshSlotHeartbeat(gdb.db, finalSlot.id);
              // Also keep merge lock alive if one is held
              refreshWorkspaceMergeLockHeartbeat(gdb.db, projectId, options.runnerId!);
            } catch {
              // Tolerate heartbeat failures — reconciliation handles stale slots
            }
          }, 30_000);

          poolSlotCtx = { globalDb: gdb.db, slot: finalSlot, heartbeatTimer, localOnly };
        } catch (error) {
          console.warn('Pool slot claim failed, running without pool:', (error as Error).message);
          // Fall back to non-pool mode
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
            poolSlotCtx
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
            poolSlotCtx
          );
        } else if (action === 'review') {
          ensureParallelWorkspaceSteroids(projectPath, parallelSourceProjectPath);
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
        // ── Pool cleanup: stop heartbeat, release slot ──
        if (poolSlotCtx) {
          if (poolSlotCtx.heartbeatTimer) {
            clearInterval(poolSlotCtx.heartbeatTimer);
          }
          try {
            // After the coder phase the slot may be in 'awaiting_review' status.
            // Use partialReleaseSlot so task_branch/base_branch/starting_sha
            // survive into the reviewer's claimSlot call next iteration.
            // For all other statuses (including after reviewer merge) do a full release.
            const currentSlot = getSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
            if (currentSlot?.status === 'awaiting_review') {
              partialReleaseSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
            } else {
              releaseSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
            }
          } catch {
            // Tolerate release failures — reconciliation handles cleanup
          }
        }
        if (poolGlobalDb) {
          try { poolGlobalDb.close(); } catch { /* ignore */ }
        }

        if (options.runnerId) {
          releaseTaskLockAfterCompletion(db, task.id, options.runnerId, lockHeartbeat);
        }
      }

      // Handle credit exhaustion result from single-task phase
      if (creditResult) {
        const pauseResult = await handleCreditExhaustion({
          ...creditResult,
          projectPath,
          runnerId: options.runnerId ?? 'daemon',
          db,
          shouldStop: options.shouldStop ?? (() => false),
          onHeartbeat: options.onHeartbeat,
          onceMode: options.once ?? false,
        });
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
              commitMessage = execSync('git log -1 --format=%B', {
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

function formatBatchProviderFailureMessage(
  taskId: string,
  role: 'coder' | 'reviewer',
  provider: string,
  model: string,
  exitCode: number,
  output: string
): string {
  const sanitizedOutput = output || 'provider invocation failed with no output.';
  return `Task ${taskId}: provider ${provider}/${model} exited with non-zero status ${exitCode} during ${role} phase: ${sanitizedOutput}`;
}

function handleBatchProviderFailure(
  db: any,
  tasks: Array<{ id: string }>,
  role: 'coder' | 'reviewer',
  provider: string,
  model: string,
  exitCode: number,
  output: string
): void {
  for (const task of tasks) {
    const failureCount = incrementTaskFailureCount(db, task.id);
    const message = formatBatchProviderFailureMessage(task.id, role, provider, model, exitCode, output);

    if (failureCount >= 3) {
      const reason = `${message} (provider invocation failed ${failureCount} time(s). Task failed.)`;
      updateTaskStatus(db, task.id, 'failed', 'orchestrator', reason);
      console.log(`\n✗ Task failed (${reason})`);
    } else {
      updateTaskStatus(db, task.id, 'pending', 'orchestrator', `${message} (attempt ${failureCount}/3, retrying)`);
    }
  }
}

// Note: runCoderPhase and runReviewerPhase are now imported from ../commands/loop-phases.js
// They implement the orchestrator-driven architecture where the orchestrator makes all status decisions
