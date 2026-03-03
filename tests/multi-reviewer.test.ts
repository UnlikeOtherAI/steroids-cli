import { resolveDecision, type ReviewerResult } from '../src/orchestrator/reviewer';

describe('Multi-Reviewer Policy Engine', () => {
  test('all approve should result in approve', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
    ];
    const { decision, needsMerge, route } = resolveDecision(results);
    expect(decision).toBe('approve');
    expect(needsMerge).toBe(false);
    expect(route).toBe('direct');
  });

  test('approve + reject should route to arbitration', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'REJECT: issues', stderr: '', duration: 100, timedOut: false, decision: 'reject', notes: 'issues' },
    ];
    const { decision, needsMerge, route } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(needsMerge).toBe(false);
    expect(route).toBe('arbitrate');
  });

  test('multiple rejects should use local reject merge path', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'REJECT: issue 1', stderr: '', duration: 100, timedOut: false, decision: 'reject', notes: 'issue 1' },
      { success: true, exitCode: 0, stdout: 'REJECT: issue 2', stderr: '', duration: 100, timedOut: false, decision: 'reject', notes: 'issue 2' },
    ];
    const { decision, needsMerge, route } = resolveDecision(results);
    expect(decision).toBe('reject');
    expect(needsMerge).toBe(true);
    expect(route).toBe('local_reject_merge');
  });

  test('approve + dispute should route to arbitration', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'DISPUTE: logic', stderr: '', duration: 100, timedOut: false, decision: 'dispute' },
    ];
    const { decision, needsMerge, route } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(needsMerge).toBe(false);
    expect(route).toBe('arbitrate');
  });

  test('mix of approve and skip should route to arbitration', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'SKIP', stderr: '', duration: 100, timedOut: false, decision: 'skip' },
    ];
    const { decision, needsMerge, route } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(needsMerge).toBe(false);
    expect(route).toBe('arbitrate');
  });

  test('all skip should result in skip', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'SKIP', stderr: '', duration: 100, timedOut: false, decision: 'skip' },
      { success: true, exitCode: 0, stdout: 'SKIP', stderr: '', duration: 100, timedOut: false, decision: 'skip' },
    ];
    const { decision, needsMerge, route } = resolveDecision(results);
    expect(decision).toBe('skip');
    expect(needsMerge).toBe(false);
    expect(route).toBe('direct');
  });

  test('all dispute should result in dispute direct', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'DISPUTE', stderr: '', duration: 100, timedOut: false, decision: 'dispute' },
      { success: true, exitCode: 0, stdout: 'DISPUTE', stderr: '', duration: 100, timedOut: false, decision: 'dispute' },
    ];
    const { decision, route } = resolveDecision(results);
    expect(decision).toBe('dispute');
    expect(route).toBe('direct');
  });

  test('approve + undefined should route to arbitration', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'DECISION: APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'ambiguous output', stderr: '', duration: 100, timedOut: false, decision: undefined },
    ];
    const { decision, route } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(route).toBe('arbitrate');
  });

  test('reject + undefined should route to arbitration', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'DECISION: REJECT', stderr: '', duration: 100, timedOut: false, decision: 'reject' },
      { success: true, exitCode: 0, stdout: 'ambiguous output', stderr: '', duration: 100, timedOut: false, decision: undefined },
    ];
    const { decision, route } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(route).toBe('arbitrate');
  });

  test('reject + reject + undefined should route to arbitration', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'DECISION: REJECT', stderr: '', duration: 100, timedOut: false, decision: 'reject' },
      { success: true, exitCode: 0, stdout: 'DECISION: REJECT', stderr: '', duration: 100, timedOut: false, decision: 'reject' },
      { success: true, exitCode: 0, stdout: 'ambiguous output', stderr: '', duration: 100, timedOut: false, decision: undefined },
    ];
    const { decision, route } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(route).toBe('arbitrate');
  });
});
