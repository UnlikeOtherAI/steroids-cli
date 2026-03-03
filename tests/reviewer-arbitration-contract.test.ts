import { describe, expect, it } from '@jest/globals';
import { getArbitrationContractViolation } from '../src/commands/loop-phases-reviewer-resolution';
import type { ReviewerOrchestrationResult } from '../src/orchestrator/types';

function makeParsed(
  overrides: Partial<ReviewerOrchestrationResult>
): ReviewerOrchestrationResult {
  return {
    decision: 'approve',
    reasoning: 'ok',
    notes: 'ok',
    next_status: 'completed',
    rejection_count: 0,
    confidence: 'high',
    push_to_remote: true,
    repeated_issue: false,
    ...overrides,
  };
}

describe('getArbitrationContractViolation', () => {
  it('rejects skip decisions in arbitration', () => {
    const parsed = makeParsed({
      decision: 'skip',
      next_status: 'skipped',
      push_to_remote: false,
    });
    expect(getArbitrationContractViolation(parsed, true, false, false, false, 1))
      .toContain('contract_violation_skip_not_allowed');
  });

  it('rejects low-confidence approve when reject exists and no dispute exists', () => {
    const parsed = makeParsed({
      decision: 'approve',
      confidence: 'medium',
    });
    expect(getArbitrationContractViolation(parsed, true, false, false, false, 2))
      .toContain('contract_violation_low_confidence_approve');
  });

  it('rejects low-confidence approve when a dispute exists', () => {
    const parsed = makeParsed({
      decision: 'approve',
      confidence: 'medium',
    });
    expect(getArbitrationContractViolation(parsed, false, true, false, false, 1))
      .toContain('contract_violation_low_confidence_approve');
  });

  it('rejects low-confidence approve when a skip exists in arbitration set', () => {
    const parsed = makeParsed({
      decision: 'approve',
      confidence: 'medium',
    });
    expect(getArbitrationContractViolation(parsed, false, false, true, false, 1))
      .toContain('contract_violation_low_confidence_approve');
  });

  it('rejects low-confidence approve when undefined reviewer decisions exist', () => {
    const parsed = makeParsed({
      decision: 'approve',
      confidence: 'medium',
    });
    expect(getArbitrationContractViolation(parsed, false, false, false, true, 1))
      .toContain('contract_violation_low_confidence_approve');
  });

  it('rejects empty-note reject decisions', () => {
    const parsed = makeParsed({
      decision: 'reject',
      next_status: 'in_progress',
      notes: '   ',
      push_to_remote: false,
    });
    expect(getArbitrationContractViolation(parsed, true, false, false, false, 1))
      .toContain('contract_violation_empty_reject_notes');
  });

  it('allows valid high-confidence approve under reject pressure', () => {
    const parsed = makeParsed({
      decision: 'approve',
      confidence: 'high',
    });
    expect(getArbitrationContractViolation(parsed, true, false, false, false, 1)).toBeNull();
  });
});
