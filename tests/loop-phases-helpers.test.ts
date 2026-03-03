import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetTaskAudit = jest.fn();

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTaskRejections: jest.fn(),
  getTaskAudit: mockGetTaskAudit,
  getLatestSubmissionNotes: jest.fn(),
  incrementTaskFailureCount: jest.fn(),
}));

const { countCommitRecoveryAttempts } = await import('../src/commands/loop-phases-helpers.js');

describe('countCommitRecoveryAttempts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts across decision and review bridge rows', () => {
    mockGetTaskAudit.mockReturnValue([
      { actor: 'orchestrator', notes: '[commit_recovery] first', to_status: 'in_progress', category: null },
      { actor: 'orchestrator', notes: '[submit] ready', to_status: 'in_progress', category: 'decision' },
      { actor: 'orchestrator', notes: 'ready', to_status: 'review', category: null },
      { actor: 'orchestrator', notes: '[commit_recovery] second', to_status: 'in_progress', category: null },
    ]);

    expect(countCommitRecoveryAttempts({} as never, 'task-1')).toBe(2);
  });

  it('stops at the first non-recovery orchestrator boundary row', () => {
    mockGetTaskAudit.mockReturnValue([
      { actor: 'orchestrator', notes: '[commit_recovery] earlier', to_status: 'in_progress', category: null },
      { actor: 'orchestrator', notes: '[retry] parse unclear', to_status: 'in_progress', category: null },
      { actor: 'orchestrator', notes: '[commit_recovery] latest', to_status: 'in_progress', category: null },
    ]);

    expect(countCommitRecoveryAttempts({} as never, 'task-1')).toBe(1);
  });
});
