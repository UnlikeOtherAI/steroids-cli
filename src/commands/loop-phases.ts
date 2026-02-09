/**
 * Loop phase functions for coder and reviewer invocation
 * Extracted from loop.ts to keep files under 500 lines
 */

import {
  getTask,
  updateTaskStatus,
  approveTask,
  rejectTask,
  getTaskRejections,
  getLatestSubmissionNotes,
  listTasks,
  addAuditEntry,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { invokeCoder } from '../orchestrator/coder.js';
import { invokeReviewer } from '../orchestrator/reviewer.js';
import { invokeCoordinator, type CoordinatorContext, type CoordinatorResult } from '../orchestrator/coordinator.js';
import { pushToRemote } from '../git/push.js';
import { getCurrentCommitSha, getModifiedFiles } from '../git/status.js';

export { type CoordinatorResult };

export async function runCoderPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  action: 'start' | 'resume',
  jsonMode = false,
  coordinatorCache?: Map<string, CoordinatorResult>,
  coordinatorThresholds?: number[]
): Promise<void> {
  if (!task) return;

  let coordinatorGuidance: string | undefined;
  const thresholds = coordinatorThresholds || [2, 5, 9];

  // Check if we should run the coordinator at this rejection count
  // Only runs at specific thresholds to avoid redundant/costly LLM calls
  // But always reuse cached results between thresholds
  const shouldInvokeCoordinator = thresholds.includes(task.rejection_count);
  const cachedResult = coordinatorCache?.get(task.id);

  if (shouldInvokeCoordinator) {
    if (!jsonMode) {
      console.log(`\n>>> Task has ${task.rejection_count} rejections (threshold hit) - invoking COORDINATOR...\n`);
    }

    try {
      const rejectionHistory = getTaskRejections(db, task.id);
      const coordExtra: CoordinatorContext = {};

      // Section tasks - so coordinator knows what other tasks handle
      if (task.section_id) {
        const allSectionTasks = listTasks(db, { sectionId: task.section_id });
        coordExtra.sectionTasks = allSectionTasks.map(t => ({
          id: t.id, title: t.title, status: t.status,
        }));
      }

      // Coder's latest submission notes
      coordExtra.submissionNotes = getLatestSubmissionNotes(db, task.id);

      // What files were modified (lightweight diff summary)
      const modified = getModifiedFiles(projectPath);
      if (modified.length > 0) {
        coordExtra.gitDiffSummary = modified.join('\n');
      }

      // Include previous coordinator guidance so it doesn't repeat itself
      if (cachedResult) {
        coordExtra.previousGuidance = cachedResult.guidance;
      }

      const coordResult = await invokeCoordinator(task, rejectionHistory, projectPath, coordExtra);

      if (coordResult) {
        coordinatorGuidance = coordResult.guidance;
        // Store in cache for both coder reuse and reviewer phase
        coordinatorCache?.set(task.id, coordResult);

        // Log coordinator intervention to audit trail so it's visible in WebUI
        addAuditEntry(db, task.id, task.status, task.status, 'coordinator', {
          actorType: 'orchestrator',
          notes: `[${coordResult.decision}] ${coordResult.guidance}`,
        });

        if (!jsonMode) {
          console.log(`\nCoordinator decision: ${coordResult.decision}`);
          console.log('Coordinator guidance stored for both coder and reviewer.');
        }
      }
    } catch (error) {
      // Coordinator failure is non-fatal - continue without guidance
      if (!jsonMode) {
        console.warn('Coordinator invocation failed, continuing without guidance:', error);
      }
    }
  } else if (cachedResult) {
    // Reuse cached coordinator guidance between thresholds
    coordinatorGuidance = cachedResult.guidance;
    if (!jsonMode && task.rejection_count >= 2) {
      console.log(`\nReusing cached coordinator guidance (decision: ${cachedResult.decision})`);
    }
  }

  if (!jsonMode) {
    console.log('\n>>> Invoking CODER...\n');
  }

  const result = await invokeCoder(task, projectPath, action, coordinatorGuidance);

  if (result.timedOut) {
    console.warn('Coder timed out. Will retry next iteration.');
    return;
  }

  // Re-read task to see if status was updated
  const updatedTask = getTask(db, task.id);
  if (!updatedTask) return;

  // AUTO-SUBMIT: If coder finished but didn't update status, automatically move to review
  // This prevents infinite loops where coder completes work but forgets to run status update command
  if (updatedTask.status === 'in_progress') {
    const commitSha = getCurrentCommitSha(projectPath) ?? undefined;
    updateTaskStatus(db, updatedTask.id, 'review', 'orchestrator',
      'Auto-submitted to review (coder finished without status update)', commitSha);

    if (!jsonMode) {
      console.log('\nCoder finished without updating status. Auto-submitted to review.');
    }
  } else if (!jsonMode) {
    if (updatedTask.status === 'review') {
      console.log('\nCoder submitted for review. Ready for reviewer.');
    } else {
      console.log(`Task status: ${updatedTask.status}`);
    }
  }
}

export async function runReviewerPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  jsonMode = false,
  coordinatorResult?: CoordinatorResult
): Promise<void> {
  if (!task) return;

  if (!jsonMode) {
    console.log('\n>>> Invoking REVIEWER...\n');
    if (coordinatorResult) {
      console.log(`Coordinator guidance included (decision: ${coordinatorResult.decision})`);
    }
  }

  const result = await invokeReviewer(
    task,
    projectPath,
    coordinatorResult?.guidance,
    coordinatorResult?.decision
  );

  if (result.timedOut) {
    if (!jsonMode) {
      console.warn('Reviewer timed out. Will retry next iteration.');
    }
    return;
  }

  // Re-read task to see what the reviewer decided
  // (Codex runs steroids commands directly to update the database)
  const updatedTask = getTask(db, task.id);
  if (!updatedTask) return;

  if (updatedTask.status === 'completed') {
    handleApproved(projectPath, jsonMode);
  } else if (updatedTask.status === 'in_progress') {
    if (!jsonMode) {
      console.log(`\n✗ Task REJECTED (${updatedTask.rejection_count}/15)`);
      console.log('Returning to coder for fixes.');
    }
  } else if (updatedTask.status === 'disputed') {
    handleDisputed(projectPath, jsonMode);
  } else if (updatedTask.status === 'failed') {
    if (!jsonMode) {
      console.log('\n✗ Task FAILED (exceeded 15 rejections)');
      console.log('Human intervention required.');
    }
  } else if (updatedTask.status === 'review') {
    handleReviewFallback(db, task.id, result, projectPath, jsonMode);
  }
}

function handleApproved(projectPath: string, jsonMode: boolean): void {
  if (!jsonMode) {
    console.log('\n✓ Task APPROVED');
    console.log('Pushing to git...');
  }

  const pushResult = pushToRemote(projectPath);

  if (!jsonMode) {
    if (pushResult.success) {
      console.log(`Pushed successfully (${pushResult.commitHash})`);
    } else {
      console.warn('Push failed. Will stack and retry on next completion.');
    }
  }
}

function handleDisputed(projectPath: string, jsonMode: boolean): void {
  if (!jsonMode) {
    console.log('\n! Task DISPUTED');
    console.log('Pushing current work and moving to next task.');
  }

  const pushResult = pushToRemote(projectPath);
  if (!jsonMode && pushResult.success) {
    console.log(`Pushed disputed work (${pushResult.commitHash})`);
  }
}

function handleReviewFallback(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  result: { decision?: string; notes?: string },
  projectPath: string,
  jsonMode: boolean
): void {
  if (!result.decision) {
    if (!jsonMode) {
      console.log('\nReviewer did not take action (status unchanged). Will retry.');
    }
    return;
  }

  if (!jsonMode) {
    console.log(`\nReviewer indicated ${result.decision.toUpperCase()} but command may have failed.`);
    console.log('Attempting fallback...');
  }

  const commitSha = getCurrentCommitSha(projectPath) ?? undefined;

  if (result.decision === 'approve') {
    approveTask(db, taskId, 'codex', result.notes, commitSha);
    if (!jsonMode) {
      console.log('✓ Task APPROVED (via fallback)');
    }
    const pushResult = pushToRemote(projectPath);
    if (!jsonMode && pushResult.success) {
      console.log(`Pushed successfully (${pushResult.commitHash})`);
    }
  } else if (result.decision === 'reject') {
    rejectTask(db, taskId, 'codex', result.notes, commitSha);
    if (!jsonMode) {
      console.log('✗ Task REJECTED (via fallback)');
    }
  } else if (result.decision === 'dispute') {
    updateTaskStatus(db, taskId, 'disputed', 'codex', result.notes, commitSha);
    if (!jsonMode) {
      console.log('! Task DISPUTED (via fallback)');
    }
  }
}
