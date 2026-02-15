/**
 * Loop phase functions for coder and reviewer invocation
 * ORCHESTRATOR-DRIVEN: The orchestrator makes ALL status decisions
 */

import { execSync } from 'node:child_process';
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
import { invokeCoder, type CoderResult } from '../orchestrator/coder.js';
import { invokeReviewer, type ReviewerResult } from '../orchestrator/reviewer.js';
import { invokeCoordinator, type CoordinatorContext, type CoordinatorResult } from '../orchestrator/coordinator.js';
import { pushToRemote } from '../git/push.js';
import {
  getCurrentCommitSha,
  getModifiedFiles,
  getRecentCommits,
  getChangedFiles,
  hasUncommittedChanges,
  getDiffSummary,
  getDiffStats,
} from '../git/status.js';
import { invokeCoderOrchestrator, invokeReviewerOrchestrator } from '../orchestrator/invoke.js';
import { OrchestrationFallbackHandler } from '../orchestrator/fallback-handler.js';
import type { CoderContext, ReviewerContext } from '../orchestrator/types.js';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { InvokeResult } from '../providers/interface.js';

export { type CoordinatorResult };

/**
 * Returned when a provider invocation is classified as credit exhaustion.
 * The main loop should pause and wait for a config change instead of retrying.
 */
export interface CreditExhaustionResult {
  action: 'pause_credit_exhaustion';
  provider: string;
  model: string;
  role: 'coder' | 'reviewer';
  message: string;
}

/**
 * Check a coder/reviewer result for credit exhaustion using the provider's classifier.
 * Uses provider.classifyResult() which checks both stderr and stdout.
 * Returns a CreditExhaustionResult if credits are exhausted, null otherwise.
 */
function checkCreditExhaustion(
  result: InvokeResult,
  role: 'coder' | 'reviewer',
  projectPath: string
): CreditExhaustionResult | null {
  if (result.success) return null;

  const config = loadConfig(projectPath);
  const roleConfig = config.ai?.[role];
  const providerName = roleConfig?.provider;
  const modelName = roleConfig?.model;

  if (!providerName || !modelName) return null;

  const registry = getProviderRegistry();
  const provider = registry.tryGet(providerName);
  if (!provider) return null;

  const classification = provider.classifyResult(result);
  if (classification?.type === 'credit_exhaustion') {
    return {
      action: 'pause_credit_exhaustion',
      provider: providerName,
      model: modelName,
      role,
      message: classification.message,
    };
  }

  return null;
}

export async function runCoderPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  action: 'start' | 'resume',
  jsonMode = false,
  coordinatorCache?: Map<string, CoordinatorResult>,
  coordinatorThresholds?: number[]
): Promise<CreditExhaustionResult | void> {
  if (!task) return;

  let coordinatorGuidance: string | undefined;
  const thresholds = coordinatorThresholds || [2, 5, 9];

  // Run coordinator at rejection thresholds (same as before)
  const shouldInvokeCoordinator = thresholds.includes(task.rejection_count);
  const cachedResult = coordinatorCache?.get(task.id);

  if (shouldInvokeCoordinator) {
    if (!jsonMode) {
      console.log(`\n>>> Task has ${task.rejection_count} rejections (threshold hit) - invoking COORDINATOR...\n`);
    }

    try {
      const rejectionHistory = getTaskRejections(db, task.id);
      const coordExtra: CoordinatorContext = {};

      if (task.section_id) {
        const allSectionTasks = listTasks(db, { sectionId: task.section_id });
        coordExtra.sectionTasks = allSectionTasks.map(t => ({
          id: t.id, title: t.title, status: t.status,
        }));
      }

      coordExtra.submissionNotes = getLatestSubmissionNotes(db, task.id);

      const modified = getModifiedFiles(projectPath);
      if (modified.length > 0) {
        coordExtra.gitDiffSummary = modified.join('\n');
      }

      if (cachedResult) {
        coordExtra.previousGuidance = cachedResult.guidance;
      }

      const coordResult = await invokeCoordinator(task, rejectionHistory, projectPath, coordExtra);

      if (coordResult) {
        coordinatorGuidance = coordResult.guidance;
        coordinatorCache?.set(task.id, coordResult);

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
      if (!jsonMode) {
        console.warn('Coordinator invocation failed, continuing without guidance:', error);
      }
    }
  } else if (cachedResult) {
    coordinatorGuidance = cachedResult.guidance;
    if (!jsonMode && task.rejection_count >= 2) {
      console.log(`\nReusing cached coordinator guidance (decision: ${cachedResult.decision})`);
    }
  }

  // STEP 1: Invoke coder (no status commands in prompt anymore)
  if (!jsonMode) {
    console.log('\n>>> Invoking CODER...\n');
  }

  const coderResult: CoderResult = await invokeCoder(task, projectPath, action, coordinatorGuidance);

  if (coderResult.timedOut) {
    console.warn('Coder timed out. Will retry next iteration.');
    return;
  }

  // Check for credit exhaustion before proceeding to orchestrator
  const creditCheck = checkCreditExhaustion(coderResult, 'coder', projectPath);
  if (creditCheck) {
    return creditCheck;
  }

  // STEP 2: Gather git state
  const commits = getRecentCommits(projectPath, 5);
  const files_changed = getChangedFiles(projectPath);
  const has_uncommitted = hasUncommittedChanges(projectPath);
  const diff_summary = getDiffSummary(projectPath);

  const gitState = {
    commits,
    files_changed,
    has_uncommitted_changes: has_uncommitted,
    diff_summary,
  };

  // STEP 3: Build orchestrator context
  // Get rejection notes if any
  const lastRejectionNotes = task.rejection_count > 0
    ? getTaskRejections(db, task.id).slice(-1)[0]?.notes ?? undefined
    : undefined;

  const context: CoderContext = {
    task: {
      id: task.id,
      title: task.title,
      description: task.title, // Use title as description for now
      rejection_notes: lastRejectionNotes,
      rejection_count: task.rejection_count,
    },
    coder_output: {
      stdout: coderResult.stdout,
      stderr: coderResult.stderr,
      exit_code: coderResult.exitCode,
      timed_out: coderResult.timedOut,
      duration_ms: coderResult.duration,
    },
    git_state: gitState,
  };

  // STEP 4: Invoke orchestrator
  let orchestratorOutput: string;
  try {
    orchestratorOutput = await invokeCoderOrchestrator(context, projectPath);
  } catch (error) {
    console.error('Orchestrator invocation failed:', error);
    // Fallback to safe default: retry
    orchestratorOutput = JSON.stringify({
      action: 'retry',
      reasoning: 'Orchestrator failed, defaulting to retry',
      commits: [],
      next_status: 'in_progress',
      metadata: {
        files_changed: 0,
        confidence: 'low',
        exit_clean: true,
        has_commits: false,
      }
    });
  }

  // STEP 5: Parse orchestrator output with fallback
  const handler = new OrchestrationFallbackHandler();
  const decision = handler.parseCoderOutput(orchestratorOutput);

  // STEP 6: Log orchestrator decision for audit trail
  addAuditEntry(db, task.id, task.status, decision.next_status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[${decision.action}] ${decision.reasoning} (confidence: ${decision.metadata.confidence})`,
  });

  // STEP 7: Execute the decision
  switch (decision.action) {
    case 'submit':
      updateTaskStatus(db, task.id, 'review', 'orchestrator', decision.reasoning);
      if (!jsonMode) {
        console.log(`\n✓ Coder complete, submitted to review (confidence: ${decision.metadata.confidence})`);
      }
      break;

    case 'stage_commit_submit':
      // Stage all changes
      try {
        execSync('git add -A', { cwd: projectPath, stdio: 'pipe' });
        const message = decision.commit_message || 'feat: implement task specification';
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
          cwd: projectPath,
          stdio: 'pipe'
        });
        updateTaskStatus(db, task.id, 'review', 'orchestrator',
          `Auto-committed and submitted (${decision.reasoning})`);
        if (!jsonMode) {
          console.log(`\n✓ Auto-committed and submitted to review (confidence: ${decision.metadata.confidence})`);
        }
      } catch (error) {
        console.error('Failed to stage/commit:', error);
        // Fallback to retry
        if (!jsonMode) {
          console.log('\n⟳ Failed to commit, will retry');
        }
      }
      break;

    case 'retry':
      if (!jsonMode) {
        console.log(`\n⟳ Retrying coder (${decision.reasoning}, confidence: ${decision.metadata.confidence})`);
      }
      break;

    case 'error':
      updateTaskStatus(db, task.id, 'failed', 'orchestrator',
        `Task failed: ${decision.reasoning}`);
      if (!jsonMode) {
        console.log(`\n✗ Task failed (${decision.reasoning})`);
        console.log('Human intervention required.');
      }
      break;
  }
}

export async function runReviewerPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  jsonMode = false,
  coordinatorResult?: CoordinatorResult,
  branchName: string = 'main'
): Promise<CreditExhaustionResult | void> {
  if (!task) return;

  // STEP 1: Invoke reviewer (no status commands in prompt anymore)
  if (!jsonMode) {
    console.log('\n>>> Invoking REVIEWER...\n');
    if (coordinatorResult) {
      console.log(`Coordinator guidance included (decision: ${coordinatorResult.decision})`);
    }
  }

  const reviewerResult: ReviewerResult = await invokeReviewer(
    task,
    projectPath,
    coordinatorResult?.guidance,
    coordinatorResult?.decision
  );

  if (reviewerResult.timedOut) {
    if (!jsonMode) {
      console.warn('Reviewer timed out. Will retry next iteration.');
    }
    return;
  }

  // Check for credit exhaustion before proceeding to orchestrator
  const creditCheck = checkCreditExhaustion(reviewerResult, 'reviewer', projectPath);
  if (creditCheck) {
    return creditCheck;
  }

  // STEP 2: Gather git context
  const commit_sha = getCurrentCommitSha(projectPath) || '';
  const files_changed = getModifiedFiles(projectPath);
  const diffStats = getDiffStats(projectPath);

  const gitContext = {
    commit_sha,
    files_changed,
    additions: diffStats.additions,
    deletions: diffStats.deletions,
  };

  // STEP 3: Build orchestrator context
  const context: ReviewerContext = {
    task: {
      id: task.id,
      title: task.title,
      rejection_count: task.rejection_count,
    },
    reviewer_output: {
      stdout: reviewerResult.stdout,
      stderr: reviewerResult.stderr,
      exit_code: reviewerResult.exitCode,
      timed_out: reviewerResult.timedOut,
      duration_ms: reviewerResult.duration,
    },
    git_context: gitContext,
  };

  // STEP 4: Invoke orchestrator
  let orchestratorOutput: string;
  try {
    orchestratorOutput = await invokeReviewerOrchestrator(context, projectPath);
  } catch (error) {
    console.error('Orchestrator invocation failed:', error);
    // Fallback to safe default: unclear
    orchestratorOutput = JSON.stringify({
      decision: 'unclear',
      reasoning: 'Orchestrator failed, retrying review',
      notes: 'Review unclear, retrying',
      next_status: 'review',
      metadata: {
        rejection_count: task.rejection_count,
        confidence: 'low',
        push_to_remote: false,
        repeated_issue: false,
      }
    });
  }

  // STEP 5: Parse orchestrator output with fallback
  const handler = new OrchestrationFallbackHandler();
  const decision = handler.parseReviewerOutput(orchestratorOutput);

  // STEP 6: Log orchestrator decision for audit trail
  addAuditEntry(db, task.id, task.status, decision.next_status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[${decision.decision}] ${decision.reasoning} (confidence: ${decision.metadata.confidence})`,
  });

  // STEP 7: Execute the decision
  const commitSha = commit_sha || undefined;

  switch (decision.decision) {
    case 'approve':
      approveTask(db, task.id, 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n✓ Task APPROVED (confidence: ${decision.metadata.confidence})`);
        console.log('Pushing to git...');
      }
      const pushResult = pushToRemote(projectPath, 'origin', branchName);
      if (!jsonMode && pushResult.success) {
        console.log(`Pushed successfully (${pushResult.commitHash})`);
      } else if (!jsonMode) {
        console.warn('Push failed. Will stack and retry on next completion.');
      }
      break;

    case 'reject':
      rejectTask(db, task.id, 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n✗ Task REJECTED (${task.rejection_count + 1}/15, confidence: ${decision.metadata.confidence})`);
        console.log('Returning to coder for fixes.');
      }
      break;

    case 'dispute':
      updateTaskStatus(db, task.id, 'disputed', 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n! Task DISPUTED (confidence: ${decision.metadata.confidence})`);
        console.log('Pushing current work and moving to next task.');
      }
      const disputePush = pushToRemote(projectPath, 'origin', branchName);
      if (!jsonMode && disputePush.success) {
        console.log(`Pushed disputed work (${disputePush.commitHash})`);
      }
      break;

    case 'skip':
      updateTaskStatus(db, task.id, 'skipped', 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n⏭ Task SKIPPED (confidence: ${decision.metadata.confidence})`);
      }
      break;

    case 'unclear':
      if (!jsonMode) {
        console.log(`\n? Review unclear (${decision.reasoning}), will retry`);
      }
      break;
  }
}
