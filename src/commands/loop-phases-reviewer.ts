import { withGlobalDatabase } from '../runners/global-db.js';
import {
  getTask,
  updateTaskStatus,
  approveTask,
  rejectTask,
  getTaskAudit,
  incrementTaskFailureCount,
  clearTaskFailureCount,
  addAuditEntry,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import {
  invokeReviewer,
  invokeReviewers,
  getReviewerConfigs,
  isMultiReviewEnabled,
  type ReviewerResult,
} from '../orchestrator/reviewer.js';
import { pushToRemote } from '../git/push.js';
import { getCurrentCommitSha, getModifiedFiles, getDiffStats } from '../git/status.js';
import type { CoordinatorResult } from '../orchestrator/coordinator.js';
import { resolveReviewerDecision } from './loop-phases-reviewer-resolution.js';
import { loadConfig } from '../config/loader.js';
import { resolveEffectiveBranch } from '../git/branch-resolver.js';
import { checkSectionCompletionAndPR } from '../git/section-pr.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { PoolSlotContext } from '../workspace/types.js';
import { prepareForTask, postReviewGate } from '../workspace/git-lifecycle.js';
import { updateSlotStatus, releaseSlot } from '../workspace/pool.js';
import {
  LeaseFenceContext,
  extractOutOfScopeItems,
  refreshParallelWorkstreamLease,
  invokeWithLeaseHeartbeat,
  CreditExhaustionResult,
  MAX_ORCHESTRATOR_PARSE_RETRIES,
  REVIEWER_PARSE_FALLBACK_MARKER,
  formatProviderFailureMessage,
  handleProviderInvocationFailure,
  countConsecutiveUnclearEntries,
} from './loop-phases-helpers.js';
import { runReviewerSubmissionPreflight } from './reviewer-preflight.js';
import { createFollowUpTasksIfNeeded } from './loop-phases-reviewer-follow-ups.js';
import { handleIntakeTaskApproval } from '../intake/reviewer-approval.js';

export async function runReviewerPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  jsonMode = false,
  coordinatorResult?: CoordinatorResult,
  branchName: string = 'main',
  leaseFence?: LeaseFenceContext,
  poolSlotContext?: PoolSlotContext
): Promise<CreditExhaustionResult | void> {
  if (!task) return;
  if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
    if (!jsonMode) {
      console.log('\n↺ Lease ownership lost before reviewer phase; skipping task in this runner.');
    }
    return;
  }

  // ── Pool slot: set effective path for reviewer ──
  const effectiveProjectPath = poolSlotContext ? poolSlotContext.slot.slot_path : projectPath;

  if (poolSlotContext) {
    updateSlotStatus(poolSlotContext.globalDb, poolSlotContext.slot.id, 'review_active');
  }

  const preflight = runReviewerSubmissionPreflight(db, task, effectiveProjectPath, jsonMode);
  if (!preflight.ok) {
    return;
  }
  const submissionCommitSha = preflight.submissionCommitSha;
  const phaseConfig = loadConfig(projectPath);
  const multiReviewEnabled = isMultiReviewEnabled(phaseConfig);
  let effectiveMultiReviewEnabled = multiReviewEnabled;

  let reviewerResult: ReviewerResult | undefined;
  let reviewerResults: ReviewerResult[] = [];

  // STEP 1: Invoke reviewer(s)
  if (multiReviewEnabled) {
    const reviewerConfigs = getReviewerConfigs(phaseConfig);
    if (!jsonMode) {
      console.log(`\n>>> Invoking ${reviewerConfigs.length} REVIEWERS in parallel...\n`);
      if (coordinatorResult) {
        console.log(`Coordinator guidance included (decision: ${coordinatorResult.decision})`);
      }
    }

    const reviewerInvocation = await invokeWithLeaseHeartbeat(
      projectPath,
      leaseFence,
      () =>
        invokeReviewers(
          task,
          effectiveProjectPath,
          reviewerConfigs,
          coordinatorResult?.guidance,
          coordinatorResult?.decision,
          leaseFence?.runnerId
        )
    );
    if (reviewerInvocation.superseded || !reviewerInvocation.result) {
      if (!jsonMode) {
        console.log('\n↺ Lease ownership changed during reviewer invocation; skipping post-processing in this runner.');
      }
      return;
    }
    reviewerResults = reviewerInvocation.result;

    const successfulResults = reviewerResults.filter((res) => res.success && !res.timedOut);
    const failedResults = reviewerResults.filter((res) => !res.success || res.timedOut);

    if (failedResults.length > 0 && successfulResults.length === 0) {
      // All reviewers failed — handle as provider failure
      const failedReviewer = failedResults[0];
      const failedReviewerIndex = reviewerResults.indexOf(failedReviewer);
      const failedConfig = reviewerConfigs[failedReviewerIndex];
      const providerName =
        failedReviewer.provider ??
        failedConfig?.provider ??
        phaseConfig.ai?.reviewer?.provider ??
        'unknown';
      const modelName =
        failedReviewer.model ??
        failedConfig?.model ??
        phaseConfig.ai?.reviewer?.model ??
        'unknown';

      // Check for credit/rate limit before generic failure handling
      const registry = await getProviderRegistry();
      const prov = registry.tryGet(providerName);
      if (prov) {
        const classified = prov.classifyResult(failedReviewer);
        if (classified?.type === 'credit_exhaustion') {
          return { action: 'pause_credit_exhaustion', provider: providerName, model: modelName, role: 'reviewer', message: classified.message };
        }
        if (classified?.type === 'rate_limit') {
          return { action: 'rate_limit', provider: providerName, model: modelName, role: 'reviewer', message: classified.message, retryAfterMs: classified.retryAfterMs };
        }
        if (classified?.type === 'auth_error') {
          return { action: 'pause_auth_error', provider: providerName, model: modelName, role: 'reviewer', message: classified.message };
        }
      }

      const output = (failedReviewer.stderr || failedReviewer.stdout || '').trim();
      const failed = await handleProviderInvocationFailure(
        db,
        task.id,
        {
          role: 'reviewer',
          provider: providerName,
          model: modelName,
          exitCode: failedReviewer.exitCode ?? 1,
          output,
        },
        jsonMode
      );

      if (failed.shouldStopTask) {
        return;
      }
      return;
    }

    if (failedResults.length > 0 && successfulResults.length > 0) {
      // Partial failure: some reviewers failed but at least one succeeded.
      // Log the failures and degrade gracefully to using successful results only.
      for (const failedReviewer of failedResults) {
        const failedReviewerIndex = reviewerResults.indexOf(failedReviewer);
        const failedConfig = reviewerConfigs[failedReviewerIndex];
        const providerName = failedReviewer.provider ?? failedConfig?.provider ?? 'unknown';
        const modelName = failedReviewer.model ?? failedConfig?.model ?? 'unknown';
        if (!jsonMode) {
          const reason = failedReviewer.stderr || failedReviewer.stdout || 'no output';
          console.log(`\n⚠ Reviewer ${providerName}/${modelName} failed — degrading to ${successfulResults.length} successful reviewer(s). Error: ${reason.slice(0, 300)}`);
        }
      }
      // Continue with only the successful results
      reviewerResults = successfulResults;
    }

    clearTaskFailureCount(db, task.id);
    reviewerResult = reviewerResults[0];
    effectiveMultiReviewEnabled = reviewerResults.length > 1;
  } else {
    if (!jsonMode) {
      console.log('\n>>> Invoking REVIEWER...\n');
      if (coordinatorResult) {
        console.log(`Coordinator guidance included (decision: ${coordinatorResult.decision})`);
      }
    }

    const reviewerInvocation = await invokeWithLeaseHeartbeat(
      projectPath,
      leaseFence,
      () =>
        invokeReviewer(
          task,
          effectiveProjectPath,
          coordinatorResult?.guidance,
          coordinatorResult?.decision,
          undefined,
          leaseFence?.runnerId
        )
    );
    if (reviewerInvocation.superseded || !reviewerInvocation.result) {
      if (!jsonMode) {
        console.log('\n↺ Lease ownership changed during reviewer invocation; skipping post-processing in this runner.');
      }
      return;
    }
    reviewerResult = reviewerInvocation.result;

    if (!reviewerResult.success || reviewerResult.timedOut) {
      const providerName =
        reviewerResult.provider ??
        phaseConfig.ai?.reviewer?.provider ??
        'unknown';
      const modelName =
        reviewerResult.model ??
        phaseConfig.ai?.reviewer?.model ??
        'unknown';

      // Check for credit/rate_limit exhaustion before provider failure handling
      const registry = await getProviderRegistry();
      const prov = registry.tryGet(providerName);
      if (prov) {
        const classified = prov.classifyResult(reviewerResult);
        if (classified?.type === 'credit_exhaustion') {
          return { action: 'pause_credit_exhaustion', provider: providerName, model: modelName, role: 'reviewer', message: classified.message };
        }
        if (classified?.type === 'rate_limit') {
          return { action: 'rate_limit', provider: providerName, model: modelName, role: 'reviewer', message: classified.message, retryAfterMs: classified.retryAfterMs };
        }
        if (classified?.type === 'auth_error') {
          return { action: 'pause_auth_error', provider: providerName, model: modelName, role: 'reviewer', message: classified.message };
        }
      }
      // Non-credit/rate-limit reviewer failure: fall through to orchestrator
    } else {
      clearTaskFailureCount(db, task.id);
    }
  }

  // STEP 2: Gather git context
  const commit_sha = getCurrentCommitSha(effectiveProjectPath) || '';
  const files_changed = getModifiedFiles(effectiveProjectPath);
  const diffStats = getDiffStats(effectiveProjectPath);

  const gitContext = {
    commit_sha,
    files_changed,
    additions: diffStats.additions,
    deletions: diffStats.deletions,
  };

  // STEP 3: Resolve decision and merge notes if needed
  let decision = await resolveReviewerDecision(
    { id: task.id, title: task.title, rejection_count: task.rejection_count },
    projectPath,
    reviewerResult,
    reviewerResults,
    effectiveMultiReviewEnabled,
    gitContext
  );

  // STEP 4: Fallback for unclear decisions (catches ALL unclear, not just orchestrator parse failures)
  let disputeErrorCode: string | undefined;
  if (decision.decision === 'unclear') {
    const consecutiveParseFallbackRetries =
      countConsecutiveUnclearEntries(db, task.id) + 1;

    if (consecutiveParseFallbackRetries >= MAX_ORCHESTRATOR_PARSE_RETRIES) {
      const timeoutCandidates = effectiveMultiReviewEnabled
        ? reviewerResults
        : (reviewerResult ? [reviewerResult] : []);
      const isZeroOutputTimeout = timeoutCandidates.some(r =>
        !!r?.timedOut && !r?.stdout?.trim() && !r?.stderr?.trim()
      );

      if (isZeroOutputTimeout) {
        disputeErrorCode = 'REVIEWER_ZERO_OUTPUT_TIMEOUT';
        decision = {
          ...decision,
          decision: 'dispute',
          reasoning: `Reviewer timed out with zero output ${consecutiveParseFallbackRetries} times — the reviewer CLI is likely blocked by an interactive setup prompt (e.g. machine/toolchain configuration). Run the reviewer CLI manually once in a terminal to complete setup, then restart this task.`,
          notes: 'REVIEWER_ZERO_OUTPUT_TIMEOUT: Reviewer process hung with no output. Cause: interactive setup prompt (e.g. Claude Code onboarding or machine toolchain) is blocking the CLI since stdin is closed in automated mode. Fix: open a terminal and run the reviewer CLI once to complete setup, then restart the task.',
          next_status: 'disputed',
          confidence: 'low',
          push_to_remote: false,
        };
      } else {
        decision = {
          ...decision,
          decision: 'dispute',
          reasoning: `Orchestrator parse failed ${consecutiveParseFallbackRetries} times; escalating to dispute`,
          notes: 'Escalated to disputed to prevent endless unclear-review retries',
          next_status: 'disputed',
            confidence: 'low',
            push_to_remote: false,
        };
      }
    } else {
      decision = {
        ...decision,
        reasoning: `${decision.reasoning} (parse_retry ${consecutiveParseFallbackRetries}/${MAX_ORCHESTRATOR_PARSE_RETRIES})`,
      };
    }
  }

  // STEP 5: Log orchestrator decision for audit trail (non-transition row).
  // Concrete status transitions are recorded by approve/reject/update calls below.
  addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[${decision.decision}] ${decision.reasoning} (confidence: ${decision.confidence})`,
    category: 'decision',
    errorCode: disputeErrorCode,
  });

  if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
    if (!jsonMode) {
      console.log('\n↺ Lease ownership changed before applying reviewer decision; skipping in this runner.');
    }
    return;
  }

  // STEP 5.5: Create follow-up tasks if any (ONLY on approval)
  await createFollowUpTasksIfNeeded(
    db,
    task,
    projectPath,
    decision.follow_up_tasks,
    submissionCommitSha,
    jsonMode
  );

  // STEP 6: Execute the decision
  const commitSha = submissionCommitSha;

  switch (decision.decision) {
    case 'approve': {
      if (poolSlotContext) {
        postReviewGate(effectiveProjectPath);
      }

      // No-op submission: coder made no new commits; work pre-existed.
      const isNoOp = reviewerResult?.isNoOp ?? false;
      if (isNoOp) {
        approveTask(db, task.id, 'orchestrator', decision.notes, commitSha);
        handleIntakeTaskApproval(db, task, effectiveProjectPath);
        if (poolSlotContext) {
          releaseSlot(poolSlotContext.globalDb, poolSlotContext.slot.id);
        }
        if (!jsonMode) console.log('\n✓ Task APPROVED (pre-existing work confirmed by reviewer, no merge needed)');
        await checkSectionCompletionAndPR(db, projectPath, task.section_id, phaseConfig);
        return;
      }

      // Resolve approved_sha from the remote task branch HEAD
      const taskBranch = poolSlotContext?.slot.task_branch;
      let approvedSha = commitSha;
      if (taskBranch) {
        try {
          const { execFileSync: efs } = await import('node:child_process');
          const remoteSha = efs('git', ['rev-parse', `refs/remotes/origin/${taskBranch}`], {
            cwd: effectiveProjectPath, encoding: 'utf-8',
          }).trim();
          if (remoteSha) approvedSha = remoteSha;
        } catch {
          // Remote ref not in local reflog — use local commit SHA.
          // The merge queue's fetchAndPrepare will independently verify the SHA
          // matches the remote branch HEAD; mismatches return the task to review.
          if (!jsonMode) console.log(`  ⚠ Could not resolve remote ref for ${taskBranch}, using local SHA`);
        }
      }

      // Transition to merge_pending — merge queue will handle the actual merge
      updateTaskStatus(db, task.id, 'merge_pending', 'orchestrator',
        `Reviewer approved (${decision.confidence}). Queued for merge.`);
      // Set merge queue columns
      db.prepare(
        `UPDATE tasks SET merge_phase = 'queued', approved_sha = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(approvedSha, task.id);

      addAuditEntry(db, task.id, 'review', 'merge_pending', 'orchestrator', {
        actorType: 'orchestrator',
        notes: `[merge_queue] Reviewer approved → merge_pending (approved_sha: ${approvedSha})`,
        commitSha: approvedSha,
      });

      if (!jsonMode) {
        console.log(`\n✓ Task APPROVED → merge_pending (sha: ${approvedSha}, confidence: ${decision.confidence})`);
      }
      break;
    }

    case 'reject': {
      // Deterministically extract [OUT_OF_SCOPE] items from raw reviewer stdout.
      // The post-reviewer LLM may rephrase or drop structured tags, so we preserve
      // them here before they are lost. Only append if not already present.
      const allReviewerStdout = effectiveMultiReviewEnabled
        ? (reviewerResults ?? []).map(r => r?.stdout ?? '').join('\n')
        : (reviewerResult?.stdout ?? '');
      const outOfScopeItems = extractOutOfScopeItems(allReviewerStdout);
      if (outOfScopeItems.length > 0 && !(decision.notes ?? '').toLowerCase().includes('[out_of_scope]')) {
        decision = {
          ...decision,
          notes: `${decision.notes ?? ''}\n\n## Out-of-Scope Items (from reviewer)\n${outOfScopeItems.join('\n')}`
        };
      }
      rejectTask(db, task.id, 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n✗ Task REJECTED (${task.rejection_count + 1}/15, confidence: ${decision.confidence})`);
        console.log('Returning to coder for fixes.');
      }
      break;
    }

    case 'dispute':
      updateTaskStatus(db, task.id, 'disputed', 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n! Task DISPUTED (confidence: ${decision.confidence})`);
        console.log('Pushing current work and moving to next task.');
      }
      if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
        if (!jsonMode) {
          console.log('\n↺ Lease ownership lost before dispute push; skipping push in this runner.');
        }
        return;
      }
      const disputeConfig = loadConfig(projectPath);
      const disputeBranch = leaseFence?.parallelSessionId
        ? branchName
        : (resolveEffectiveBranch(db, task.section_id ?? null, disputeConfig) ?? disputeConfig.git?.branch ?? 'main');
      const disputePush = pushToRemote(effectiveProjectPath, 'origin', disputeBranch);
      if (!jsonMode && disputePush.success) {
        console.log(`Pushed disputed work (${disputePush.commitHash})`);
      }
      break;

    case 'skip':
      updateTaskStatus(db, task.id, 'skipped', 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n⏭ Task SKIPPED (confidence: ${decision.confidence})`);
      }
      break;

    case 'unclear':
      if (!jsonMode) {
        console.log(`\n? Review unclear (${decision.reasoning}), will retry`);
      }
      break;
  }
}
