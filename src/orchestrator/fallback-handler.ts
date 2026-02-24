/**
 * Legacy fallback handler wrapping the new SignalParser.
 * This file will be fully replaced in Task 5/6 when loop-phases is refactored,
 * but for now it bridges the gap to allow deleting schemas.ts.
 */

import { CoderOrchestrationResult, ReviewerOrchestrationResult } from './types.js';
import { SignalParser } from './signal-parser.js';

export class OrchestrationFallbackHandler {
  parseCoderOutput(rawOutput: string): CoderOrchestrationResult {
    const signal = SignalParser.parseCoderSignal(rawOutput);

    if (signal === 'review') {
      return {
        action: 'submit',
        reasoning: 'SignalParser detected STATUS: REVIEW',
        commits: [],
        next_status: 'review',
        files_changed: 1,
        confidence: 'high',
        exit_clean: true,
        has_commits: false
      };
    }

    return {
      action: 'retry',
      reasoning: 'SignalParser detected unclear status',
      commits: [],
      next_status: 'in_progress',
      files_changed: 0,
      confidence: 'low',
      exit_clean: true,
      has_commits: false
    };
  }

  parseReviewerOutput(rawOutput: string): ReviewerOrchestrationResult {
    const result = SignalParser.parseReviewerSignal(rawOutput);
    
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
      confidence: 'high',
      push_to_remote: false,
      repeated_issue: false
    };
  }

  extractExplicitReviewerDecision(output: string): 'approve' | 'reject' | 'dispute' | 'skip' | null {
    const result = SignalParser.parseReviewerSignal(output);
    return result.decision === 'unclear' ? null : result.decision;
  }
}
