import { resolveDecision, type ReviewerResult } from '../src/orchestrator/reviewer';

describe('Multi-Reviewer Policy Engine', () => {
  test('all approve should result in approve', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
    ];
    const { decision, needsMerge } = resolveDecision(results);
    expect(decision).toBe('approve');
    expect(needsMerge).toBe(false);
  });

  test('any reject should result in reject', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'REJECT: issues', stderr: '', duration: 100, timedOut: false, decision: 'reject', notes: 'issues' },
    ];
    const { decision, needsMerge } = resolveDecision(results);
    expect(decision).toBe('reject');
    expect(needsMerge).toBe(false);
  });

  test('multiple rejects should require merge', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'REJECT: issue 1', stderr: '', duration: 100, timedOut: false, decision: 'reject', notes: 'issue 1' },
      { success: true, exitCode: 0, stdout: 'REJECT: issue 2', stderr: '', duration: 100, timedOut: false, decision: 'reject', notes: 'issue 2' },
    ];
    const { decision, needsMerge } = resolveDecision(results);
    expect(decision).toBe('reject');
    expect(needsMerge).toBe(true);
  });

  test('any dispute (no reject) should result in dispute', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'DISPUTE: logic', stderr: '', duration: 100, timedOut: false, decision: 'dispute' },
    ];
    const { decision, needsMerge } = resolveDecision(results);
    expect(decision).toBe('dispute');
    expect(needsMerge).toBe(false);
  });

  test('mix of approve and skip should result in unclear', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'APPROVE', stderr: '', duration: 100, timedOut: false, decision: 'approve' },
      { success: true, exitCode: 0, stdout: 'SKIP', stderr: '', duration: 100, timedOut: false, decision: 'skip' },
    ];
    const { decision, needsMerge } = resolveDecision(results);
    expect(decision).toBe('unclear');
    expect(needsMerge).toBe(false);
  });

  test('all skip should result in skip', () => {
    const results: ReviewerResult[] = [
      { success: true, exitCode: 0, stdout: 'SKIP', stderr: '', duration: 100, timedOut: false, decision: 'skip' },
      { success: true, exitCode: 0, stdout: 'SKIP', stderr: '', duration: 100, timedOut: false, decision: 'skip' },
    ];
    const { decision, needsMerge } = resolveDecision(results);
    expect(decision).toBe('skip');
    expect(needsMerge).toBe(false);
  });
});
