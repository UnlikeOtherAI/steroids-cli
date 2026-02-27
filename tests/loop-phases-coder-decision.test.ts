import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPushToRemote = jest.fn();
const mockUpdateTaskStatus = jest.fn();
const mockAddAuditEntry = jest.fn();
const mockResolveCoderSubmittedCommitSha = jest.fn();
const mockRefreshParallelWorkstreamLease = jest.fn();
const mockSummarizeErrorMessage = jest.fn();
const mockGetCurrentCommitSha = jest.fn();
const mockIsCommitReachable = jest.fn();
const mockExecSync = jest.fn();
const actualChildProcess = await import('node:child_process');

jest.unstable_mockModule('node:child_process', () => ({
  ...actualChildProcess,
  execSync: mockExecSync,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: jest.fn(),
  getTaskRejections: jest.fn().mockReturnValue([]),
  getLatestSubmissionNotes: jest.fn(),
  getLatestMustImplementGuidance: jest.fn().mockReturnValue(null),
  listTasks: jest.fn().mockReturnValue([]),
  addAuditEntry: mockAddAuditEntry,
  updateTaskStatus: mockUpdateTaskStatus,
}));

jest.unstable_mockModule('../src/git/push.js', () => ({
  pushToRemote: mockPushToRemote,
}));

jest.unstable_mockModule('../src/git/status.js', () => ({
  getCurrentCommitSha: mockGetCurrentCommitSha,
  getModifiedFiles: jest.fn().mockReturnValue([]),
  isCommitReachable: mockIsCommitReachable,
}));

jest.unstable_mockModule('../src/commands/loop-phases-helpers.js', () => ({
  refreshParallelWorkstreamLease: mockRefreshParallelWorkstreamLease,
  resolveCoderSubmittedCommitSha: mockResolveCoderSubmittedCommitSha,
  summarizeErrorMessage: mockSummarizeErrorMessage,
}));

const { executeCoderDecision } = await import('../src/commands/loop-phases-coder-decision.js');

const task = {
  id: 'task-1',
  status: 'in_progress',
};

const baseContext = {
  coderStdout: 'done',
  has_uncommitted: false,
  requiresExplicitSubmissionCommit: false,
  effectiveProjectPath: '/tmp/workspace',
  projectPath: '/tmp/workspace',
  branchName: 'steroids/task-1',
  leaseFence: { parallelSessionId: 'session-1' },
  jsonMode: true,
};

describe('executeCoderDecision push behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPushToRemote.mockReturnValue({ success: true, commitHash: 'abc123' });
    mockResolveCoderSubmittedCommitSha.mockReturnValue('abc123');
    mockGetCurrentCommitSha.mockReturnValue('def456');
    mockIsCommitReachable.mockReturnValue(true);
    mockRefreshParallelWorkstreamLease.mockReturnValue(true);
    mockSummarizeErrorMessage.mockReturnValue('error');
  });

  it('submit: skips push in pool mode even with parallel session', async () => {
    await executeCoderDecision(
      {} as never,
      task as never,
      { action: 'submit', reasoning: 'ready' },
      { ...baseContext, hasPoolSlot: true }
    );

    expect(mockPushToRemote).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'review',
      'orchestrator',
      'ready',
      'abc123'
    );
  });

  it('submit: pushes in non-pool mode when parallel session is active', async () => {
    await executeCoderDecision(
      {} as never,
      task as never,
      { action: 'submit', reasoning: 'ready' },
      { ...baseContext, hasPoolSlot: false }
    );

    expect(mockPushToRemote).toHaveBeenCalledTimes(1);
    expect(mockPushToRemote).toHaveBeenCalledWith('/tmp/workspace', 'origin', 'steroids/task-1');
  });

  it('stage_commit_submit (no uncommitted): skips push in pool mode', async () => {
    await executeCoderDecision(
      {} as never,
      task as never,
      { action: 'stage_commit_submit', reasoning: 'auto', commit_message: 'feat: test' },
      { ...baseContext, has_uncommitted: false, hasPoolSlot: true }
    );

    expect(mockPushToRemote).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'review',
      'orchestrator',
      'Auto-commit skipped: no uncommitted changes',
      'abc123'
    );
  });

  it('stage_commit_submit (no uncommitted): pushes in non-pool mode', async () => {
    await executeCoderDecision(
      {} as never,
      task as never,
      { action: 'stage_commit_submit', reasoning: 'auto', commit_message: 'feat: test' },
      { ...baseContext, has_uncommitted: false, hasPoolSlot: false }
    );

    expect(mockPushToRemote).toHaveBeenCalledTimes(1);
    expect(mockPushToRemote).toHaveBeenCalledWith('/tmp/workspace', 'origin', 'steroids/task-1');
  });

  it('stage_commit_submit (after auto-commit): skips push in pool mode', async () => {
    await executeCoderDecision(
      {} as never,
      task as never,
      { action: 'stage_commit_submit', reasoning: 'auto-commit', commit_message: 'feat: test' },
      { ...baseContext, has_uncommitted: true, hasPoolSlot: true }
    );

    expect(mockRefreshParallelWorkstreamLease).toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockPushToRemote).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'review',
      'orchestrator',
      'Auto-committed and submitted (auto-commit)',
      'def456'
    );
  });
});
