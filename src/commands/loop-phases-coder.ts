import {
  getTask,
  getTaskRejections,
  updateTaskStatus,
  addAuditEntry,
  incrementTaskFailureCount,
  clearTaskFailureCount,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import { invokeCoder, type CoderResult } from '../orchestrator/coder.js';
import { type CoordinatorResult } from '../orchestrator/coordinator.js';
import {
  getCurrentCommitSha,
  getRecentCommits,
  getChangedFiles,
  hasUncommittedChanges,
  getDiffSummary,
} from '../git/status.js';
import { invokeCoderOrchestrator } from '../orchestrator/invoke.js';
import { OrchestrationFallbackHandler } from '../orchestrator/fallback-handler.js';
import type { CoderContext } from '../orchestrator/types.js';
import { loadConfig, type ReviewerConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { PoolSlotContext } from '../workspace/types.js';
import { prepareForTask, postCoderGate } from '../workspace/git-lifecycle.js';
import { resolveEffectiveBranch } from '../git/branch-resolver.js';
import { updateSlotStatus, releaseSlot } from '../workspace/pool.js';
import {
  LeaseFenceContext,
  refreshParallelWorkstreamLease,
  invokeWithLeaseHeartbeat,
  CreditExhaustionResult,
  MAX_ORCHESTRATOR_PARSE_RETRIES,
  MAX_CONTRACT_VIOLATION_RETRIES,
  MAX_CONSECUTIVE_CODER_RETRIES,
  CODER_PARSE_FALLBACK_MARKER,
  CONTRACT_CHECKLIST_MARKER,
  CONTRACT_REJECTION_RESPONSE_MARKER,
  classifyOrchestratorFailure,
  handleProviderInvocationFailure,
  countConsecutiveOrchestratorFallbackEntries,
  countConsecutiveRetryEntries,
  countConsecutiveTaggedOrchestratorEntries,
  countLatestOpenRejectionItems,
  hasCoderCompletionSignal,
} from './loop-phases-helpers.js';
import {
  invokeCoordinatorIfNeeded,
  executeCoderDecision,
} from './loop-phases-coder-decision.js';
import { handleNoOpSubmissionInPool } from './coder-noop-submission.js';

export async function runCoderPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  action: 'start' | 'resume',
  jsonMode = false,
  coordinatorCache?: Map<string, CoordinatorResult>,
  coordinatorThresholds?: number[],
  leaseFence?: LeaseFenceContext,
  branchName = 'main',
  poolSlotContext?: PoolSlotContext,
  sourceProjectPath: string = projectPath
): Promise<CreditExhaustionResult | void> {
  if (!task) return;
  if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
    if (!jsonMode) {
      console.log('\n↺ Lease ownership lost before coder phase; skipping task in this runner.');
    }
    return;
  }

  // ── Pool slot: prepare workspace for task ──
  let poolStartingSha: string | undefined;
  let effectiveProjectPath = projectPath;

  if (poolSlotContext) {
    const config = loadConfig(projectPath);
    const sectionBranch = resolveEffectiveBranch(db, task.section_id ?? null, config);
    const configBranch = config.git?.branch ?? null;
    const prepResult = prepareForTask(
      poolSlotContext.globalDb,
      poolSlotContext.slot,
      task.id,
      projectPath,
      sourceProjectPath,
      sectionBranch,  // section branch if set (migration 021), null means use project base
      configBranch
    );

    if (!prepResult.ok) {
      if (!jsonMode) {
        console.log(`\n✗ Workspace preparation failed: ${prepResult.reason}`);
      }
      if (prepResult.blocked) {
        const { setTaskBlocked } = await import('../database/queries.js');
        setTaskBlocked(db, task.id, 'blocked_error', prepResult.reason);
      }
      releaseSlot(poolSlotContext.globalDb, poolSlotContext.slot.id);
      return;
    }

    poolStartingSha = prepResult.startingSha;
    effectiveProjectPath = poolSlotContext.slot.slot_path;

    if (!jsonMode) {
      console.log(`\n✓ Workspace prepared (branch: ${prepResult.taskBranch}, base: ${prepResult.baseBranch})`);
    }
  }

  // Get coordinator guidance if needed
  const coordinatorGuidance = await invokeCoordinatorIfNeeded(
    db,
    task,
    projectPath,
    effectiveProjectPath,
    coordinatorCache,
    coordinatorThresholds,
    jsonMode
  );

  // STEP 1: Invoke coder (no status commands in prompt anymore)
  if (!jsonMode) {
    console.log('\n>>> Invoking CODER...\n');
  }

  const initialSha = poolStartingSha || getCurrentCommitSha(effectiveProjectPath) || '';
  const coderConfig = loadConfig(projectPath).ai?.coder as ReviewerConfig | undefined;
  const coderInvocation = await invokeWithLeaseHeartbeat(
    projectPath,
    leaseFence,
    () => invokeCoder(task, effectiveProjectPath, action, coordinatorGuidance, leaseFence?.runnerId)
  );
  if (coderInvocation.superseded || !coderInvocation.result) {
    if (!jsonMode) {
      console.log('\n↺ Lease ownership changed during coder invocation; skipping post-processing in this runner.');
    }
    return;
  }
  const coderResult: CoderResult = coderInvocation.result;

  if (coderResult.timedOut || !coderResult.success) {
    const providerName = coderConfig?.provider ?? loadConfig(projectPath).ai?.coder?.provider ?? 'unknown';
    const modelName = coderConfig?.model ?? loadConfig(projectPath).ai?.coder?.model ?? 'unknown';

    // Check for credit/rate_limit exhaustion before counting as a provider failure
    const registry = await getProviderRegistry();
    const prov = registry.tryGet(providerName);
    if (prov) {
      const classified = prov.classifyResult(coderResult);
      if (classified?.type === 'credit_exhaustion') {
        return { action: 'pause_credit_exhaustion', provider: providerName, model: modelName, role: 'coder', message: classified.message };
      }
      if (classified?.type === 'rate_limit') {
        return { action: 'rate_limit', provider: providerName, model: modelName, role: 'coder', message: classified.message, retryAfterMs: classified.retryAfterMs };
      }
    }

    const output = (coderResult.stderr || coderResult.stdout || '').trim();
    const failed = await handleProviderInvocationFailure(
      db,
      task.id,
      {
        role: 'coder',
        provider: providerName,
        model: modelName,
        exitCode: coderResult.exitCode ?? 1,
        output,
      },
      jsonMode
    );

    if (failed.shouldStopTask) {
      return;
    }
    return;
  }

  clearTaskFailureCount(db, task.id);

  // ── Pool slot: post-coder verification gate ──
  if (poolSlotContext && poolStartingSha) {
    const gateResult = postCoderGate(effectiveProjectPath, poolStartingSha, task.title);
    if (!gateResult.ok) {
      if (gateResult.reasonCode === 'no_new_commits') {
        const noOpResult = handleNoOpSubmissionInPool(
          db,
          task,
          projectPath,
          effectiveProjectPath,
          poolStartingSha,
          poolSlotContext,
          leaseFence,
          jsonMode
        );
        if (noOpResult.handled) {
          return;
        }
        return;
      }
      // git_error or any other failure: audit entry + retry (existing behaviour)
      if (!jsonMode) {
        console.log(`\n⟳ Post-coder gate: ${gateResult.reason}. Returning to coder.`);
      }
      addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
        actorType: 'orchestrator',
        notes: `[retry] Post-coder gate: ${gateResult.reason}`,
      });
      return;
    }
    if (gateResult.autoCommitted && !jsonMode) {
      console.log('\n✓ Post-coder gate: auto-committed uncommitted work');
    }
    updateSlotStatus(poolSlotContext.globalDb, poolSlotContext.slot.id, 'awaiting_review');
  }

  // STEP 2: Gather git state
  const commits = getRecentCommits(effectiveProjectPath, 5, initialSha);
  const files_changed = getChangedFiles(effectiveProjectPath);
  const has_uncommitted = hasUncommittedChanges(effectiveProjectPath);
  const diff_summary = getDiffSummary(effectiveProjectPath);
  const hasRelevantChanges = has_uncommitted || commits.length > 0 || files_changed.length > 0;

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
  const requiresExplicitSubmissionCommit = (lastRejectionNotes ?? '').includes('[commit_recovery]');
  const rejectionItemCount = countLatestOpenRejectionItems(lastRejectionNotes);

  const context: CoderContext = {
    task: {
      id: task.id,
      title: task.title,
      description: task.title, // Use title as description for now
      rejection_notes: lastRejectionNotes,
      rejection_count: task.rejection_count,
      rejection_item_count: rejectionItemCount,
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
    const orchestratorFailure = await classifyOrchestratorFailure(error, projectPath);

    if (orchestratorFailure && !orchestratorFailure.retryable) {
      orchestratorOutput = `STATUS: ERROR\nREASON: FALLBACK: Non-retryable orchestrator failure (${orchestratorFailure.type})\nCONFIDENCE: LOW`;
    } else {
      // Check if coder seems finished even if orchestrator failed
      const isTaskComplete = hasCoderCompletionSignal(coderResult.stdout);
      // Only count as having work if there are actual relevant uncommitted changes,
      // changed files, or recent commits
      const hasWork = hasRelevantChanges;

      if (isTaskComplete && hasWork) {
        orchestratorOutput = `STATUS: REVIEW\nREASON: FALLBACK: Orchestrator failed but coder signaled completion\nCONFIDENCE: LOW`;
      } else {
        // Fallback to safe default: retry
        orchestratorOutput = `STATUS: RETRY\nREASON: FALLBACK: Orchestrator failed, defaulting to retry\nCONFIDENCE: LOW`;
      }
    }
  }

  // STEP 5: Parse orchestrator output with fallback
  const handler = new OrchestrationFallbackHandler();
  let decision = handler.parseCoderOutput(orchestratorOutput);

  // Fill git-state fields from actual git state (parser returns placeholders)
  decision.commits = commits.map(c => c.sha);
  decision.files_changed = files_changed.length;
  decision.has_commits = commits.length > 0;

  // Derive stage_commit_submit from submit + uncommitted + completion signal
  if (decision.action === 'submit' && has_uncommitted && commits.length === 0) {
    const isTaskComplete = hasCoderCompletionSignal(coderResult.stdout);
    if (isTaskComplete) {
      decision.action = 'stage_commit_submit';
    }
    // If not complete, leave as 'submit' — the existing submit handler
    // will fail safely when it can't find a valid commit hash
  }

  // When orchestrator parse falls back to retry, check coder output + git state
  // for completion signals before giving up (same logic as the catch block above)
  if (decision.action === 'retry' && decision.reasoning.includes('FALLBACK: Orchestrator failed')) {
    const isTaskComplete = hasCoderCompletionSignal(coderResult.stdout);
    const hasWork = hasRelevantChanges;

    if (isTaskComplete && hasWork) {
      if (!jsonMode) {
        console.log('[Orchestrator] Parse failed but coder signaled completion with work present - submitting');
      }
      decision = {
        action: has_uncommitted ? 'stage_commit_submit' : 'submit',
        reasoning: 'FALLBACK: Orchestrator failed but coder signaled completion with commits/changes',
        commits: commits.map(c => c.sha),
        commit_message: has_uncommitted ? 'feat: implement task specification' : undefined,
        next_status: 'review',
        files_changed: files_changed.length,
        confidence: 'low',
        exit_clean: true,
        has_commits: commits.length > 0,
      };
    } else {
      // No completion signal - apply the parse retry counter
      const consecutiveParseFallbackRetries =
        countConsecutiveOrchestratorFallbackEntries(db, task.id, CODER_PARSE_FALLBACK_MARKER) + 1;

      if (consecutiveParseFallbackRetries >= MAX_ORCHESTRATOR_PARSE_RETRIES) {
        decision = {
          ...decision,
          action: 'error',
          reasoning: `Orchestrator parse failed ${consecutiveParseFallbackRetries} times; escalating to failed to stop retry loop`,
          next_status: 'failed',
          confidence: 'low',
          exit_clean: false,
        };
      } else {
        decision = {
          ...decision,
          reasoning: `${decision.reasoning} (parse_retry ${consecutiveParseFallbackRetries}/${MAX_ORCHESTRATOR_PARSE_RETRIES})`,
        };
      }
    }
  }

  // Contract-violation handling (detected via REASON prefix from text signals).
  const legacyChecklistViolation = /^CHECKLIST_REQUIRED:/i.test(decision.reasoning || '');
  const legacyRejectionResponseViolation = /^REJECTION_RESPONSE_REQUIRED:/i.test(decision.reasoning || '');
  const contractViolation: 'checklist_required' | 'rejection_response_required' | null =
    legacyChecklistViolation ? 'checklist_required'
    : legacyRejectionResponseViolation ? 'rejection_response_required'
    : null;

  if (contractViolation) {
    const marker = contractViolation === 'checklist_required'
      ? CONTRACT_CHECKLIST_MARKER
      : CONTRACT_REJECTION_RESPONSE_MARKER;
    const reasonText = (decision.reasoning || '')
      .replace(/^CHECKLIST_REQUIRED:\s*/i, '')
      .replace(/^REJECTION_RESPONSE_REQUIRED:\s*/i, '')
      .trim();
    const cleanReason = reasonText || 'Required output contract not satisfied';
    const consecutiveContractViolations =
      countConsecutiveTaggedOrchestratorEntries(db, task.id, marker, '[contract:') + 1;

    if (consecutiveContractViolations >= MAX_CONTRACT_VIOLATION_RETRIES) {
      decision = {
        ...decision,
        action: 'error',
        next_status: 'failed',
        reasoning: `${marker} ${cleanReason} (retry_limit ${consecutiveContractViolations}/${MAX_CONTRACT_VIOLATION_RETRIES})`,
        confidence: 'low',
        exit_clean: false,
      };
    } else {
      decision = {
        ...decision,
        action: 'retry',
        next_status: 'in_progress',
        reasoning: `${marker} ${cleanReason} (retry ${consecutiveContractViolations}/${MAX_CONTRACT_VIOLATION_RETRIES})`,
        confidence: 'medium',
      };
    }
  }

  // Enforce orchestrator authority over weak/unsupported WONT_FIX claims.
  // WONT_FIX overrides are now encoded in the REASON prefix as semicolon-separated items.
  const legacyWontFixOverrideMatch = (decision.reasoning || '').match(/WONT_FIX_OVERRIDE:\s*([\s\S]+)/i);
  const overrideItems = legacyWontFixOverrideMatch?.[1]
    ? legacyWontFixOverrideMatch[1]
        .split(';')
        .map(line => line.trim())
        .filter(Boolean)
    : [];

  if (overrideItems.length > 0) {
    const mandatoryLines = overrideItems.map((item, idx) => `${idx + 1}. ${item}`);
    const mandatoryGuidance = `MUST_IMPLEMENT:
${mandatoryLines.join('\n')}

This is a mandatory orchestrator override. Implement these changes before resubmitting.
Only use WONT_FIX if you provide exceptional technical evidence and the orchestrator explicitly accepts it.`;
    const persistedNote = mandatoryGuidance;

    addAuditEntry(db, task.id, task.status, task.status, 'coordinator', {
      actorType: 'orchestrator',
      notes: persistedNote,
      category: 'must_implement',
      metadata: { rejection_count: task.rejection_count }
    });

    coordinatorCache?.set(task.id, {
      success: true,
      decision: 'guide_coder',
      guidance: mandatoryGuidance,
    });

    decision = {
      ...decision,
      action: 'retry',
      next_status: 'in_progress',
      reasoning: `WONT_FIX override applied (MUST_IMPLEMENT)`,
      confidence: 'medium',
    };
  }

  // Universal retry cap: prevent infinite loops for ANY consecutive [retry] entries.
  // This catches the bug where SignalParser returns 'unclear' → 'retry' without escalation.
  if (decision.action === 'retry') {
    const consecutiveRetries = countConsecutiveRetryEntries(db, task.id) + 1;
    if (consecutiveRetries >= MAX_CONSECUTIVE_CODER_RETRIES) {
      decision = {
        ...decision,
        action: 'error',
        reasoning: `Coder retry limit reached (${consecutiveRetries} consecutive retries); escalating to failed`,
        next_status: 'failed',
        confidence: 'low',
        exit_clean: false,
      };
    }
  }

  // STEP 6: Log orchestrator decision for audit trail.
  // Use a non-transition audit row here; actual status transitions are recorded
  // only after execution succeeds (e.g. updateTaskStatus/approveTask/rejectTask).
  addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[${decision.action}] ${decision.reasoning} (confidence: ${decision.confidence})`,
    category: 'decision',
  });

  if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
    if (!jsonMode) {
      console.log('\n↺ Lease ownership changed before applying coder decision; skipping in this runner.');
    }
    return;
  }

  // STEP 7: Execute the decision
  await executeCoderDecision(db, task, decision, {
    coderStdout: coderResult.stdout,
    has_uncommitted,
    requiresExplicitSubmissionCommit,
    effectiveProjectPath,
    projectPath,
    branchName,
    leaseFence,
    jsonMode,
    hasPoolSlot: poolSlotContext !== undefined,
  });
}
