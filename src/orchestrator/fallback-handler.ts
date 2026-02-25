/**
 * Fallback handler wrapping SignalParser for text-signal routing.
 * Parses plain-text STATUS/DECISION/REASON/CONFIDENCE signals from orchestrator output.
 */

import { CoderOrchestrationResult, ReviewerOrchestrationResult } from './types.js';
import { SignalParser } from './signal-parser.js';
import type { CoderSignal } from './signal-parser.js';

const ACTION_MAP: Record<CoderSignal, CoderOrchestrationResult['action']> = {
  review: 'submit',
  retry: 'retry',
  error: 'error',
  unclear: 'retry',
};

const STATUS_MAP: Record<CoderSignal, CoderOrchestrationResult['next_status']> = {
  review: 'review',
  retry: 'in_progress',
  error: 'failed',
  unclear: 'in_progress',
};

export class OrchestrationFallbackHandler {
  parseCoderOutput(rawOutput: string): CoderOrchestrationResult {
    const signal = SignalParser.parseCoderSignal(rawOutput);
    const reason = SignalParser.extractReason(rawOutput);
    const confidence = SignalParser.extractConfidence(rawOutput);
    const commitMessage = SignalParser.extractCommitMessage(rawOutput);

    return {
      action: ACTION_MAP[signal],
      reasoning: reason || `SignalParser detected ${signal === 'unclear' ? 'unclear status' : `STATUS: ${signal.toUpperCase()}`}`,
      commits: [],          // caller fills from git state
      commit_message: commitMessage ?? undefined,
      next_status: STATUS_MAP[signal],
      files_changed: 0,     // caller fills from git state
      confidence: signal === 'unclear' ? 'low' : confidence,
      exit_clean: signal !== 'error',
      has_commits: false,    // caller fills from git state
    };
  }

  parseReviewerOutput(rawOutput: string): ReviewerOrchestrationResult {
    const result = SignalParser.parseReviewerSignal(rawOutput);
    const confidence = SignalParser.extractConfidence(rawOutput);

    let nextStatus: 'completed' | 'in_progress' | 'disputed' | 'skipped' | 'review' = 'review';
    if (result.decision === 'approve') nextStatus = 'completed';
    if (result.decision === 'reject') nextStatus = 'in_progress';
    if (result.decision === 'dispute') nextStatus = 'disputed';
    if (result.decision === 'skip') nextStatus = 'skipped';

    return {
      decision: result.decision,
      reasoning: `SignalParser detected ${result.decision}`,
      notes: result.notes,
      follow_up_tasks: result.followUpTasks,
      next_status: nextStatus,
      rejection_count: 0,
      confidence: result.decision === 'unclear' ? 'low' : confidence,
      push_to_remote: false,
      repeated_issue: false
    };
  }

  extractExplicitReviewerDecision(output: string): 'approve' | 'reject' | 'dispute' | 'skip' | null {
    const result = SignalParser.parseReviewerSignal(output);
    return result.decision === 'unclear' ? null : result.decision;
  }
}
