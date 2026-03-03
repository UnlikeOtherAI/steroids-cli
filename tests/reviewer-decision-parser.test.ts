import { parseReviewerDecisionSignal } from '../src/orchestrator/reviewer-decision-parser';

describe('reviewer-decision-parser', () => {
  it('parses canonical decision lines', () => {
    expect(parseReviewerDecisionSignal('DECISION: APPROVE').decision).toBe('approve');
    expect(parseReviewerDecisionSignal('DECISION - REJECT').decision).toBe('reject');
    expect(parseReviewerDecisionSignal('Wait, actually DECISION: REJECT').decision).toBe('reject');
  });

  it('parses markdown heading and bold variants', () => {
    expect(parseReviewerDecisionSignal('## DECISION: DISPUTE').decision).toBe('dispute');
    expect(parseReviewerDecisionSignal('### **DECISION**: SKIP').decision).toBe('skip');
  });

  it('is case-insensitive', () => {
    expect(parseReviewerDecisionSignal('decision: approve').decision).toBe('approve');
    expect(parseReviewerDecisionSignal('DeCiSiOn: ReJeCt').decision).toBe('reject');
  });

  it('uses last explicit decision token', () => {
    const output = `DECISION: APPROVE
Some analysis
DECISION: REJECT`;
    expect(parseReviewerDecisionSignal(output).decision).toBe('reject');
  });

  it('ignores decisions inside fenced code blocks', () => {
    const output = `\`\`\`
DECISION: APPROVE
\`\`\`
DECISION: REJECT`;
    expect(parseReviewerDecisionSignal(output).decision).toBe('reject');
  });

  it('ignores decisions in quoted lines', () => {
    const output = `> DECISION: REJECT
DECISION: APPROVE`;
    expect(parseReviewerDecisionSignal(output).decision).toBe('approve');
  });

  it('does not use first-line fallback', () => {
    expect(parseReviewerDecisionSignal('REJECT this approach').decision).toBe('unclear');
  });
});
