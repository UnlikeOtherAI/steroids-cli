import { withGlobalDatabase } from '../runners/global-db.js';
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
  getSubmissionCommitShas,
  getLatestMustImplementGuidance,
  listTasks,
  addAuditEntry,
  getFollowUpDepth,
  createFollowUpTask,
  incrementTaskFailureCount,
  clearTaskFailureCount,
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
  isCommitReachable,
  isCommitReachableWithFetch,
} from '../git/status.js';
import { resolveSubmissionCommitWithRecovery } from '../git/submission-resolution.js';
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

  withGlobalDatabase((db: any) => {
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
  });
}

export interface CreditExhaustionResult {
  action: 'pause_credit_exhaustion' | 'rate_limit';
  provider: string;
  model: string;
  role: 'coder' | 'reviewer';
  message: string;
  retryAfterMs?: number;
}

function summarizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * Classify orchestrator invocation failures so we can distinguish transient parse
 * noise from hard provider/config failures (auth/model/availability).
 */
async function classifyOrchestratorFailure(
  error: unknown,
  projectPath: string
): Promise<{ type: string; message: string; retryable: boolean } | null> {
  const message = summarizeErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes('orchestrator ai provider not configured')) {
    return { type: 'orchestrator_unconfigured', message, retryable: false };
  }

  if (lower.includes("provider '") && lower.includes('is not available')) {
    return { type: 'provider_unavailable', message, retryable: false };
  }

  const config = loadConfig(projectPath);
  const providerName = config.ai?.orchestrator?.provider;
  if (!providerName) {
    return { type: 'orchestrator_unconfigured', message, retryable: false };
  }

  const registry = await getProviderRegistry();
  const provider = registry.tryGet(providerName);
  if (!provider) {
    return { type: 'provider_unavailable', message, retryable: false };
  }

  const syntheticFailure: InvokeResult = {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: message,
    duration: 0,
    timedOut: false,
  };

  const classified = provider.classifyResult(syntheticFailure);
  if (!classified) {
    return null;
  }

  return {
    type: classified.type,
    message: classified.message || message,
    retryable: classified.retryable,
  };
}

const MAX_ORCHESTRATOR_PARSE_RETRIES = 3;
const MAX_CONTRACT_VIOLATION_RETRIES = 3;
const MAX_PROVIDER_NONZERO_FAILURES = 3;
const CODER_PARSE_FALLBACK_MARKER = '[retry] FALLBACK: Orchestrator failed, defaulting to retry';
const REVIEWER_PARSE_FALLBACK_MARKER = '[unclear] FALLBACK: Orchestrator failed, retrying review';
const CONTRACT_CHECKLIST_MARKER = '[contract:checklist]';
const CONTRACT_REJECTION_RESPONSE_MARKER = '[contract:rejection_response]';
const MUST_IMPLEMENT_MARKER = '[must_implement]';

interface ProviderFailureContext {
  role: 'coder' | 'reviewer';
  provider: string;
  model: string;
  exitCode: number;
  output: string;
}

interface ProviderInvocationFailureDecision {
  shouldStopTask: boolean;
}

function formatProviderFailureMessage(
  taskId: string,
  context: ProviderFailureContext
): string {
  const output = context.output || 'provider invocation failed with no output.';
  return `Task ${taskId}: provider ${context.provider}/${context.model} exited with non-zero status ${context.exitCode} during ${context.role} phase: ${output}`;
}

async function handleProviderInvocationFailure(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  context: ProviderFailureContext,
  jsonMode: boolean
): Promise<ProviderInvocationFailureDecision> {
  const failureCount = incrementTaskFailureCount(db, taskId);
  const providerMessage = formatProviderFailureMessage(taskId, context);

  if (failureCount >= MAX_PROVIDER_NONZERO_FAILURES) {
    const reason = `${providerMessage} (provider invocation failed ${failureCount} time(s). Task failed.)`;
    updateTaskStatus(db, taskId, 'failed', 'orchestrator', reason);

    if (!jsonMode) {
      console.log(`\n✗ Task failed (${reason})`);
    }

    return { shouldStopTask: true };
  }

  if (!jsonMode) {
    const retriesLeft = MAX_PROVIDER_NONZERO_FAILURES - failureCount;
    console.log(`\n⟳ Provider invocation failed (${failureCount}/${MAX_PROVIDER_NONZERO_FAILURES}) for task ${taskId}; retrying (${retriesLeft} attempt(s) left).`);
    console.log(`    ${providerMessage}`);
  }

  return { shouldStopTask: false };
}

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

    // Use category and error_code instead of marker string search
    const isFallback = entry.category === 'fallback';
    const matchesCode = entry.error_code === marker;

    if (isFallback && matchesCode) {
      count += 1;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Count consecutive unclear orchestrator entries (regardless of specific marker).
 * This catches ALL unclear decisions — orchestrator parse failures, missing decision tokens, etc.
 */
function countConsecutiveUnclearEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') break;

    if ((entry.notes ?? '').startsWith('[unclear]')) {
      count += 1;
      continue;
    }

    break;
  }

  return count;
}

function countConsecutiveTaggedOrchestratorEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  requiredTag: string,
  tagFamilyPrefix?: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') {
      continue; // tolerate non-orchestrator audit noise
    }

    const notes = entry.notes ?? '';
    if (notes.includes(requiredTag)) {
      count += 1;
      continue;
    }

    if (tagFamilyPrefix && notes.includes(tagFamilyPrefix)) {
      break; // same family, different category = sequence ended
    }

    break;
  }

  return count;
}

function countLatestOpenRejectionItems(notes?: string): number {
  if (!notes) return 0;
  return notes
    .split('\n')
    .filter(line => /^\s*[-*]\s*\[\s\]\s+/.test(line))
    .length;
}

function hasCoderCompletionSignal(output: string): boolean {
  const lower = output.toLowerCase();

  if (/\b(?:not|no)\s+(?:task\s+)?(?:is\s+)?(?:complete|complete[d]?|finished|done|ready)\b/.test(lower)) {
    return false;
  }

  return /\b(?:task\s+)?(?:is\s+)?(?:complete|complete[d]?|implemented|finished|done|ready for review|ready)\b/.test(
    lower
  );
}

function extractSubmissionCommitToken(output: string): string | null {
  const match = output.match(/^\s*SUBMISSION_COMMIT\s*:\s*([0-9a-fA-F]{7,40})\b/im);
  return match?.[1] ?? null;
}

function resolveCoderSubmittedCommitSha(
  projectPath: string,
  coderOutput: string,
  options: { requireExplicitToken?: boolean } = {}
): string | undefined {
  const tokenSha = extractSubmissionCommitToken(coderOutput);
  if (tokenSha && isCommitReachableWithFetch(projectPath, tokenSha, { forceFetch: true })) {
    try {
      return execSync(`git rev-parse ${tokenSha}^{commit}`, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return tokenSha;
    }
  }

  if (options.requireExplicitToken) {
    return undefined;
  }

  return getCurrentCommitSha(projectPath) || undefined;
}

export async function runCoderPhase(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  action: 'start' | 'resume',
  jsonMode = false,
  coordinatorCache?: Map<string, CoordinatorResult>,
  coordinatorThresholds?: number[],
  leaseFence?: LeaseFenceContext,
  branchName = 'main'
): Promise<void> {
  if (!task) return;
  refreshParallelWorkstreamLease(projectPath, leaseFence);

  let coordinatorGuidance: string | undefined;
  const thresholds = coordinatorThresholds || [2, 5, 9];
  const persistedMustImplement = getLatestMustImplementGuidance(db, task.id);
  const activeMustImplement =
    persistedMustImplement &&
    task.status === 'in_progress' &&
    task.rejection_count >= persistedMustImplement.rejection_count_watermark
      ? persistedMustImplement
      : null;

  // Run coordinator at rejection thresholds (same as before)
  const shouldInvokeCoordinator = thresholds.includes(task.rejection_count);
  const cachedResult = coordinatorCache?.get(task.id);

  if (activeMustImplement) {
    coordinatorGuidance = activeMustImplement.guidance;
    coordinatorCache?.set(task.id, {
      success: true,
      decision: 'guide_coder',
      guidance: activeMustImplement.guidance,
    });
    if (!jsonMode) {
      console.log(`\nActive MUST_IMPLEMENT override detected (rc=${activeMustImplement.rejection_count_watermark})`);
    }
  }

  if (shouldInvokeCoordinator) {
    if (
      activeMustImplement &&
      task.rejection_count === activeMustImplement.rejection_count_watermark
    ) {
      if (!jsonMode) {
        console.log('\nSkipping coordinator reinvocation in same rejection cycle due to active MUST_IMPLEMENT override');
      }
    } else {
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
      if (activeMustImplement) {
        coordExtra.lockedMustImplementGuidance = activeMustImplement.guidance;
        coordExtra.lockedMustImplementWatermark = activeMustImplement.rejection_count_watermark;
      }

      const coordResult = await invokeCoordinator(task, rejectionHistory, projectPath, coordExtra);
      if (coordResult) {
        const mustKeepOverride =
          activeMustImplement &&
          task.rejection_count > activeMustImplement.rejection_count_watermark;
        const normalizedGuidance = mustKeepOverride && !coordResult.guidance.includes('MUST_IMPLEMENT:')
          ? `${activeMustImplement.guidance}\n\nAdditional coordinator guidance:\n${coordResult.guidance}`
          : coordResult.guidance;

        coordinatorGuidance = normalizedGuidance;
        coordinatorCache?.set(task.id, {
          ...coordResult,
          guidance: normalizedGuidance,
        });

        addAuditEntry(db, task.id, task.status, task.status, 'coordinator', {
          actorType: 'orchestrator',
          notes: `[${coordResult.decision}] ${normalizedGuidance}`,
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
    }
  } else if (cachedResult && !activeMustImplement) {
    coordinatorGuidance = cachedResult.guidance;
    if (!jsonMode && task.rejection_count >= 2) {
      console.log(`\nReusing cached coordinator guidance (decision: ${cachedResult.decision})`);
    }
  }

  // STEP 1: Invoke coder (no status commands in prompt anymore)
  if (!jsonMode) {
    console.log('\n>>> Invoking CODER...\n');
  }

  const initialSha = getCurrentCommitSha(projectPath) || '';
  const coderConfig = loadConfig(projectPath).ai?.coder as ReviewerConfig | undefined;
  const coderResult: CoderResult = await invokeCoder(task, projectPath, action, coordinatorGuidance, leaseFence?.runnerId);

  if (coderResult.timedOut || !coderResult.success) {
    const providerName = coderConfig?.provider ?? loadConfig(projectPath).ai?.coder?.provider ?? 'unknown';
    const modelName = coderConfig?.model ?? loadConfig(projectPath).ai?.coder?.model ?? 'unknown';
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

  // STEP 2: Gather git state
  const commits = getRecentCommits(projectPath, 5, initialSha);
  const files_changed = getChangedFiles(projectPath);
  const has_uncommitted = hasUncommittedChanges(projectPath);
  const diff_summary = getDiffSummary(projectPath);
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
      orchestratorOutput = JSON.stringify({
        action: 'error',
        reasoning: `FALLBACK: Non-retryable orchestrator failure (${orchestratorFailure.type})`,
        commits: [],
        next_status: 'failed',
          files_changed: 0,
          confidence: 'low',
          exit_clean: false,
          has_commits: false,
      });
    } else {
    // Check if coder seems finished even if orchestrator failed
    const isTaskComplete = hasCoderCompletionSignal(coderResult.stdout);
    // Only count as having work if there are actual relevant uncommitted changes,
    // changed files, or recent commits
    const hasWork = hasRelevantChanges;

    if (isTaskComplete && hasWork) {
      orchestratorOutput = JSON.stringify({
        action: has_uncommitted ? 'stage_commit_submit' : 'submit',
        reasoning: 'FALLBACK: Orchestrator failed but coder signaled completion',
        commits: commits.map(c => c.sha),
        next_status: 'review',
          files_changed: files_changed.length,
          confidence: 'low',
          exit_clean: true,
          has_commits: commits.length > 0,
      });
    } else {
      // Fallback to safe default: retry
      orchestratorOutput = JSON.stringify({
        action: 'retry',
        reasoning: 'FALLBACK: Orchestrator failed, defaulting to retry',
        commits: [],
        next_status: 'in_progress',
          files_changed: 0,
          confidence: 'low',
          exit_clean: true,
          has_commits: false,
      });
    }
    }
  }

  // STEP 5: Parse orchestrator output with fallback
  const handler = new OrchestrationFallbackHandler();
  let decision = handler.parseCoderOutput(orchestratorOutput);

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

  // Contract-violation handling (structured-first, legacy-prefix fallback).
  const legacyChecklistViolation = /^CHECKLIST_REQUIRED:/i.test(decision.reasoning || '');
  const legacyRejectionResponseViolation = /^REJECTION_RESPONSE_REQUIRED:/i.test(decision.reasoning || '');
  const contractViolation = decision.contract_violation
    ?? (legacyChecklistViolation ? 'checklist_required' : null)
    ?? (legacyRejectionResponseViolation ? 'rejection_response_required' : null);

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
        contract_violation: contractViolation,
        reasoning: `${marker} ${cleanReason} (retry_limit ${consecutiveContractViolations}/${MAX_CONTRACT_VIOLATION_RETRIES})`,
          confidence: 'low',
          exit_clean: false,
      };
    } else {
      decision = {
        ...decision,
        action: 'retry',
        next_status: 'in_progress',
        contract_violation: contractViolation,
        reasoning: `${marker} ${cleanReason} (retry ${consecutiveContractViolations}/${MAX_CONTRACT_VIOLATION_RETRIES})`,
          confidence: 'medium',
      };
    }
  }

  // Enforce orchestrator authority over weak/unsupported WONT_FIX claims.
  const structuredOverrideItems = Array.isArray(decision.wont_fix_override_items)
    ? decision.wont_fix_override_items.filter(item => typeof item === 'string' && item.trim().length > 0)
    : [];
  const legacyWontFixOverrideMatch = (decision.reasoning || '').match(/WONT_FIX_OVERRIDE:\s*([\s\S]+)/i);
  const fallbackLegacyItems = legacyWontFixOverrideMatch?.[1]
    ? legacyWontFixOverrideMatch[1]
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    : [];
  const overrideItems = structuredOverrideItems.length > 0 ? structuredOverrideItems : fallbackLegacyItems;

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
    };  }

  // STEP 6: Log orchestrator decision for audit trail
  addAuditEntry(db, task.id, task.status, decision.next_status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[${decision.action}] ${decision.reasoning} (confidence: ${decision.confidence})`,
  });

  // STEP 7: Execute the decision
  switch (decision.action) {
    case 'submit':
      {
        const submissionCommitSha = resolveCoderSubmittedCommitSha(projectPath, coderResult.stdout, {
          requireExplicitToken: requiresExplicitSubmissionCommit,
        });
        if (!submissionCommitSha && requiresExplicitSubmissionCommit) {
          addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
            actorType: 'orchestrator',
            notes: '[retry] Awaiting explicit SUBMISSION_COMMIT token for commit recovery',
          });
          if (!jsonMode) {
            console.log('\n⟳ Waiting for explicit SUBMISSION_COMMIT token from coder');
          }
          break;
        }
        if (!submissionCommitSha || !isCommitReachable(projectPath, submissionCommitSha)) {
          updateTaskStatus(
            db,
            task.id,
            'failed',
            'orchestrator',
            'Task failed: cannot submit to review without a valid commit hash'
          );
          if (!jsonMode) {
            console.log('\n✗ Task failed (submission commit missing or not in workspace)');
          }
          break;
        }
        if (leaseFence?.parallelSessionId) {
          const pushResult = pushToRemote(projectPath, 'origin', branchName);
          if (!pushResult.success) {
            updateTaskStatus(
              db,
              task.id,
              'failed',
              'orchestrator',
              `Task failed: cannot publish submission commit ${submissionCommitSha} to ${branchName} before review`
            );
            if (!jsonMode) {
              console.log('\n✗ Task failed (unable to push submission commit to branch for review)');
            }
            break;
          }
        }
        updateTaskStatus(db, task.id, 'review', 'orchestrator', decision.reasoning, submissionCommitSha);
      }
      if (!jsonMode) {
        console.log(`\n✓ Coder complete, submitted to review (confidence: ${decision.confidence})`);
      }
      break;

    case 'stage_commit_submit':
      if (!has_uncommitted) {
        const submissionCommitSha = resolveCoderSubmittedCommitSha(projectPath, coderResult.stdout, {
          requireExplicitToken: requiresExplicitSubmissionCommit,
        });
        if (!submissionCommitSha && requiresExplicitSubmissionCommit) {
          addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
            actorType: 'orchestrator',
            notes: '[retry] Awaiting explicit SUBMISSION_COMMIT token for commit recovery',
          });
          if (!jsonMode) {
            console.log('\n⟳ Waiting for explicit SUBMISSION_COMMIT token from coder');
          }
          break;
        }
        if (!submissionCommitSha || !isCommitReachable(projectPath, submissionCommitSha)) {
          updateTaskStatus(
            db,
            task.id,
            'failed',
            'orchestrator',
            'Task failed: cannot submit to review without a valid commit hash'
          );
          if (!jsonMode) {
            console.log('\n✗ Task failed (submission commit missing or not in workspace)');
          }
          break;
        }
        if (leaseFence?.parallelSessionId) {
          const pushResult = pushToRemote(projectPath, 'origin', branchName);
          if (!pushResult.success) {
            updateTaskStatus(
              db,
              task.id,
              'failed',
              'orchestrator',
              `Task failed: cannot publish submission commit ${submissionCommitSha} to ${branchName} before review`
            );
            if (!jsonMode) {
              console.log('\n✗ Task failed (unable to push submission commit to branch for review)');
            }
            break;
          }
        }
        updateTaskStatus(
          db,
          task.id,
          'review',
          'orchestrator',
          'Auto-commit skipped: no uncommitted changes',
          submissionCommitSha
        );
        if (!jsonMode) {
          console.log('\n✓ Auto-commit skipped (no uncommitted files) and submitted to review');
        }
        break;
      }

      refreshParallelWorkstreamLease(projectPath, leaseFence);
      // Stage all changes
      try {
        execSync('git add -A', { cwd: projectPath, stdio: 'pipe' });
        const message = decision.commit_message || 'feat: implement task specification';
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
          cwd: projectPath,
          stdio: 'pipe'
        });
        const submissionCommitSha = getCurrentCommitSha(projectPath) || undefined;
        if (!submissionCommitSha || !isCommitReachable(projectPath, submissionCommitSha)) {
          updateTaskStatus(
            db,
            task.id,
            'failed',
            'orchestrator',
            'Task failed: auto-committed but commit hash is not in current workspace'
          );
          if (!jsonMode) {
            console.log('\n✗ Task failed (auto-commit hash not in workspace)');
          }
          break;
        }
        if (leaseFence?.parallelSessionId) {
          const pushResult = pushToRemote(projectPath, 'origin', branchName);
          if (!pushResult.success) {
            updateTaskStatus(
              db,
              task.id,
              'failed',
              'orchestrator',
              `Task failed: cannot publish submission commit ${submissionCommitSha} to ${branchName} before review`
            );
            if (!jsonMode) {
              console.log('\n✗ Task failed (unable to push submission commit to branch for review)');
            }
            break;
          }
        }
        updateTaskStatus(
          db,
          task.id,
          'review',
          'orchestrator',
          `Auto-committed and submitted (${decision.reasoning})`,
          submissionCommitSha
        );
        if (!jsonMode) {
          console.log(`\n✓ Auto-committed and submitted to review (confidence: ${decision.confidence})`);
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
        console.log(`\n⟳ Retrying coder (${decision.reasoning}, confidence: ${decision.confidence})`);
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
): Promise<void> {
  if (!task) return;
  refreshParallelWorkstreamLease(projectPath, leaseFence);

  const submissionResolution = resolveSubmissionCommitWithRecovery(
    projectPath,
    getSubmissionCommitShas(db, task.id)
  );
  if (submissionResolution.status !== 'resolved') {
    const attemptsText = submissionResolution.attempts.join(' | ') || 'none';
    updateTaskStatus(
      db,
      task.id,
      'in_progress',
      'orchestrator',
      `[commit_recovery] Missing reachable submission hash (${submissionResolution.reason}; attempts: ${attemptsText}). ` +
      `Treating task as resubmission. Coder must output exact line: SUBMISSION_COMMIT: <sha> for the commit that implements the task.`
    );
    if (!jsonMode) {
      console.log('\n⟳ Reviewer hash missing; returning task to coder for hash resubmission');
    }
    return;
  }
  const submissionCommitSha = submissionResolution.sha;
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

    reviewerResults = await invokeReviewers(
      task,
      projectPath,
      reviewerConfigs,
      coordinatorResult?.guidance,
      coordinatorResult?.decision,
      leaseFence?.runnerId
    );

    const failedReviewerIndex = reviewerResults.findIndex((res) => !res.success || res.timedOut);
    if (failedReviewerIndex !== -1) {
      const failedReviewer = reviewerResults[failedReviewerIndex];
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

    reviewerResult = await invokeReviewer(
      task,
      projectPath,
      coordinatorResult?.guidance,
      coordinatorResult?.decision,
      undefined,
      leaseFence?.runnerId
    );

    if (!reviewerResult.success || reviewerResult.timedOut) {
      const providerName =
        reviewerResult.provider ??
        phaseConfig.ai?.reviewer?.provider ??
        'unknown';
      const modelName =
        reviewerResult.model ??
        phaseConfig.ai?.reviewer?.model ??
        'unknown';
      const output = (reviewerResult.stderr || reviewerResult.stdout || '').trim();
      const failed = await handleProviderInvocationFailure(
        db,
        task.id,
        {
          role: 'reviewer',
          provider: providerName,
          model: modelName,
          exitCode: reviewerResult.exitCode ?? 1,
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

  if (effectiveMultiReviewEnabled) {
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
          reasoning: 'FALLBACK: Multi-reviewer orchestrator failed',
          notes: 'Review unclear, retrying',
          next_status: 'review',
            rejection_count: task.rejection_count,
            confidence: 'low',
            push_to_remote: false,
            repeated_issue: false,
        };
      }
    } else {
      // No merge needed (decision is Approve, Dispute, or Skip)
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
        console.error('Multi-reviewer orchestrator failed (consensus path):', error);
        
        const handler = new OrchestrationFallbackHandler();
        // REQUIRE UNANIMOUS CONSENSUS for the non-reject finalDecision
        const isUnanimousConsensus = reviewerResults.length > 0 && reviewerResults.every(r => {
          if (r.decision === finalDecision) return true;
          return handler.extractExplicitReviewerDecision(r.stdout) === finalDecision;
        });

        if (isUnanimousConsensus) {
          const primaryResult = reviewerResults.find(r => r.decision === finalDecision) || reviewerResults[0];
          decision = {
            decision: (finalDecision === 'unclear' ? 'unclear' : finalDecision) as any,
            reasoning: `FALLBACK: Multi-reviewer orchestrator failed but all reviewers reached consensus: ${finalDecision}`,
            notes: primaryResult?.notes || primaryResult?.stdout || 'No notes provided',
            next_status: finalDecision === 'approve' ? 'completed' : 
                         finalDecision === 'reject' ? 'in_progress' : 
                         finalDecision === 'dispute' ? 'disputed' :
                         finalDecision === 'skip' ? 'skipped' : 'review',
            rejection_count: task.rejection_count,
            confidence: 'low',
            push_to_remote: ['approve', 'dispute', 'skip'].includes(finalDecision),
            repeated_issue: false,
          };
        } else {
          decision = {
            decision: 'unclear',
            reasoning: 'FALLBACK: Multi-reviewer orchestrator failed and no unanimous consensus',
            notes: 'Review unclear, retrying',
            next_status: 'review',
            rejection_count: task.rejection_count,
            confidence: 'low',
            push_to_remote: false,
            repeated_issue: false,
          };
        }
      }
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

    try {
      const orchestratorOutput = await invokeReviewerOrchestrator(context, projectPath);
      const handler = new OrchestrationFallbackHandler();
      decision = handler.parseReviewerOutput(orchestratorOutput);

      // If orchestrator returned unclear, check reviewer stdout for explicit decision token
      if (decision.decision === 'unclear') {
        const reviewerStdout = reviewerResult?.stdout ?? '';
        const explicitDecision = handler.extractExplicitReviewerDecision(reviewerStdout);
        if (explicitDecision) {
          decision = {
            decision: explicitDecision,
            reasoning: `FALLBACK: Orchestrator unclear but reviewer explicitly signaled ${explicitDecision.toUpperCase()}`,
            notes: reviewerStdout,
            next_status: explicitDecision === 'approve' ? 'completed' :
                         explicitDecision === 'reject' ? 'in_progress' :
                         explicitDecision === 'dispute' ? 'disputed' :
                         explicitDecision === 'skip' ? 'skipped' : 'review',
            rejection_count: task.rejection_count,
            confidence: 'medium',
            push_to_remote: ['approve', 'dispute', 'skip'].includes(explicitDecision),
            repeated_issue: false,
          };
        }
      }
    } catch (error) {
      console.error('Orchestrator invocation failed:', error);
      const orchestratorFailure = await classifyOrchestratorFailure(error, projectPath);
      
      const handler = new OrchestrationFallbackHandler();
      const reviewerStdout = reviewerResult?.stdout ?? '';
      const explicitDecision = handler.extractExplicitReviewerDecision(reviewerStdout);
      const failureReason = orchestratorFailure
        ? `${orchestratorFailure.type}: ${orchestratorFailure.message}`
        : summarizeErrorMessage(error);
      
      if (explicitDecision) {
        decision = {
          decision: explicitDecision,
          reasoning: `FALLBACK: Orchestrator failed (${failureReason}) but reviewer explicitly signaled ${explicitDecision.toUpperCase()}`,
          notes: reviewerStdout,
          next_status: explicitDecision === 'approve' ? 'completed' : 
                       explicitDecision === 'reject' ? 'in_progress' : 
                       explicitDecision === 'dispute' ? 'disputed' :
                       explicitDecision === 'skip' ? 'skipped' : 'review',
          rejection_count: task.rejection_count,
          confidence: 'low',
          push_to_remote: ['approve', 'dispute', 'skip'].includes(explicitDecision),
          repeated_issue: false,
        };
      } else {
        decision = {
          decision: 'unclear',
          reasoning: `FALLBACK: Orchestrator failed (${failureReason}), retrying review`,
          notes: 'Review unclear, retrying',
          next_status: 'review',
            rejection_count: task.rejection_count,
            confidence: 'low',
            push_to_remote: false,
            repeated_issue: false,
        };
      }
    }
  }

  // STEP 4: Fallback for unclear decisions (catches ALL unclear, not just orchestrator parse failures)
  if (decision.decision === 'unclear') {
    const consecutiveParseFallbackRetries =
      countConsecutiveUnclearEntries(db, task.id) + 1;

    if (consecutiveParseFallbackRetries >= MAX_ORCHESTRATOR_PARSE_RETRIES) {
      decision = {
        ...decision,
        decision: 'dispute',
        reasoning: `Orchestrator parse failed ${consecutiveParseFallbackRetries} times; escalating to dispute`,
        notes: 'Escalated to disputed to prevent endless unclear-review retries',
        next_status: 'disputed',
          confidence: 'low',
          push_to_remote: false,
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
    notes: `[${decision.decision}] ${decision.reasoning} (confidence: ${decision.confidence})`,
  });

  // STEP 5.5: Create follow-up tasks if any (ONLY on approval)
  if (decision.decision === 'approve' && decision.follow_up_tasks && decision.follow_up_tasks.length > 0) {
    const followUpConfig = loadConfig(projectPath);
    const depth = getFollowUpDepth(db, task.id);
    const maxDepth = followUpConfig.followUpTasks?.maxDepth ?? 2;

    if (depth < maxDepth) {
      for (const followUp of decision.follow_up_tasks) {
        try {
          const nextDepth = depth + 1;
          
          // Policy: Auto-implement depth 1 if configured. 
          // Depth 2+ always requires human promotion (approval).
          let requiresPromotion = true;
          if (nextDepth === 1 && followUpConfig.followUpTasks?.autoImplementDepth1) {
            requiresPromotion = false;
          }

          const followUpId = createFollowUpTask(db, {
            title: followUp.title,
            description: followUp.description,
            sectionId: task.section_id,
            referenceTaskId: task.id,
            referenceCommit: submissionCommitSha,
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
  const commitSha = submissionCommitSha;

  switch (decision.decision) {
    case 'approve':
      approveTask(db, task.id, 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n✓ Task APPROVED (confidence: ${decision.confidence})`);
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
        console.log(`\n✗ Task REJECTED (${task.rejection_count + 1}/15, confidence: ${decision.confidence})`);
        console.log('Returning to coder for fixes.');
      }
      break;

    case 'dispute':
      updateTaskStatus(db, task.id, 'disputed', 'orchestrator', decision.notes, commitSha);
      if (!jsonMode) {
        console.log(`\n! Task DISPUTED (confidence: ${decision.confidence})`);
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
