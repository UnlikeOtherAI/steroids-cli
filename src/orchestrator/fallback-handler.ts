/**
 * Fallback handler for orchestrator output parsing
 * Multi-layer parsing strategy to handle invalid JSON
 */

import { CoderOrchestrationResult, ReviewerOrchestrationResult } from './types.js';
import { validateCoderResult, validateReviewerResult } from './schemas.js';

export class OrchestrationFallbackHandler {
  /**
   * Parse coder orchestrator output with multi-layer fallback
   */
  parseCoderOutput(rawOutput: string): CoderOrchestrationResult {
    // Layer 1: Direct JSON parse
    try {
      const parsed = JSON.parse(rawOutput);
      if (validateCoderResult(parsed)) {
        return parsed as unknown as CoderOrchestrationResult;
      }
    } catch {}

    // Layer 2: Extract from markdown code block
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        if (validateCoderResult(parsed)) {
          return parsed as unknown as CoderOrchestrationResult;
        }
      } catch {}
    }

    // Layer 3: Find first { to last }
    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(rawOutput.substring(start, end + 1));
        if (validateCoderResult(parsed)) {
          return parsed as unknown as CoderOrchestrationResult;
        }
      } catch {}
    }

    // Layer 4: Keyword fallback
    return this.keywordFallbackCoder(rawOutput);
  }

  /**
   * Parse reviewer orchestrator output with multi-layer fallback
   */
  parseReviewerOutput(rawOutput: string): ReviewerOrchestrationResult {
    // Layer 1: Direct JSON parse
    try {
      const parsed = JSON.parse(rawOutput);
      if (validateReviewerResult(parsed)) {
        return parsed as unknown as ReviewerOrchestrationResult;
      }
    } catch {}

    // Layer 2: Extract from markdown code block
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        if (validateReviewerResult(parsed)) {
          return parsed as unknown as ReviewerOrchestrationResult;
        }
      } catch {}
    }

    // Layer 3: Find first { to last }
    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(rawOutput.substring(start, end + 1));
        if (validateReviewerResult(parsed)) {
          return parsed as unknown as ReviewerOrchestrationResult;
        }
      } catch {}
    }

    // Layer 4: Keyword fallback
    return this.keywordFallbackReviewer(rawOutput);
  }

  /**
   * Keyword-based fallback for coder orchestrator
   */
  private keywordFallbackCoder(output: string): CoderOrchestrationResult {
    const lower = output.toLowerCase();

    // Check for timeout
    if (/timeout|timed out/.test(lower)) {
      return {
        action: 'retry',
        reasoning: 'FALLBACK: Detected timeout',
        commits: [],
        next_status: 'in_progress',
        metadata: {
          files_changed: 0,
          confidence: 'low',
          exit_clean: false,
          has_commits: false
        }
      };
    }

    // Check for errors
    if (/fatal|error|failed/.test(lower) && !/commit/.test(lower)) {
      return {
        action: 'error',
        reasoning: 'FALLBACK: Detected error keywords',
        commits: [],
        next_status: 'failed',
        metadata: {
          files_changed: 0,
          confidence: 'low',
          exit_clean: false,
          has_commits: false
        }
      };
    }

    // Check for completion with commit
    if (/commit|committed/.test(lower) && !/error|failed/.test(lower)) {
      return {
        action: 'submit',
        reasoning: 'FALLBACK: Detected commit keywords',
        commits: [],
        next_status: 'review',
        metadata: {
          files_changed: 0,
          confidence: 'low',
          exit_clean: true,
          has_commits: false
        }
      };
    }

    // Check for completion signals
    if (/complete|finished|done|ready/.test(lower)) {
      return {
        action: 'submit',
        reasoning: 'FALLBACK: Detected completion keywords',
        commits: [],
        next_status: 'review',
        metadata: {
          files_changed: 0,
          confidence: 'low',
          exit_clean: true,
          has_commits: false
        }
      };
    }

    // Safe default: retry
    return {
      action: 'retry',
      reasoning: 'FALLBACK: Orchestrator failed, defaulting to retry',
      commits: [],
      next_status: 'in_progress',
      metadata: {
        files_changed: 0,
        confidence: 'low',
        exit_clean: true,
        has_commits: false
      }
    };
  }

  /**
   * Keyword-based fallback for reviewer orchestrator
   */
  private keywordFallbackReviewer(output: string): ReviewerOrchestrationResult {
    const lower = output.toLowerCase();

    // Check for approval
    if (/(lgtm|approve|looks good|approved)/.test(lower) && !/reject|issues|needs work/.test(lower)) {
      return {
        decision: 'approve',
        reasoning: 'FALLBACK: Detected approval keywords',
        notes: 'Approved based on keyword detection',
        next_status: 'completed',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: true,
          repeated_issue: false
        }
      };
    }

    // Check for rejection
    if (/reject|issues|needs work|fix|problem/.test(lower)) {
      return {
        decision: 'reject',
        reasoning: 'FALLBACK: Detected rejection keywords',
        notes: 'Rejected - see full reviewer output for details',
        next_status: 'in_progress',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: false,
          repeated_issue: false
        }
      };
    }

    // Check for dispute
    if (/dispute|disagree|out of scope/.test(lower)) {
      return {
        decision: 'dispute',
        reasoning: 'FALLBACK: Detected dispute keywords',
        notes: 'Dispute detected - human decision needed',
        next_status: 'disputed',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: false,
          repeated_issue: false
        }
      };
    }

    // Check for skip
    if (/skip|no changes|nothing to review/.test(lower)) {
      return {
        decision: 'skip',
        reasoning: 'FALLBACK: Detected skip keywords',
        notes: 'Task skipped',
        next_status: 'skipped',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: true,
          repeated_issue: false
        }
      };
    }

    // Safe default: unclear
    return {
      decision: 'unclear',
      reasoning: 'FALLBACK: Orchestrator failed, retrying review',
      notes: 'Review unclear, retrying',
      next_status: 'review',
      metadata: {
        rejection_count: 0,
        confidence: 'low',
        push_to_remote: false,
        repeated_issue: false
      }
    };
  }
}
