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
 * - ignore fenced code blocks and markdown quote lines
 */
export function parseReviewerDecisionSignal(output: string): ParsedReviewerDecision {
  const lines = output.split(/\r?\n/);
  let inFence = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const line = raw.trim();

    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith('>')) {
      continue;
    }

    const match = line.match(DECISION_LINE_RE);
    if (match) {
      return {
        decision: match[1].toLowerCase() as Exclude<ReviewerDecision, 'unclear'>,
        matchedBy: 'explicit_token',
        rawLine: raw,
      };
    }
  }

  return {
    decision: 'unclear',
    matchedBy: 'none',
    rawLine: null,
  };
}
