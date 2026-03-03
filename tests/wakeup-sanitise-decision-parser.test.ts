import { describe, expect, it } from '@jest/globals';
import { parseReviewerDecisionFromInvocationLogContent } from '../src/runners/wakeup-sanitise.js';

describe('parseReviewerDecisionFromInvocationLogContent', () => {
  it('parses decision from plain legacy text logs', () => {
    const raw = 'some text\nDECISION: REJECT\n- [ ] fix validation';
    expect(parseReviewerDecisionFromInvocationLogContent(raw)).toBe('reject');
  });

  it('parses decision from invocation ndjson stdout messages', () => {
    const raw = [
      '{"ts":1,"type":"start","role":"reviewer"}',
      '{"ts":2,"type":"output","stream":"stdout","msg":"analysis..."}',
      '{"ts":3,"type":"output","stream":"stdout","msg":"DECISION: REJECT\\\\n- [ ] add test"}',
      '{"ts":4,"type":"complete","success":true}',
    ].join('\n');
    expect(parseReviewerDecisionFromInvocationLogContent(raw)).toBe('reject');
  });

  it('parses approve from invocation ndjson stdout messages', () => {
    const raw = [
      '{"ts":1,"type":"output","stream":"stdout","msg":"Looks good"}',
      '{"ts":2,"type":"output","stream":"stdout","msg":"DECISION: APPROVE"}',
    ].join('\n');
    expect(parseReviewerDecisionFromInvocationLogContent(raw)).toBe('approve');
  });

  it('returns null when no explicit decision exists', () => {
    const raw = [
      '{"ts":1,"type":"output","stream":"stdout","msg":"I need more context"}',
      '{"ts":2,"type":"complete","success":true}',
    ].join('\n');
    expect(parseReviewerDecisionFromInvocationLogContent(raw)).toBeNull();
  });
});
