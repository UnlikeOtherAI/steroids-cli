import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPushToRemote = jest.fn();
const mockUpdateTaskStatus = jest.fn();
const mockUpdateTaskStatusDetailed = jest.fn();
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
  getSubmissionCommitShas: jest.fn().mockReturnValue([]),
  getLatestMustImplementGuidance: jest.fn().mockReturnValue(null),
  listTasks: jest.fn().mockReturnValue([]),
  addAuditEntry: mockAddAuditEntry,
  updateTaskStatus: mockUpdateTaskStatus,
  updateTaskStatusDetailed: mockUpdateTaskStatusDetailed,
  getLatestSubmissionAudit: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule('../src/git/push.js', () => ({
  pushToRemote: mockPushToRemote,
}));

jest.unstable_mockModule('../src/git/status.js', () => ({
  getCurrentCommitSha: mockGetCurrentCommitSha,
  getModifiedFiles: jest.fn().mockReturnValue([]),
  isCommitReachable: mockIsCommitReachable,
  isCommitReachableWithFetch: jest.fn().mockReturnValue(false),
}));

jest.unstable_mockModule('../src/git/submission-durability.js', () => ({
  getSubmissionDurableRef: jest.fn().mockImplementation((taskId) => `refs/steroids/submissions/${String(taskId)}/latest`),
  readDurableSubmissionRef: jest.fn().mockReturnValue(null),
  writeDurableSubmissionRef: jest.fn().mockReturnValue({ ok: true }),
  deleteDurableSubmissionRef: jest.fn(),
}));

jest.unstable_mockModule('../src/commands/loop-phases-helpers.js', () => ({
  refreshParallelWorkstreamLease: mockRefreshParallelWorkstreamLease,
  resolveCoderSubmittedCommitSha: mockResolveCoderSubmittedCommitSha,
  summarizeErrorMessage: mockSummarizeErrorMessage,
  countCommitRecoveryAttempts: jest.fn().mockReturnValue(0),
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

function createDbMock() {
  return {
    transaction: jest.fn((fn: () => void) => fn),
    prepare: jest.fn((sql: string) => {
      if (sql.includes('SELECT metadata')) {
        return { get: jest.fn().mockReturnValue(undefined) };
      }
      if (sql.includes('UPDATE audit')) {
        return { run: jest.fn() };
      }
      return { get: jest.fn(), run: jest.fn() };
    }),
  };
}

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
    const db = createDbMock();
    await executeCoderDecision(
      db as never,
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

  it('submit: does not push outside pool mode because durable review submission is local-first', async () => {
    const db = createDbMock();
    await executeCoderDecision(
      db as never,
      task as never,
      { action: 'submit', reasoning: 'ready' },
      { ...baseContext, hasPoolSlot: false }
    );

    expect(mockPushToRemote).not.toHaveBeenCalled();
  });

  it('stage_commit_submit (no uncommitted): skips push in pool mode', async () => {
    const db = createDbMock();
    await executeCoderDecision(
      db as never,
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

  it('stage_commit_submit (no uncommitted): does not push outside pool mode', async () => {
    const db = createDbMock();
    await executeCoderDecision(
      db as never,
      task as never,
      { action: 'stage_commit_submit', reasoning: 'auto', commit_message: 'feat: test' },
      { ...baseContext, has_uncommitted: false, hasPoolSlot: false }
    );

    expect(mockPushToRemote).not.toHaveBeenCalled();
  });

  it('stage_commit_submit (after auto-commit): skips push in pool mode', async () => {
    const db = createDbMock();
    await executeCoderDecision(
      db as never,
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

  it('stage_commit_submit (after auto-commit): does not push outside pool mode', async () => {
    const db = createDbMock();
    await executeCoderDecision(
      db as never,
      task as never,
      { action: 'stage_commit_submit', reasoning: 'auto-commit', commit_message: 'feat: test' },
      { ...baseContext, has_uncommitted: true, hasPoolSlot: false }
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
