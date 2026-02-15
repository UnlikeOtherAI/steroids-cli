/**
 * Orchestrator loop - core task processing logic
 * Used by both the daemon and the loop command
 */

import { openDatabase, getDbPath } from '../database/connection.js';
import { autoMigrate } from '../migrations/index.js';
import { getTask, getSection } from '../database/queries.js';
import {
  selectNextTask,
  selectTaskBatch,
  markTaskInProgress,
  getTaskCounts,
} from '../orchestrator/task-selector.js';
import { invokeCoderBatch } from '../orchestrator/coder.js';
import { loadConfig } from '../config/loader.js';
import { invokeReviewerBatch } from '../orchestrator/reviewer.js';
import { listTasks } from '../database/queries.js';
import { logActivity } from './activity-log.js';
import { getRegisteredProject } from './projects.js';
import { execSync } from 'node:child_process';
import { runCoderPhase, runReviewerPhase } from '../commands/loop-phases.js';
import { handleCreditExhaustion, checkBatchCreditExhaustion } from './credit-pause.js';
import { pushToRemote } from '../git/push.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSectionIds(sectionId?: string, sectionIds?: string[]): string[] | undefined {
  if (sectionIds && sectionIds.length > 0) {
    return sectionIds;
  }
  return sectionId ? [sectionId] : undefined;
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

      // Batch mode: process multiple pending tasks at once
      // Only active when not focusing on a specific section and batch mode is enabled
      if (batchMode && !activeSectionIds) {
        const batch = selectTaskBatch(db, maxBatchSize);
        if (batch && batch.tasks.length > 0) {
          console.log(`[BATCH MODE] Section "${batch.sectionName}" - ${batch.tasks.length} tasks`);

          // Mark all tasks as in_progress
          for (const task of batch.tasks) {
            markTaskInProgress(db, task.id);
            options.onTaskStart?.(task.id, 'batch');
          }

          // Invoke batch coder
          console.log('\n>>> Invoking BATCH CODER...\n');
          const batchCoderResult = await invokeCoderBatch(batch.tasks, batch.sectionName, projectPath);

          // Check for credit exhaustion in batch coder result
          const batchCoderCredit = checkBatchCreditExhaustion(batchCoderResult, 'coder', projectPath);
          if (batchCoderCredit) {
            const pauseResult = await handleCreditExhaustion({
              provider: batchCoderCredit.provider,
              model: batchCoderCredit.model,
              role: batchCoderCredit.role,
              message: batchCoderCredit.message,
              runnerId: options.runnerId ?? '',
              projectPath,
              db,
              shouldStop: shouldStop ?? (() => false),
              onHeartbeat: options.onHeartbeat,
              onceMode: once,
            });
            if (!pauseResult.resolved) break;
            continue; // Retry iteration after config change
          }

          // Check which tasks are now in review status
          const tasksInReview = batch.tasks
            .map(t => getTask(db, t.id))
            .filter((t): t is NonNullable<typeof t> => t !== null && t.status === 'review');

          if (tasksInReview.length > 0) {
            console.log(`\n[BATCH MODE] ${tasksInReview.length} tasks ready for batch review\n`);

            // Invoke batch reviewer
            console.log('\n>>> Invoking BATCH REVIEWER...\n');
            const batchReviewerResult = await invokeReviewerBatch(tasksInReview, batch.sectionName, projectPath);

            // Check for credit exhaustion in batch reviewer result
            const batchReviewerCredit = checkBatchCreditExhaustion(batchReviewerResult, 'reviewer', projectPath);
            if (batchReviewerCredit) {
              const pauseResult = await handleCreditExhaustion({
                provider: batchReviewerCredit.provider,
                model: batchReviewerCredit.model,
                role: batchReviewerCredit.role,
                message: batchReviewerCredit.message,
                runnerId: options.runnerId ?? '',
                projectPath,
                db,
                shouldStop: shouldStop ?? (() => false),
                onHeartbeat: options.onHeartbeat,
                onceMode: once,
              });
              if (!pauseResult.resolved) break;
              continue; // Retry iteration after config change
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

      // Select next task
      const selected = selectNextTask(db, activeSectionIds);

      if (!selected) {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                      ALL TASKS COMPLETE                       ║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
        break;
      }

      const { task, action } = selected;

      console.log(`Task: ${task.title}`);
      console.log(`Action: ${action}`);
      console.log(`Status: ${task.status}`);

      options.onTaskStart?.(task.id, action);

      let phaseResult;
      if (action === 'start') {
        markTaskInProgress(db, task.id);
        phaseResult = await runCoderPhase(db, task, projectPath, 'start', false);
      } else if (action === 'resume') {
        phaseResult = await runCoderPhase(db, task, projectPath, 'resume', false);
      } else if (action === 'review') {
        phaseResult = await runReviewerPhase(db, task, projectPath, false, undefined, branchName);
      }

      // Check for credit exhaustion from single-task phase
      if (phaseResult?.action === 'pause_credit_exhaustion') {
        const pauseResult = await handleCreditExhaustion({
          provider: phaseResult.provider,
          model: phaseResult.model,
          role: phaseResult.role,
          message: phaseResult.message,
          runnerId: options.runnerId ?? '',
          projectPath,
          db,
          shouldStop: shouldStop ?? (() => false),
          onHeartbeat: options.onHeartbeat,
          onceMode: once,
        });
        if (!pauseResult.resolved) break;
        continue; // Retry iteration after config change
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

// Note: runCoderPhase and runReviewerPhase are now imported from ../commands/loop-phases.js
// They implement the orchestrator-driven architecture where the orchestrator makes all status decisions
