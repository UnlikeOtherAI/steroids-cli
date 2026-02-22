/**
 * Fallback handler for orchestrator output parsing
 * Multi-layer parsing strategy to handle invalid JSON
 */

import { CoderOrchestrationResult, ReviewerOrchestrationResult } from './types.js';
import { 
  validateCoderResultWithLogging,
  validateReviewerResultWithLogging,
  ValidationResult
} from './schemas.js';

export class OrchestrationFallbackHandler {
  private static readonly UNQUOTED_KEY_REGEX = /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g;
  private static readonly SINGLE_QUOTED_STRING_REGEX = /'((?:\\.|[^'\\])*)'/g;

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

  private normalizeJsonCandidate(raw: string): string {
    let normalized = raw.trim();

    // Strip markdown fences if present
    const fencedMatch = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedMatch?.[1]) {
      normalized = fencedMatch[1].trim();
    }

    // Normalize smart quotes
    normalized = normalized
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");

    // Quote unquoted object keys: { action: "retry" } -> { "action": "retry" }
    normalized = normalized.replace(OrchestrationFallbackHandler.UNQUOTED_KEY_REGEX, '$1"$2"$3');

    // Convert single-quoted strings to JSON-safe double-quoted strings
    normalized = normalized.replace(
      OrchestrationFallbackHandler.SINGLE_QUOTED_STRING_REGEX,
      (_match, inner: string) => `"${inner.replace(/"/g, '\\"')}"`
    );

    // Remove trailing commas
    normalized = normalized.replace(/,\s*([}\]])/g, '$1');

    // Normalize python-ish literals that occasionally leak
    normalized = normalized
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null');

    return normalized;
  }

  private tryRepairAndParse<T>(
    rawOutput: string,
    validator: (data: any) => ValidationResult,
    successLog: string
  ): T | null {
    const candidates: string[] = [rawOutput];

    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonBlock?.[1]) {
      candidates.push(jsonBlock[1]);
    }

    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      candidates.push(rawOutput.substring(start, end + 1));
    }

    for (const candidate of candidates) {
      const normalized = this.normalizeJsonCandidate(candidate);
      try {
        const parsed = JSON.parse(normalized);
        const { valid, data } = validator(parsed);
        if (valid) {
          console.log(successLog);
          return data as T;
        }
      } catch {
        // Continue to next candidate
      }
    }

    return null;
  }

  /**
   * Parse coder orchestrator output with multi-layer fallback
   */
  parseCoderOutput(rawOutput: string): CoderOrchestrationResult {
    // Layer 1: Direct JSON parse
    try {
      const parsed = JSON.parse(rawOutput);
      const { valid, data } = validateCoderResultWithLogging(parsed);
      if (valid) {
        console.log('[Orchestrator] ✓ Layer 1: Direct JSON parse succeeded');
        return data as unknown as CoderOrchestrationResult;
      }
    } catch (e) {
      // Continue to next layer
    }

    // Layer 2: Extract from markdown code block
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        const { valid, data } = validateCoderResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 2: Markdown extraction succeeded');
          return data as unknown as CoderOrchestrationResult;
        }
      } catch (e) {
        // Continue to next layer
      }
    }

    // Layer 3: Find first { to last }
    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(rawOutput.substring(start, end + 1));
        const { valid, data } = validateCoderResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 3: Substring extraction succeeded');
          return data as unknown as CoderOrchestrationResult;
        }
      } catch (e) {
        // Continue to next layer
      }
    }

    // Layer 4: Repair malformed JSON and validate
    const repaired = this.tryRepairAndParse<CoderOrchestrationResult>(
      rawOutput,
      validateCoderResultWithLogging,
      '[Orchestrator] ✓ Layer 4: JSON repair succeeded'
    );
    if (repaired) {
      return repaired;
    }

    // Layer 5: Keyword fallback
    console.warn('[Orchestrator] ⚠ Layer 5: Using keyword fallback (all parsing+repair failed)');
    return this.keywordFallbackCoder(rawOutput);
  }

  /**
   * Parse reviewer orchestrator output with multi-layer fallback
   */
  parseReviewerOutput(rawOutput: string): ReviewerOrchestrationResult {
    // Layer 1: Direct JSON parse
    try {
      const parsed = JSON.parse(rawOutput);
      const { valid, data } = validateReviewerResultWithLogging(parsed);
      if (valid) {
        console.log('[Orchestrator] ✓ Layer 1: Direct JSON parse succeeded');
        return data as unknown as ReviewerOrchestrationResult;
      }
    } catch (e) {
      // Continue to next layer
    }

    // Layer 2: Extract from markdown code block
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        const { valid, data } = validateReviewerResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 2: Markdown extraction succeeded');
          return data as unknown as ReviewerOrchestrationResult;
        }
      } catch (e) {
        // Continue to next layer
      }
    }

    // Layer 3: Find first { to last }
    const start = rawOutput.indexOf('{');
    const end = rawOutput.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(rawOutput.substring(start, end + 1));
        const { valid, data } = validateReviewerResultWithLogging(parsed);
        if (valid) {
          console.log('[Orchestrator] ✓ Layer 3: Substring extraction succeeded');
          return data as unknown as ReviewerOrchestrationResult;
        }
      } catch (e) {
        // Continue to next layer
      }
    }

    // Layer 4: Repair malformed JSON and validate
    const repaired = this.tryRepairAndParse<ReviewerOrchestrationResult>(
      rawOutput,
      validateReviewerResultWithLogging,
      '[Orchestrator] ✓ Layer 4: JSON repair succeeded'
    );
    if (repaired) {
      return repaired;
    }

    // Layer 5: Explicit decision fallback
    console.warn('[Orchestrator] ⚠ Layer 5: Using explicit decision fallback (all parsing+repair failed)');
    return this.keywordFallbackReviewer(rawOutput);
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

    // Use the LAST DECISION token in the output, not the first.
    // When a provider session is resumed, the full conversation history is replayed
    // and old DECISION tokens from previous reviews appear before the current one.
    const decisionPattern = /(?:^|[\n\r])\s*(?:\*\*)?DECISION(?:\*\*)?\s*(?::|-)\s*(APPROVE|REJECT|DISPUTE|SKIP)\b/gim;
    let lastMatch: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = decisionPattern.exec(output)) !== null) {
      lastMatch = match;
    }
    if (lastMatch?.[1]) {
      return map[lastMatch[1].toUpperCase()] ?? null;
    }

    // Fallback: last non-empty line starting with a bare decision token
    const lines = output.split(/[\n\r]+/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const token = line.match(/^(APPROVE|REJECT|DISPUTE|SKIP)\b/i)?.[1];
      if (token) {
        return map[token.toUpperCase()] ?? null;
      }
      break; // only check the last non-empty line
    }

    return null;
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
    if (this.hasErrorIndicator(lower) && !this.hasCommitIndicator(lower)) {
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
    if (this.hasCommitIndicator(lower) && !this.hasErrorIndicator(lower)) {
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
    if (this.hasCompletionIndicator(lower)) {
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
   * Explicit-token fallback for reviewer orchestrator
   */
  private keywordFallbackReviewer(output: string): ReviewerOrchestrationResult {
    const decision = this.extractExplicitReviewerDecision(output);
    if (decision === 'approve') {
      return {
        decision: 'approve',
        reasoning: 'FALLBACK: Explicit DECISION token APPROVE',
        notes: 'Approved based on explicit reviewer decision token',
        next_status: 'completed',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: true,
          repeated_issue: false
        }
      };
    }
    if (decision === 'reject') {
      return {
        decision: 'reject',
        reasoning: 'FALLBACK: Explicit DECISION token REJECT',
        notes: 'Rejected - see reviewer output for details',
        next_status: 'in_progress',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: false,
          repeated_issue: false
        }
      };
    }
    if (decision === 'dispute') {
      return {
        decision: 'dispute',
        reasoning: 'FALLBACK: Explicit DECISION token DISPUTE',
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
    if (decision === 'skip') {
      return {
        decision: 'skip',
        reasoning: 'FALLBACK: Explicit DECISION token SKIP',
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
      reasoning: 'FALLBACK: Missing explicit reviewer decision token',
      notes: 'Review unclear, retrying with explicit decision requirement',
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
