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

    it('returns unclear when no signal is present', () => {
      expect(SignalParser.parseCoderSignal('I am done.')).toBe('unclear');
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