/**
 * Orchestrator loop - core task processing logic
 * Used by both the daemon and the loop command
 */

import { openDatabase } from '../database/connection.js';
import { getTask, getSection } from '../database/queries.js';
import {
  selectNextTask,
  markTaskInProgress,
  getTaskCounts,
} from '../orchestrator/task-selector.js';
import { invokeCoder } from '../orchestrator/coder.js';
import { invokeReviewer } from '../orchestrator/reviewer.js';
import { logActivity } from './activity-log.js';
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

  try {
    let iteration = 0;

    while (true) {
      // Check if we should stop
      if (shouldStop?.()) {
        console.log('\nLoop stopped by signal');
        break;
      }

      iteration++;
      console.log(`\n─── Iteration ${iteration} ───\n`);
      options.onIteration?.(iteration);

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

  if (result.decision === 'approve') {
    console.log('\n✓ Task APPROVED');
    // Push changes
    try {
      console.log('Pushing to git...');
      execSync('git push', { cwd: projectPath, stdio: 'inherit' });
      const commitSha = execSync('git rev-parse HEAD', {
        cwd: projectPath,
        encoding: 'utf-8',
      }).trim();
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
        'completed'
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
