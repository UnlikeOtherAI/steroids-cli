/**
 * steroids loop - Main orchestrator loop
 * Runs continuously until all tasks are done
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import { getTask, updateTaskStatus, approveTask, rejectTask } from '../database/queries.js';
import {
  selectNextTask,
  markTaskInProgress,
  areAllTasksComplete,
  getTaskCounts,
} from '../orchestrator/task-selector.js';
import { invokeCoder } from '../orchestrator/coder.js';
import { invokeReviewer } from '../orchestrator/reviewer.js';
import { pushToRemote } from '../git/push.js';
import { getCurrentCommitSha } from '../git/status.js';

const HELP = `
steroids loop - Run the orchestrator loop

USAGE:
  steroids loop [options]

OPTIONS:
  --once              Run one iteration only (don't loop)
  --dry-run           Show what would be done without doing it
  -h, --help          Show help

DESCRIPTION:
  The loop continuously:
  1. Finds the next task to work on
  2. Invokes the coder (Claude) or reviewer (Codex)
  3. Pushes to git on completion
  4. Continues until all tasks are done

  The coder is responsible for running build/test commands.

  Task priority:
  - review > in_progress > pending
  - Within priority: by section position, then creation time

EXAMPLES:
  steroids loop                  # Run until all tasks done
  steroids loop --once           # Run one task only
  steroids loop --dry-run        # Preview without executing
`;

export async function loopCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      once: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const projectPath = process.cwd();

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    STEROIDS ORCHESTRATOR                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const { db, close } = openDatabase();

  try {
    // Show initial status
    const counts = getTaskCounts(db);
    console.log('Task Status:');
    console.log(`  Pending:     ${counts.pending}`);
    console.log(`  In Progress: ${counts.in_progress}`);
    console.log(`  Review:      ${counts.review}`);
    console.log(`  Completed:   ${counts.completed}`);
    console.log(`  Disputed:    ${counts.disputed}`);
    console.log(`  Failed:      ${counts.failed}`);
    console.log(`  ─────────────────`);
    console.log(`  Total:       ${counts.total}`);
    console.log('');

    if (values['dry-run']) {
      const next = selectNextTask(db);
      if (next) {
        console.log(`[DRY RUN] Would process: ${next.task.title}`);
        console.log(`  Action: ${next.action}`);
        console.log(`  Task ID: ${next.task.id}`);
      } else {
        console.log('[DRY RUN] No tasks to process');
      }
      return;
    }

    let iteration = 0;

    // Main loop
    while (true) {
      iteration++;
      console.log(`\n─── Iteration ${iteration} ───\n`);

      // Select next task
      const selected = selectNextTask(db);

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

      if (action === 'start') {
        // Starting a new task
        markTaskInProgress(db, task.id);
        await runCoderPhase(db, task, projectPath, 'start');
      } else if (action === 'resume') {
        // Resuming in-progress task
        await runCoderPhase(db, task, projectPath, 'resume');
      } else if (action === 'review') {
        // Task ready for review
        await runReviewerPhase(db, task, projectPath);
      }

      // Check if we should continue
      if (values.once) {
        console.log('\n[--once] Stopping after one iteration');
        break;
      }

      // Brief pause between iterations to avoid overwhelming the system
      await sleep(1000);
    }

    // Final status
    const finalCounts = getTaskCounts(db);
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
  task: ReturnType<typeof getTask>,
  projectPath: string,
  action: 'start' | 'resume'
): Promise<void> {
  if (!task) return;

  console.log('\n>>> Invoking CODER...\n');

  const result = await invokeCoder(task, projectPath, action);

  if (result.timedOut) {
    console.warn('Coder timed out. Will retry next iteration.');
    return;
  }

  // Re-read task to see if status was updated
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
  task: ReturnType<typeof getTask>,
  projectPath: string
): Promise<void> {
  if (!task) return;

  console.log('\n>>> Invoking REVIEWER...\n');

  const result = await invokeReviewer(task, projectPath);

  if (result.timedOut) {
    console.warn('Reviewer timed out. Will retry next iteration.');
    return;
  }

  // Get current commit SHA for audit trail
  const commitSha = getCurrentCommitSha(projectPath) ?? undefined;

  // Handle the decision from the reviewer output
  // (Codex can't write to database, so we execute the decision here)
  if (result.decision === 'approve') {
    console.log('\n>>> Reviewer decision: APPROVE');
    approveTask(db, task.id, 'codex', result.notes, commitSha);

    console.log('\n✓ Task APPROVED');
    if (commitSha) {
      console.log(`Commit: ${commitSha.substring(0, 7)}`);
    }

    // Push to git
    console.log('Pushing to git...');
    const pushResult = pushToRemote(projectPath);

    if (pushResult.success) {
      console.log(`Pushed successfully (${pushResult.commitHash})`);
    } else {
      console.warn('Push failed. Will stack and retry on next completion.');
    }
  } else if (result.decision === 'reject') {
    console.log('\n>>> Reviewer decision: REJECT');
    const rejectResult = rejectTask(db, task.id, 'codex', result.notes, commitSha);

    if (rejectResult.status === 'failed') {
      console.log('\n✗ Task FAILED (exceeded 15 rejections)');
      console.log('Human intervention required.');
    } else {
      console.log(`\n✗ Task REJECTED (${rejectResult.rejectionCount}/15)`);
      if (commitSha) {
        console.log(`Commit: ${commitSha.substring(0, 7)}`);
      }
      if (result.notes) {
        console.log(`Notes: ${result.notes}`);
      }
      console.log('Returning to coder for fixes.');
    }
  } else if (result.decision === 'dispute') {
    console.log('\n>>> Reviewer decision: DISPUTE');
    updateTaskStatus(db, task.id, 'disputed', 'codex', result.notes, commitSha);

    console.log('\n! Task DISPUTED');
    if (result.notes) {
      console.log(`Reason: ${result.notes}`);
    }
    console.log('Pushing current work and moving to next task.');

    // Push even for disputed tasks
    const pushResult = pushToRemote(projectPath);
    if (pushResult.success) {
      console.log(`Pushed disputed work (${pushResult.commitHash})`);
    }
  } else {
    // No clear decision parsed from output
    console.log('\nReviewer did not provide a clear decision. Will retry.');
    console.log('Expected APPROVE, REJECT, or DISPUTE in output.');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
