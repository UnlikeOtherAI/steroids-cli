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
import { invokeCoder, invokeCoderBatch } from '../orchestrator/coder.js';
import { loadConfig } from '../config/loader.js';
import { invokeReviewer, invokeReviewerBatch } from '../orchestrator/reviewer.js';
import { listTasks } from '../database/queries.js';
import { logActivity } from './activity-log.js';
import { getRegisteredProject } from './projects.js';
import { execSync } from 'node:child_process';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LoopOptions {
  projectPath: string;
  once?: boolean;
  sectionId?: string;  // Focus on this section only
  runnerId?: string;   // For activity logging
  onIteration?: (iteration: number) => void;
  onTaskStart?: (taskId: string, action: string) => void;
  onTaskComplete?: (taskId: string) => void;
  shouldStop?: () => boolean;
}

/**
 * Run the orchestrator loop
 * Processes tasks until all are complete or shouldStop returns true
 */
export async function runOrchestratorLoop(options: LoopOptions): Promise<void> {
  const { projectPath, once = false, shouldStop, sectionId } = options;

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
      if (batchMode && !sectionId) {
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
          await invokeCoderBatch(batch.tasks, batch.sectionName, projectPath);

          // Check which tasks are now in review status
          const tasksInReview = batch.tasks
            .map(t => getTask(db, t.id))
            .filter((t): t is NonNullable<typeof t> => t !== null && t.status === 'review');

          if (tasksInReview.length > 0) {
            console.log(`\n[BATCH MODE] ${tasksInReview.length} tasks ready for batch review\n`);

            // Invoke batch reviewer
            console.log('\n>>> Invoking BATCH REVIEWER...\n');
            await invokeReviewerBatch(tasksInReview, batch.sectionName, projectPath);

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
              try {
                console.log('Pushing batch changes to git...');
                execSync('git push', { cwd: projectPath, stdio: 'inherit' });
                console.log(`Pushed ${approvedTasks.length} approved task(s)`);
              } catch (error) {
                console.warn('Failed to push:', error);
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
      const selected = selectNextTask(db, sectionId);

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

      if (action === 'start') {
        markTaskInProgress(db, task.id);
        await runCoderPhase(db, task, projectPath, 'start');
      } else if (action === 'resume') {
        await runCoderPhase(db, task, projectPath, 'resume');
      } else if (action === 'review') {
        await runReviewerPhase(db, task, projectPath, options.runnerId);
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
    const finalCounts = getTaskCounts(db, sectionId);
    console.log('\nFinal Status:');
    console.log(`  Completed: ${finalCounts.completed}`);
    console.log(`  Failed:    ${finalCounts.failed}`);
    console.log(`  Disputed:  ${finalCounts.disputed}`);
  } finally {
    close();
  }
}

async function runCoderPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: NonNullable<ReturnType<typeof getTask>>,
  projectPath: string,
  action: 'start' | 'resume'
): Promise<void> {
  console.log('\n>>> Invoking CODER...\n');

  const result = await invokeCoder(task, projectPath, action);

  if (result.timedOut) {
    console.warn('Coder timed out. Will retry next iteration.');
    return;
  }

  const updatedTask = getTask(db, task.id);
  if (!updatedTask) return;

  if (updatedTask.status === 'review') {
    console.log('\nCoder submitted for review. Ready for reviewer.');
  } else {
    console.log(`Task status unchanged (${updatedTask.status}). Will retry next iteration.`);
  }
}

async function runReviewerPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: NonNullable<ReturnType<typeof getTask>>,
  projectPath: string,
  runnerId?: string
): Promise<void> {
  console.log('\n>>> Invoking REVIEWER...\n');

  const result = await invokeReviewer(task, projectPath);

  if (result.timedOut) {
    console.warn('Reviewer timed out. Will retry next iteration.');
    return;
  }

  const updatedTask = getTask(db, task.id);
  if (!updatedTask) return;

  // Get section name for activity logging
  const section = task.section_id ? getSection(db, task.section_id) : null;
  const sectionName = section?.name ?? null;

  // Check actual task status in database - don't trust parsed decision alone
  // The reviewer might say "APPROVE" but the command could fail
  if (updatedTask.status === 'completed') {
    console.log('\n✓ Task APPROVED');

    // Get the commit message and SHA before pushing
    let commitMessage: string | null = null;
    let commitSha: string | null = null;
    try {
      commitMessage = execSync('git log -1 --format=%B', {
        cwd: projectPath,
        encoding: 'utf-8',
      }).trim();
      commitSha = execSync('git rev-parse HEAD', {
        cwd: projectPath,
        encoding: 'utf-8',
      }).trim();
    } catch (error) {
      console.warn('Failed to get commit info:', error);
    }

    // Push changes
    try {
      console.log('Pushing to git...');
      execSync('git push', { cwd: projectPath, stdio: 'inherit' });
      console.log(`Pushed successfully (${commitSha})`);
    } catch (error) {
      console.warn('Failed to push:', error);
    }

    // Log activity for completed task
    if (runnerId) {
      logActivity(
        projectPath,
        runnerId,
        task.id,
        task.title,
        sectionName,
        'completed',
        commitMessage,
        commitSha
      );
    }
  } else if (updatedTask.status === 'skipped') {
    console.log('\n⊘ Task SKIPPED');

    // Log activity for skipped task
    if (runnerId) {
      logActivity(
        projectPath,
        runnerId,
        task.id,
        task.title,
        sectionName,
        'skipped'
      );
    }
  } else if (result.decision === 'reject') {
    console.log('\n✗ Task REJECTED');
    console.log(`Rejection count: ${updatedTask.rejection_count}/15`);
    if (result.notes) {
      console.log(`Notes: ${result.notes}`);
    }

    // Check if task failed (exceeded 15 rejections)
    if (updatedTask.status === 'failed' && runnerId) {
      logActivity(
        projectPath,
        runnerId,
        task.id,
        task.title,
        sectionName,
        'failed'
      );
    } else {
      console.log('Returning to coder for fixes.');
    }
  } else if (result.decision === 'dispute') {
    console.log('\n! Task DISPUTED');
    if (result.notes) {
      console.log(`Reason: ${result.notes}`);
    }

    // Log activity for disputed task
    if (runnerId) {
      logActivity(
        projectPath,
        runnerId,
        task.id,
        task.title,
        sectionName,
        'disputed'
      );
    }
  } else {
    console.log(`\nReviewer completed without clear decision. Status: ${updatedTask.status}`);
  }
}
