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
  getTaskAudit,
  getLatestSubmissionNotes,
  listTasks,
  addAuditEntry,
  getFollowUpDepth,
  createFollowUpTask,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { invokeCoder, type CoderResult } from '../orchestrator/coder.js';
import {
  invokeReviewer,
  invokeReviewers,
  getReviewerConfigs,
  isMultiReviewEnabled,
  resolveDecision,
  type ReviewerResult,
} from '../orchestrator/reviewer.js';
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
import {
  invokeCoderOrchestrator,
  invokeReviewerOrchestrator,
  invokeMultiReviewerOrchestrator,
} from '../orchestrator/invoke.js';
import { OrchestrationFallbackHandler } from '../orchestrator/fallback-handler.js';
import type { CoderContext, ReviewerContext, MultiReviewerContext, ReviewerOrchestrationResult } from '../orchestrator/types.js';
import { loadConfig, type ReviewerConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { InvokeResult } from '../providers/interface.js';
import { openGlobalDatabase } from '../runners/global-db.js';

export { type CoordinatorResult };

interface LeaseFenceContext {
  parallelSessionId?: string;
  runnerId?: string;
}

function refreshParallelWorkstreamLease(projectPath: string, leaseFence?: LeaseFenceContext): void {
  if (!leaseFence?.parallelSessionId) {
    return;
  }

  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare(
        `SELECT id, claim_generation, runner_id
         FROM workstreams
         WHERE session_id = ?
           AND clone_path = ?
           AND status = 'running'
         LIMIT 1`
      )
      .get(leaseFence.parallelSessionId, projectPath) as
      | { id: string; claim_generation: number; runner_id: string | null }
      | undefined;

    if (!row) {
      throw new Error('Parallel workstream row not found for lease refresh');
    }

    const owner = leaseFence.runnerId ?? row.runner_id ?? `runner:${process.pid ?? 'unknown'}`;
    const updateResult = db
      .prepare(
        `UPDATE workstreams
         SET runner_id = ?,
             lease_expires_at = datetime('now', '+120 seconds')
         WHERE id = ?
           AND status = 'running'
           AND claim_generation = ?`
      )
      .run(owner, row.id, row.claim_generation);

    if (updateResult.changes !== 1) {
      throw new Error('Parallel workstream lease fence check failed');
    }
  } finally {
    close();
  }
}

/**
 * Returned when a provider invocation is classified as credit exhaustion or rate limit.
 */
export interface CreditExhaustionResult {
  action: 'pause_credit_exhaustion' | 'rate_limit';
  provider: string;
  model: string;
  role: 'coder' | 'reviewer';
  message: string;
  retryAfterMs?: number;
}

/**
 * Check a coder/reviewer result for credit exhaustion or rate limits using the provider's classifier.
 * Uses provider.classifyResult() which checks both stderr and stdout.
 * Returns a CreditExhaustionResult if credits are exhausted or rate limited, null otherwise.
 */
function checkCreditExhaustion(
  result: InvokeResult,
  role: 'coder' | 'reviewer',
  projectPath: string,
  reviewerConfig?: ReviewerConfig
): CreditExhaustionResult | null {
  if (result.success) return null;

  const config = loadConfig(projectPath);
  const roleConfig = reviewerConfig || config.ai?.[role];
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

  if (classification?.type === 'rate_limit') {
    return {
      action: 'rate_limit',
      provider: providerName,
      model: modelName,
      role,
      message: classification.message,
      retryAfterMs: classification.retryAfterMs,
    };
  }

  return null;
}

const MAX_ORCHESTRATOR_PARSE_RETRIES = 3;
const CODER_PARSE_FALLBACK_MARKER = '[retry] FALLBACK: Orchestrator failed, defaulting to retry';
const REVIEWER_PARSE_FALLBACK_MARKER = '[unclear] FALLBACK: Orchestrator failed, retrying review';

function countConsecutiveOrchestratorFallbackEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  marker: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') break;

    if ((entry.notes ?? '').includes(marker)) {
      count += 1;
      continue;
    }

    break;
  }

  return count;
}

export async function runCoderPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  action: 'start' | 'resume',
  jsonMode = false,
  coordinatorCache?: Map<string, CoordinatorResult>,
  coordinatorThresholds?: number[],
  leaseFence?: LeaseFenceContext
): Promise<CreditExhaustionResult | void> {
  if (!task) return;
  refreshParallelWorkstreamLease(projectPath, leaseFence);

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
  let decision = handler.parseCoderOutput(orchestratorOutput);

  if (decision.action === 'retry' && decision.reasoning.startsWith('FALLBACK: Orchestrator failed')) {
    const consecutiveParseFallbackRetries =
      countConsecutiveOrchestratorFallbackEntries(db, task.id, CODER_PARSE_FALLBACK_MARKER) + 1;

    if (consecutiveParseFallbackRetries >= MAX_ORCHESTRATOR_PARSE_RETRIES) {
      decision = {
        ...decision,
        action: 'error',
        reasoning: `Orchestrator parse failed ${consecutiveParseFallbackRetries} times; escalating to failed to stop retry loop`,
        next_status: 'failed',
        metadata: {
          ...decision.metadata,
          confidence: 'low',
          exit_clean: false,
        },
      };
    } else {
      decision = {
        ...decision,
        reasoning: `${decision.reasoning} (parse_retry ${consecutiveParseFallbackRetries}/${MAX_ORCHESTRATOR_PARSE_RETRIES})`,
      };
    }
  }

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
      refreshParallelWorkstreamLease(projectPath, leaseFence);
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
  branchName: string = 'main',
  leaseFence?: LeaseFenceContext
): Promise<CreditExhaustionResult | void> {
  if (!task) return;
  refreshParallelWorkstreamLease(projectPath, leaseFence);

  const config = loadConfig(projectPath);
  const multiReviewEnabled = isMultiReviewEnabled(config);
  const strict = config.ai?.review?.strict ?? true;

  let reviewerResult: ReviewerResult | undefined;
  let reviewerResults: ReviewerResult[] = [];

  // STEP 1: Invoke reviewer(s)
  if (multiReviewEnabled) {
    const reviewerConfigs = getReviewerConfigs(config);
    if (!jsonMode) {
      console.log(`\n>>> Invoking ${reviewerConfigs.length} REVIEWERS in parallel...\n`);
      if (coordinatorResult) {
        console.log(`Coordinator guidance included (decision: ${coordinatorResult.decision})`);
      }
    }

    reviewerResults = await invokeReviewers(
      task,
      projectPath,
      reviewerConfigs,
      coordinatorResult?.guidance,
      coordinatorResult?.decision
    );

    // Check for credit exhaustion in any reviewer
    for (let i = 0; i < reviewerResults.length; i++) {
      const res = reviewerResults[i];
      const creditCheck = checkCreditExhaustion(res as any, 'reviewer', projectPath, reviewerConfigs[i]);
      if (creditCheck) {
        return creditCheck;
      }
    }

    // Handle failures in strict mode
    const failures = reviewerResults.filter(r => !r.success);
    if (strict && failures.length > 0) {
      if (!jsonMode) {
        console.warn(`${failures.length} reviewer(s) failed in strict mode. Will retry.`);
      }
      return;
    }
    // If not strict, we continue with the successful ones (resolveDecision handles empty/unclear)
  } else {
    if (!jsonMode) {
      console.log('\n>>> Invoking REVIEWER...\n');
      if (coordinatorResult) {
        console.log(`Coordinator guidance included (decision: ${coordinatorResult.decision})`);
      }
    }

    reviewerResult = await invokeReviewer(
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

    // Check for credit exhaustion
    const creditCheck = checkCreditExhaustion(reviewerResult as any, 'reviewer', projectPath);
    if (creditCheck) {
      return creditCheck;
    }
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

  // STEP 3: Resolve decision and merge notes if needed
  let decision: ReviewerOrchestrationResult;

  if (multiReviewEnabled) {
    const { decision: finalDecision, needsMerge } = resolveDecision(reviewerResults);

    if (needsMerge) {
      // Invoke multi-reviewer orchestrator to merge notes
      const multiContext: MultiReviewerContext = {
        task: {
          id: task.id,
          title: task.title,
          rejection_count: task.rejection_count,
        },
        reviewer_results: reviewerResults.map(r => ({
          provider: r.provider || 'unknown',
          model: r.model || 'unknown',
          decision: r.decision || 'unclear',
          stdout: r.stdout,
          stderr: r.stderr,
          duration_ms: r.duration,
        })),
        git_context: gitContext,
      };

      try {
        const orchestratorOutput = await invokeMultiReviewerOrchestrator(multiContext, projectPath);
        const handler = new OrchestrationFallbackHandler();
        decision = handler.parseReviewerOutput(orchestratorOutput);
      } catch (error) {
        console.error('Multi-reviewer orchestrator failed:', error);
        decision = {
          decision: 'unclear',
          reasoning: 'Multi-reviewer orchestrator failed',
          notes: 'Review unclear, retrying',
          next_status: 'review',
          metadata: {
            rejection_count: task.rejection_count,
            confidence: 'low',
            push_to_remote: false,
            repeated_issue: false,
          }
        };
      }
    } else {
      // No merge needed - find the primary result for notes
      const primaryResult = reviewerResults.find(r => r.decision === finalDecision) || reviewerResults[0];
      
      decision = {
        decision: (finalDecision === 'unclear' ? 'unclear' : finalDecision) as any,
        reasoning: `Multi-review consolidated decision: ${finalDecision}`,
        notes: primaryResult?.notes || primaryResult?.stdout || 'No notes provided',
        next_status: finalDecision === 'approve' ? 'completed' : 
                     finalDecision === 'reject' ? 'in_progress' : 
                     finalDecision === 'dispute' ? 'disputed' :
                     finalDecision === 'skip' ? 'skipped' : 'review',
        metadata: {
          rejection_count: task.rejection_count,
          confidence: 'high',
          push_to_remote: ['approve', 'dispute', 'skip'].includes(finalDecision),
          repeated_issue: false,
        }
      };
    }
  } else {
    // Single reviewer flow
    const context: ReviewerContext = {
      task: {
        id: task.id,
        title: task.title,
        rejection_count: task.rejection_count,
      },
      reviewer_output: {
        stdout: reviewerResult!.stdout,
        stderr: reviewerResult!.stderr,
        exit_code: reviewerResult!.exitCode,
        timed_out: reviewerResult!.timedOut,
        duration_ms: reviewerResult!.duration,
      },
      git_context: gitContext,
    };

    let orchestratorOutput: string;
    try {
      orchestratorOutput = await invokeReviewerOrchestrator(context, projectPath);
    } catch (error) {
      console.error('Orchestrator invocation failed:', error);
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

    const handler = new OrchestrationFallbackHandler();
    decision = handler.parseReviewerOutput(orchestratorOutput);
  }

  // STEP 4: Fallback for unclear decisions
  if (decision.decision === 'unclear' && decision.reasoning.startsWith('FALLBACK: Orchestrator failed')) {
    const consecutiveParseFallbackRetries =
      countConsecutiveOrchestratorFallbackEntries(db, task.id, REVIEWER_PARSE_FALLBACK_MARKER) + 1;

    if (consecutiveParseFallbackRetries >= MAX_ORCHESTRATOR_PARSE_RETRIES) {
      decision = {
        ...decision,
        decision: 'dispute',
        reasoning: `Orchestrator parse failed ${consecutiveParseFallbackRetries} times; escalating to dispute`,
        notes: 'Escalated to disputed to prevent endless unclear-review retries',
        next_status: 'disputed',
        metadata: {
          ...decision.metadata,
          confidence: 'low',
          push_to_remote: false,
        },
      };
    } else {
      decision = {
        ...decision,
        reasoning: `${decision.reasoning} (parse_retry ${consecutiveParseFallbackRetries}/${MAX_ORCHESTRATOR_PARSE_RETRIES})`,
      };
    }
  }

  // STEP 5: Log orchestrator decision for audit trail
  addAuditEntry(db, task.id, task.status, decision.next_status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[${decision.decision}] ${decision.reasoning} (confidence: ${decision.metadata.confidence})`,
  });

  // STEP 5.5: Create follow-up tasks if any (ONLY on approval)
  if (decision.decision === 'approve' && decision.follow_up_tasks && decision.follow_up_tasks.length > 0) {
    const depth = getFollowUpDepth(db, task.id);
    const maxDepth = config.followUpTasks?.maxDepth ?? 2;

    if (depth < maxDepth) {
      for (const followUp of decision.follow_up_tasks) {
        try {
          const nextDepth = depth + 1;
          
          // Policy: Auto-implement depth 1 if configured. 
          // Depth 2+ always requires human promotion (approval).
          let requiresPromotion = true;
          if (nextDepth === 1 && config.followUpTasks?.autoImplementDepth1) {
            requiresPromotion = false;
          }

          const followUpId = createFollowUpTask(db, {
            title: followUp.title,
            description: followUp.description,
            sectionId: task.section_id,
            referenceTaskId: task.id,
            referenceCommit: commit_sha || undefined,
            requiresPromotion,
            depth: nextDepth,
          });
          
          if (!jsonMode) {
            const statusLabel = requiresPromotion ? '(deferred)' : '(active)';
            console.log(`\n+ Created follow-up task ${statusLabel}: ${followUp.title} (${followUpId.substring(0, 8)})`);
          }
        } catch (error) {
          console.warn(`Failed to create follow-up task "${followUp.title}":`, error);
        }
      }
    } else if (!jsonMode) {
      console.log(`\n! Follow-up depth limit reached (${depth}), skipping new follow-ups.`);
    }
  }

  // STEP 6: Execute the decision
  const commitSha = commit_sha || undefined;

  switch (decision.decision) {
    case 'approve':
      approveTask(db, task.id, 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n✓ Task APPROVED (confidence: ${decision.metadata.confidence})`);
        console.log('Pushing to git...');
      }
      refreshParallelWorkstreamLease(projectPath, leaseFence);
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
      refreshParallelWorkstreamLease(projectPath, leaseFence);
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
