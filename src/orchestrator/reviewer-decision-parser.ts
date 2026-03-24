export type ReviewerDecision = 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';

export interface ParsedReviewerDecision {
  decision: ReviewerDecision;
  matchedBy: 'explicit_token' | 'none';
  rawLine: string | null;
}

const DECISION_LINE_RE =
  /(?:^|[\s#*-])(?:\*\*)?DECISION(?:\*\*)?\s*(?::|-)\s*(?:\*\*)?(APPROVE|REJECT|DISPUTE|SKIP)(?:\*\*)?\b/i;

/**
 * Parse reviewer decision signals with strict, deterministic rules:
 * - explicit DECISION line only (no first-line fallback)
 * - case-insensitive matching
 * - last explicit token wins
 * - skip markdown quote lines (> prefix)
 * - prefer signals OUTSIDE code fences, but fall back to fenced signals
 *   (many HF models naturally wrap structured output in code blocks)
 */
export function parseReviewerDecisionSignal(output: string): ParsedReviewerDecision {
  const lines = output.split(/\r?\n/);
  let inFence = false;
  let fencedMatch: ParsedReviewerDecision | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const line = raw.trim();

    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!line || line.startsWith('>')) {
      continue;
    }

    const match = line.match(DECISION_LINE_RE);
    if (match) {
      const parsed: ParsedReviewerDecision = {
        decision: match[1].toLowerCase() as Exclude<ReviewerDecision, 'unclear'>,
        matchedBy: 'explicit_token',
        rawLine: raw,
      };
      if (!inFence) return parsed; // Unfenced signal: use immediately
      if (!fencedMatch) fencedMatch = parsed; // Fenced signal: remember as fallback
    }
  }

  // No unfenced signal found — use fenced signal if available
  if (fencedMatch) return fencedMatch;

  return {
    decision: 'unclear',
    matchedBy: 'none',
    rawLine: null,
  };
}
