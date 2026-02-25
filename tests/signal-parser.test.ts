import { SignalParser } from '../src/orchestrator/signal-parser.js';

describe('SignalParser', () => {
  describe('parseCoderSignal', () => {
    it('extracts STATUS: REVIEW', () => {
      const output = `I have finished the implementation.
      
STATUS: REVIEW`;
      expect(SignalParser.parseCoderSignal(output)).toBe('review');
    });

    it('extracts bolded **STATUS**: **REVIEW**', () => {
      const output = `Done.

**STATUS**: **REVIEW**`;
      expect(SignalParser.parseCoderSignal(output)).toBe('review');
    });

    it('ignores signals inside code blocks', () => {
      const output = `I will output the following:
\`\`\`
STATUS: REVIEW
\`\`\`
But not yet.`;
      expect(SignalParser.parseCoderSignal(output)).toBe('unclear');
    });

    it('extracts STATUS: RETRY', () => {
      const output = `Need more time to finish.\n\nSTATUS: RETRY\nREASON: Incomplete implementation`;
      expect(SignalParser.parseCoderSignal(output)).toBe('retry');
    });

    it('extracts STATUS: ERROR', () => {
      const output = `Fatal failure occurred.\n\nSTATUS: ERROR\nREASON: Build failed with fatal error`;
      expect(SignalParser.parseCoderSignal(output)).toBe('error');
    });

    it('extracts bolded **STATUS**: **RETRY**', () => {
      const output = `Still working.\n\n**STATUS**: **RETRY**`;
      expect(SignalParser.parseCoderSignal(output)).toBe('retry');
    });

    it('extracts bolded **STATUS**: **ERROR**', () => {
      const output = `Crashed.\n\n**STATUS**: **ERROR**`;
      expect(SignalParser.parseCoderSignal(output)).toBe('error');
    });

    it('ignores RETRY inside code blocks', () => {
      const output = `Here is the format:\n\`\`\`\nSTATUS: RETRY\n\`\`\`\nBut actually done.`;
      expect(SignalParser.parseCoderSignal(output)).toBe('unclear');
    });

    it('returns unclear when no signal is present', () => {
      expect(SignalParser.parseCoderSignal('I am done.')).toBe('unclear');
    });
  });

  describe('extractReason', () => {
    it('extracts REASON: line', () => {
      const output = `STATUS: REVIEW\nREASON: Clean exit with 2 commits\nCONFIDENCE: HIGH`;
      expect(SignalParser.extractReason(output)).toBe('Clean exit with 2 commits');
    });

    it('extracts bolded **REASON**: line', () => {
      const output = `**STATUS**: **REVIEW**\n**REASON**: Work complete`;
      expect(SignalParser.extractReason(output)).toBe('Work complete');
    });

    it('returns null when no REASON line', () => {
      expect(SignalParser.extractReason('STATUS: REVIEW')).toBeNull();
    });

    it('extracts REASON with CHECKLIST_REQUIRED prefix', () => {
      const output = `STATUS: RETRY\nREASON: CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found`;
      expect(SignalParser.extractReason(output)).toBe('CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found');
    });

    it('ignores REASON inside code blocks', () => {
      const output = `\`\`\`\nREASON: inside code\n\`\`\``;
      expect(SignalParser.extractReason(output)).toBeNull();
    });
  });

  describe('extractConfidence', () => {
    it('extracts CONFIDENCE: HIGH', () => {
      const output = `STATUS: REVIEW\nREASON: done\nCONFIDENCE: HIGH`;
      expect(SignalParser.extractConfidence(output)).toBe('high');
    });

    it('extracts CONFIDENCE: LOW', () => {
      const output = `STATUS: RETRY\nCONFIDENCE: LOW`;
      expect(SignalParser.extractConfidence(output)).toBe('low');
    });

    it('defaults to medium when not present', () => {
      expect(SignalParser.extractConfidence('STATUS: REVIEW')).toBe('medium');
    });

    it('extracts bolded **CONFIDENCE**: **MEDIUM**', () => {
      const output = `**CONFIDENCE**: **MEDIUM**`;
      expect(SignalParser.extractConfidence(output)).toBe('medium');
    });
  });

  describe('extractCommitMessage', () => {
    it('extracts COMMIT_MESSAGE: line', () => {
      const output = `STATUS: REVIEW\nREASON: Work complete\nCOMMIT_MESSAGE: feat: add feature`;
      expect(SignalParser.extractCommitMessage(output)).toBe('feat: add feature');
    });

    it('returns null when no COMMIT_MESSAGE line', () => {
      expect(SignalParser.extractCommitMessage('STATUS: REVIEW')).toBeNull();
    });

    it('returns null for empty COMMIT_MESSAGE', () => {
      const output = `COMMIT_MESSAGE: `;
      expect(SignalParser.extractCommitMessage(output)).toBeNull();
    });

    it('ignores COMMIT_MESSAGE inside code blocks', () => {
      const output = `\`\`\`\nCOMMIT_MESSAGE: inside code\n\`\`\``;
      expect(SignalParser.extractCommitMessage(output)).toBeNull();
    });
  });

  describe('parseReviewerSignal', () => {
    it('extracts DECISION: APPROVE', () => {
      const output = `Looks great.

DECISION: APPROVE`;
      const result = SignalParser.parseReviewerSignal(output);
      expect(result.decision).toBe('approve');
      expect(result.notes).toBe(output);
    });

    it('extracts bolded **DECISION**: REJECT', () => {
      const output = `Needs work.
**DECISION**: REJECT`;
      expect(SignalParser.parseReviewerSignal(output).decision).toBe('reject');
    });

    it('ignores decisions in code blocks', () => {
      const output = `I will output:
\`\`\`
DECISION: APPROVE
\`\`\`
Wait, actually DECISION: REJECT`;
      expect(SignalParser.parseReviewerSignal(output).decision).toBe('reject');
    });

    it('extracts follow-up tasks', () => {
      const output = `DECISION: APPROVE

### Follow Up Tasks
- **Refactor Config:** The config parsing could be cleaner.
- Add Tests: We need more unit tests.
`;
      const result = SignalParser.parseReviewerSignal(output);
      expect(result.decision).toBe('approve');
      expect(result.followUpTasks).toHaveLength(2);
      expect(result.followUpTasks[0].title).toBe('Refactor Config');
      expect(result.followUpTasks[0].description).toBe('The config parsing could be cleaner.');
      expect(result.followUpTasks[1].title).toBe('Add Tests');
      expect(result.followUpTasks[1].description).toBe('We need more unit tests.');
    });

    it('handles missing follow-up tasks gracefully', () => {
      const output = `DECISION: APPROVE

No follow ups needed.`;
      const result = SignalParser.parseReviewerSignal(output);
      expect(result.followUpTasks).toHaveLength(0);
    });
  });
});