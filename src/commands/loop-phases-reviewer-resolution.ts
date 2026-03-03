/**
 * Reviewer decision resolution
 * Extracted from loop-phases-reviewer.ts to keep that file under 500 lines.
 */

import {
  resolveDecision,
  type ReviewerResult,
} from '../orchestrator/reviewer.js';
import {
  invokeReviewerOrchestrator,
  invokeMultiReviewerOrchestrator,
} from '../orchestrator/invoke.js';
import { OrchestrationFallbackHandler } from '../orchestrator/fallback-handler.js';
import type {
  MultiReviewerContext,
  ReviewerContext,
  ReviewerOrchestrationResult,
} from '../orchestrator/types.js';
import {
  classifyOrchestratorFailure,
  summarizeErrorMessage,
} from './loop-phases-helpers.js';

const MAX_MULTI_REVIEW_ARBITRATION_ATTEMPTS = 2;

function mergeRejectNotes(reviewerResults: ReviewerResult[]): string {
  const rejectors = reviewerResults.filter(r => r.decision === 'reject');
  const checklistSet = new Set<string>();

  for (const result of rejectors) {
    const lines = (result.stdout ?? '').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*]\s*\[\s*[x ]?\s*\]\s+/.test(trimmed)) {
        checklistSet.add(trimmed);
      }
    }
  }

  if (checklistSet.size > 0) {
    return [
      '## Merged Review Findings',
      ...Array.from(checklistSet),
    ].join('\n');
  }

  // If no structured checklist is present, preserve full rejector outputs.
  return rejectors
    .map((r, i) => `## Reviewer ${i + 1} Reject Notes\n${(r.stdout ?? '').trim()}`)
    .join('\n\n')
    .trim();
}

function toDecisionPayload(
  decision: ReviewerOrchestrationResult['decision'],
  taskRejectionCount: number,
  reasoning: string,
  notes: string,
  confidence: ReviewerOrchestrationResult['confidence'],
  followUpTasks?: ReviewerOrchestrationResult['follow_up_tasks']
): ReviewerOrchestrationResult {
  const nextStatus: ReviewerOrchestrationResult['next_status'] =
    decision === 'approve' ? 'completed' :
    decision === 'reject' ? 'in_progress' :
    decision === 'dispute' ? 'disputed' :
    decision === 'skip' ? 'skipped' : 'review';

  return {
    decision,
    reasoning,
    notes,
    next_status: nextStatus,
    rejection_count: taskRejectionCount,
    confidence,
    push_to_remote: decision === 'approve' || decision === 'dispute',
    repeated_issue: false,
    follow_up_tasks: followUpTasks,
  };
}

export function getArbitrationContractViolation(
  parsed: ReviewerOrchestrationResult,
  hasReject: boolean,
  hasDispute: boolean,
  hasSkip: boolean,
  hasUndefined: boolean,
  attempt: number
): string | null {
  if (parsed.decision === 'unclear') {
    return `no_decision_token (attempt ${attempt})`;
  }
  if (parsed.decision === 'skip') {
    return `contract_violation_skip_not_allowed (attempt ${attempt})`;
  }
  if (!hasDispute && hasReject && parsed.decision === 'dispute') {
    return `contract_violation_dispute_without_reviewer_dispute (attempt ${attempt})`;
  }
  if ((hasReject || hasDispute || hasSkip || hasUndefined) && parsed.decision === 'approve' && parsed.confidence !== 'high') {
    return `contract_violation_low_confidence_approve (attempt ${attempt})`;
  }
  if (parsed.decision === 'reject' && !parsed.notes.trim()) {
    return `contract_violation_empty_reject_notes (attempt ${attempt})`;
  }
  return null;
}

/**
 * Resolve a reviewer decision from one or more reviewer results.
 * Handles single-reviewer and multi-reviewer flows, including orchestrator
 * fallbacks and unanimous-consensus detection.
 */
export async function resolveReviewerDecision(
  task: { id: string; title: string; rejection_count: number },
  projectPath: string,
  reviewerResult: ReviewerResult | undefined,
  reviewerResults: ReviewerResult[],
  effectiveMultiReviewEnabled: boolean,
  gitContext: {
    commit_sha: string;
    files_changed: string[];
    additions: number;
    deletions: number;
  }
): Promise<ReviewerOrchestrationResult> {
  let decision: ReviewerOrchestrationResult;

  if (effectiveMultiReviewEnabled) {
    const resolution = resolveDecision(reviewerResults);
    const hasReject = reviewerResults.some(r => r.decision === 'reject');
    const hasDispute = reviewerResults.some(r => r.decision === 'dispute');
    const hasSkip = reviewerResults.some(r => r.decision === 'skip');
    const hasUndefined = reviewerResults.some(r => r.decision === undefined);

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

    if (resolution.route === 'direct') {
      if (resolution.decision === 'unclear') {
        decision = toDecisionPayload(
          'unclear',
          task.rejection_count,
          `Multi-reviewer result has no explicit resolvable signal (${reviewerResults.length} reviewers)`,
          '',
          'low'
        );
      } else {
        const primaryResult =
          reviewerResults.find(r => r.decision === resolution.decision) ?? reviewerResults[0];
        const confidence: 'high' | 'medium' | 'low' =
          resolution.decision === 'approve' || resolution.decision === 'skip' ? 'high' : 'medium';
        const notes = resolution.decision === 'reject'
          ? (primaryResult?.stdout ?? 'See reviewer output for details')
          : (primaryResult?.notes ?? '');
        decision = toDecisionPayload(
          resolution.decision,
          task.rejection_count,
          `Direct multi-review resolution: ${resolution.decision}`,
          notes,
          confidence
        );
      }
    } else if (resolution.route === 'local_reject_merge') {
      decision = toDecisionPayload(
        'reject',
        task.rejection_count,
        `All ${reviewerResults.length} reviewers rejected; merged checklist deterministically`,
        mergeRejectNotes(reviewerResults),
        'high'
      );
    } else {
      const handler = new OrchestrationFallbackHandler();
      let arbitrationResult: ReviewerOrchestrationResult | null = null;
      let arbitrationFailureReason = 'unknown';

      for (let attempt = 1; attempt <= MAX_MULTI_REVIEW_ARBITRATION_ATTEMPTS; attempt++) {
        try {
          const orchestratorOutput = await invokeMultiReviewerOrchestrator(multiContext, projectPath);
          const parsed = handler.parseReviewerOutput(orchestratorOutput);
          const contractViolation = getArbitrationContractViolation(
            parsed,
            hasReject,
            hasDispute,
            hasSkip,
            hasUndefined,
            attempt
          );
          if (contractViolation) {
            arbitrationFailureReason = contractViolation;
            continue;
          }
          arbitrationResult = parsed;
          break;
        } catch (error) {
          arbitrationFailureReason = summarizeErrorMessage(error);
        }
      }

      if (arbitrationResult) {
        decision = {
          ...arbitrationResult,
          rejection_count: task.rejection_count,
          next_status:
            arbitrationResult.decision === 'approve' ? 'completed' :
            arbitrationResult.decision === 'reject' ? 'in_progress' :
            arbitrationResult.decision === 'dispute' ? 'disputed' :
            arbitrationResult.decision === 'skip' ? 'skipped' : 'review',
          push_to_remote: arbitrationResult.decision === 'approve' || arbitrationResult.decision === 'dispute',
          repeated_issue: false,
        };
      } else if (hasReject && !hasDispute) {
        decision = toDecisionPayload(
          'reject',
          task.rejection_count,
          `FALLBACK: arbitration failed (${arbitrationFailureReason}); applying safe reject fallback`,
          mergeRejectNotes(reviewerResults),
          'low'
        );
      } else {
        decision = toDecisionPayload(
          'dispute',
          task.rejection_count,
          `FALLBACK: arbitration failed (${arbitrationFailureReason}); escalating to dispute`,
          'ARBITRATION_FAILED: Unable to resolve multi-review disagreement deterministically.',
          'low'
        );
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
            next_status:
              explicitDecision === 'approve' ? 'completed' :
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
          next_status:
            explicitDecision === 'approve' ? 'completed' :
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

  return decision;
}
