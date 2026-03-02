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
    const { decision: finalDecision, needsMerge } = resolveDecision(reviewerResults);

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

    if (needsMerge) {
      // Invoke multi-reviewer orchestrator to merge notes
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
      // finalDecision is the deterministic result from resolveDecision().
      // needsMerge:false covers: consensus (approve/skip), any-dispute, single-rejector, unclear.
      // Note: this path does NOT populate follow_up_tasks — ReviewerResult doesn't carry them.

      // Explicit unclear guard — resolveDecision returns unclear when: empty results,
      // approve+skip mix, or undefined-decision mix. ReviewerResult.decision never includes
      // 'unclear', so .find() below would always miss it.
      if (finalDecision === 'unclear') {
        decision = {
          decision: 'unclear',
          reasoning: `Multi-reviewer result is ambiguous (${reviewerResults.length} reviewers, no decisive outcome)`,
          notes: '',
          next_status: 'review',
          rejection_count: task.rejection_count,
          confidence: 'low',
          push_to_remote: false,
          repeated_issue: false,
        };
      } else {
        const primaryResult =
          reviewerResults.find(r => r.decision === finalDecision) ?? reviewerResults[0];

        // For reject: parsed notes are often a weak single-line extraction; fall back to raw
        // stdout (capped) so the coder gets the actual rejection checklist.
        // For approve/skip/dispute: short notes or empty string is fine.
        const notesForDecision =
          finalDecision === 'reject'
            ? (primaryResult?.notes && primaryResult.notes !== 'See reviewer output for details'
                ? primaryResult.notes
                : (primaryResult?.stdout?.slice(-3000) ?? 'See reviewer output for details'))
            : (primaryResult?.notes ?? '');

        // approve/skip = full consensus → high
        // dispute = any-one-disputes (not all), reject = single-rejector → both medium
        const confidenceForDecision: 'high' | 'medium' | 'low' =
          finalDecision === 'approve' || finalDecision === 'skip' ? 'high' : 'medium';

        const reasoningForDecision =
          finalDecision === 'approve' || finalDecision === 'skip'
            ? `All ${reviewerResults.length} reviewers agreed: ${finalDecision}`
            : finalDecision === 'dispute'
            ? `Reviewer escalated to dispute (${reviewerResults.length} reviewers)`
            : `Single-rejector reject, needsMerge=false (${reviewerResults.length} reviewers)`;

        const nextStatusForDecision: ReviewerOrchestrationResult['next_status'] =
          finalDecision === 'approve' ? 'completed'   :
          finalDecision === 'reject'  ? 'in_progress' :
          finalDecision === 'dispute' ? 'disputed'     :
          finalDecision === 'skip'    ? 'skipped'      : 'review';

        decision = {
          decision: finalDecision,
          reasoning: reasoningForDecision,
          notes: notesForDecision,
          next_status: nextStatusForDecision,
          rejection_count: task.rejection_count,
          confidence: confidenceForDecision,
          // skip does not push in the runtime switch-case; field is currently unused but set accurately
          push_to_remote: finalDecision === 'approve' || finalDecision === 'dispute',
          repeated_issue: false,
        };
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
