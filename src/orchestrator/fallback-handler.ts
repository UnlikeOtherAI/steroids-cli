/**
 * Strict parser and signal extractor for orchestrator output
 */

import { CoderOrchestrationResult, ReviewerOrchestrationResult } from './types.js';
import { 
  validateCoderResultWithLogging,
  validateReviewerResultWithLogging
} from './schemas.js';

export class OrchestrationFallbackHandler {

  private hasCompletionIndicator(lowerOutput: string): boolean {
    if (/\b(?:not|no|not yet|still not|cannot|can't|unable to)\s+(?:task\s+)?(?:is\s+)?(?:complete|complete[d]?|finished|done|ready)\b/.test(lowerOutput)) {
      return false;
    }

    return /\b(?:task\s+)?(?:is\s+)?(?:complete|complete[d]?|implemented|finished|done|ready for review|ready)\b/.test(
      lowerOutput
    );
  }

  private hasCommitIndicator(lowerOutput: string): boolean {
    if (/\b(commit|committed)\b.*\b(?:fail|failed|failure|error|unable|cannot|denied|rejected|blocked|aborted)\b/.test(
      lowerOutput
    )) {
      return false;
    }

    if (/\b(?:fail|failed|error|unable|cannot|denied|rejected|blocked|aborted)\b.*\b(commit|committed)\b/.test(lowerOutput)) {
      return false;
    }

    return /\b(committed|commit)\b/.test(lowerOutput);
  }

  private hasErrorIndicator(lowerOutput: string): boolean {
    return /\b(fatal|error|failed)\b/.test(lowerOutput);
  }

  public extractExplicitReviewerDecision(
    output: string
  ): 'approve' | 'reject' | 'dispute' | 'skip' | null {
    const map: Record<string, 'approve' | 'reject' | 'dispute' | 'skip'> = {
      APPROVE: 'approve',
      REJECT: 'reject',
      DISPUTE: 'dispute',
      SKIP: 'skip',
    };

    const decisionPattern = /(?:^|[\n\r])\s*(?:\*\*)?DECISION(?:\*\*)?\s*(?::|-)\s*(APPROVE|REJECT|DISPUTE|SKIP)\b/gim;
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = decisionPattern.exec(output)) !== null) {
      lastMatch = match;
    }
    if (lastMatch?.[1]) {
      return map[lastMatch[1].toUpperCase()] ?? null;
    }

    const lines = output.split(/[\n\r]+/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const token = line.match(/^(APPROVE|REJECT|DISPUTE|SKIP)\b/i)?.[1];
      if (token) {
        return map[token.toUpperCase()] ?? null;
      }
      break; 
    }

    return null;
  }

  /**
   * Parse coder orchestrator output with strict JSON and signal extractor fallback
   */
  parseCoderOutput(rawOutput: string): CoderOrchestrationResult {
    // Layer 1: Direct JSON parse
    try {
      const parsed = JSON.parse(rawOutput);
      const { valid, data } = validateCoderResultWithLogging(parsed);
      if (valid) {
        console.log('[Orchestrator] ✓ Layer 1: Direct JSON parse succeeded');
        return data as CoderOrchestrationResult;
      }
    } catch (e) {}

    // Layer 2: Extract from markdown code block
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        const { valid, data } = validateCoderResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 2: Markdown extraction succeeded');
          return data as CoderOrchestrationResult;
        }
      } catch (e) {}
    }

    // Layer 3: Substring extraction
    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(rawOutput.substring(start, end + 1));
        const { valid, data } = validateCoderResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 3: Substring extraction succeeded');
          return data as CoderOrchestrationResult;
        }
      } catch (e) {}
    }

    // Layer 4: Signal Extractor
    console.warn('[Orchestrator] ⚠ Layer 4: Using Signal Extractor fallback (all JSON parsing failed)');
    return this.signalExtractorCoder(rawOutput);
  }

  /**
   * Parse reviewer orchestrator output with strict JSON and signal extractor fallback
   */
  parseReviewerOutput(rawOutput: string): ReviewerOrchestrationResult {
    // Layer 1: Direct JSON parse
    try {
      const parsed = JSON.parse(rawOutput);
      const { valid, data } = validateReviewerResultWithLogging(parsed);
      if (valid) {
        console.log('[Orchestrator] ✓ Layer 1: Direct JSON parse succeeded');
        return data as ReviewerOrchestrationResult;
      }
    } catch (e) {}

    // Layer 2: Extract from markdown code block
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        const { valid, data } = validateReviewerResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 2: Markdown extraction succeeded');
          return data as ReviewerOrchestrationResult;
        }
      } catch (e) {}
    }

    // Layer 3: Substring extraction
    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(rawOutput.substring(start, end + 1));
        const { valid, data } = validateReviewerResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 3: Substring extraction succeeded');
          return data as ReviewerOrchestrationResult;
        }
      } catch (e) {}
    }

    // Layer 4: Signal Extractor
    console.warn('[Orchestrator] ⚠ Layer 4: Using Signal Extractor fallback (all JSON parsing failed)');
    return this.signalExtractorReviewer(rawOutput);
  }

  /**
   * Signal Extractor for Coder (Replaces fragile JSON repair)
   */
  private signalExtractorCoder(output: string): CoderOrchestrationResult {
    const lower = output.toLowerCase();

    if (/timeout|timed out/.test(lower)) {
      return {
        action: 'retry',
        reasoning: 'FALLBACK: Detected timeout',
        commits: [],
        next_status: 'in_progress',
        files_changed: 0,
        confidence: 'low',
        exit_clean: false,
        has_commits: false
      };
    }

    if (this.hasErrorIndicator(lower) && !this.hasCommitIndicator(lower)) {
      return {
        action: 'error',
        reasoning: 'FALLBACK: Detected error keywords',
        commits: [],
        next_status: 'failed',
        files_changed: 0,
        confidence: 'low',
        exit_clean: false,
        has_commits: false
      };
    }

    if (this.hasCommitIndicator(lower) && !this.hasErrorIndicator(lower)) {
      return {
        action: 'submit',
        reasoning: 'FALLBACK: Detected commit keywords',
        commits: [],
        next_status: 'review',
        files_changed: 0,
        confidence: 'low',
        exit_clean: true,
        has_commits: false
      };
    }

    if (this.hasCompletionIndicator(lower)) {
      return {
        action: 'submit',
        reasoning: 'FALLBACK: Detected completion keywords',
        commits: [],
        next_status: 'review',
        files_changed: 0,
        confidence: 'low',
        exit_clean: true,
        has_commits: false
      };
    }

    return {
      action: 'retry',
      reasoning: 'FALLBACK: Orchestrator failed, defaulting to retry',
      commits: [],
      next_status: 'in_progress',
      files_changed: 0,
      confidence: 'low',
      exit_clean: true,
      has_commits: false
    };
  }

  /**
   * Signal Extractor for Reviewer (Replaces fragile JSON repair)
   */
  private signalExtractorReviewer(output: string): ReviewerOrchestrationResult {
    const decision = this.extractExplicitReviewerDecision(output);
    
    if (decision === 'approve') {
      return {
        decision: 'approve',
        reasoning: 'FALLBACK: Explicit DECISION token APPROVE',
        notes: 'Approved based on explicit reviewer decision token',
        next_status: 'completed',
        rejection_count: 0,
        confidence: 'low',
        push_to_remote: true,
        repeated_issue: false
      };
    }
    if (decision === 'reject') {
      return {
        decision: 'reject',
        reasoning: 'FALLBACK: Explicit DECISION token REJECT',
        notes: 'Rejected - see reviewer output for details',
        next_status: 'in_progress',
        rejection_count: 0,
        confidence: 'low',
        push_to_remote: false,
        repeated_issue: false
      };
    }
    if (decision === 'dispute') {
      return {
        decision: 'dispute',
        reasoning: 'FALLBACK: Explicit DECISION token DISPUTE',
        notes: 'Dispute detected - human decision needed',
        next_status: 'disputed',
        rejection_count: 0,
        confidence: 'low',
        push_to_remote: false,
        repeated_issue: false
      };
    }
    if (decision === 'skip') {
      return {
        decision: 'skip',
        reasoning: 'FALLBACK: Explicit DECISION token SKIP',
        notes: 'Task skipped',
        next_status: 'skipped',
        rejection_count: 0,
        confidence: 'low',
        push_to_remote: true,
        repeated_issue: false
      };
    }

    return {
      decision: 'unclear',
      reasoning: 'FALLBACK: Missing explicit reviewer decision token',
      notes: 'Review unclear, retrying with explicit decision requirement',
      next_status: 'review',
      rejection_count: 0,
      confidence: 'low',
      push_to_remote: false,
      repeated_issue: false
    };
  }
}
