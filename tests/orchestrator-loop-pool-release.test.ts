// @ts-nocheck
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockOpenDatabase = jest.fn();
const mockAutoMigrate = jest.fn().mockReturnValue({ applied: false, migrations: [] });
const mockLoadConfig = jest.fn().mockReturnValue({
  sections: { batchMode: false, maxBatchSize: 10 },
});
const mockIncrementTaskFailureCount = jest.fn();
const mockUpdateTaskStatus = jest.fn();
const mockSelectNextTaskWithLock = jest.fn();
const mockRunCoderPhase = jest.fn();
const mockPushWithRetries = jest.fn().mockReturnValue({ success: true });
const mockClaimSlot = jest.fn();
const mockFinalizeSlotPath = jest.fn();
const mockPartialReleaseSlot = jest.fn();
const mockReleaseSlot = jest.fn();
const mockGetSlot = jest.fn();
const mockResolveRemoteUrl = jest.fn().mockReturnValue('git@github.com:org/repo.git');

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
  getDbPath: jest.fn().mockReturnValue('/tmp/test/.steroids/steroids.db'),
}));

jest.unstable_mockModule('../src/migrations/index.js', () => ({
  autoMigrate: mockAutoMigrate,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: jest.fn(),
  getSection: jest.fn().mockReturnValue(null),
  incrementTaskFailureCount: mockIncrementTaskFailureCount,
  clearTaskFailureCount: jest.fn(),
  updateTaskStatus: mockUpdateTaskStatus,
  listTasks: jest.fn().mockReturnValue([]),
  getInvocationCount: jest.fn().mockReturnValue({ coder: 0, reviewer: 0, total: 0 }),
}));

jest.unstable_mockModule('../src/orchestrator/task-selector.js', () => ({
  selectNextTask: jest.fn(),
  selectNextTaskWithLock: mockSelectNextTaskWithLock,
  selectTaskBatch: jest.fn().mockReturnValue(null),
  markTaskInProgress: jest.fn(),
  releaseTaskLockAfterCompletion: jest.fn(),
  getTaskCounts: jest.fn().mockReturnValue({
    pending: 0, in_progress: 0, review: 0, completed: 0, disputed: 0, failed: 0, total: 0,
  }),
}));

jest.unstable_mockModule('../src/orchestrator/coder.js', () => ({
  invokeCoderBatch: jest.fn(),
}));

jest.unstable_mockModule('../src/orchestrator/reviewer.js', () => ({
  invokeReviewerBatch: jest.fn(),
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProject: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule('../src/commands/loop-phases.js', () => ({
  runCoderPhase: mockRunCoderPhase,
  runReviewerPhase: jest.fn(),
}));

jest.unstable_mockModule('../src/runners/credit-pause.js', () => ({
  handleCreditExhaustion: jest.fn(),
  checkBatchCreditExhaustion: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule('../src/git/push.js', () => ({
  pushToRemote: jest.fn(),
}));

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  withGlobalDatabase: jest.fn(),
  openGlobalDatabase: jest.fn().mockReturnValue({
    db: {},
    close: jest.fn(),
  }),
}));

jest.unstable_mockModule('../src/parallel/clone.js', () => ({
  ensureWorkspaceSteroidsSymlink: jest.fn(),
  getProjectHash: jest.fn().mockReturnValue('project-hash'),
}));

jest.unstable_mockModule('../src/workspace/pool.js', () => ({
  claimSlot: mockClaimSlot,
  finalizeSlotPath: mockFinalizeSlotPath,
  releaseSlot: mockReleaseSlot,
  partialReleaseSlot: mockPartialReleaseSlot,
  resolveRemoteUrl: mockResolveRemoteUrl,
  refreshSlotHeartbeat: jest.fn(),
  getSlot: mockGetSlot,
}));

jest.unstable_mockModule('../src/workspace/git-helpers.js', () => ({
  pushWithRetries: mockPushWithRetries,
}));

jest.unstable_mockModule('../src/workspace/merge-lock.js', () => ({
  refreshWorkspaceMergeLockHeartbeat: jest.fn(),
}));

jest.unstable_mockModule('../src/runners/system-pressure.js', () => ({
  waitForPressureRelief: jest.fn().mockResolvedValue(true),
}));

jest.unstable_mockModule('../src/runners/activity-log.js', () => ({
  logActivity: jest.fn(),
}));

let runOrchestratorLoop: typeof import('../src/runners/orchestrator-loop.js').runOrchestratorLoop;

describe('orchestrator loop pool partial release', () => {
  beforeAll(async () => {
    ({ runOrchestratorLoop } = await import('../src/runners/orchestrator-loop.js'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenDatabase.mockReturnValue({ db: {}, close: jest.fn() });
    mockClaimSlot.mockReturnValue({ id: 1, slot_index: 0 });
    mockFinalizeSlotPath.mockReturnValue({ id: 1, slot_path: '/tmp/pool-0' });
    mockRunCoderPhase.mockResolvedValue(undefined);
    mockSelectNextTaskWithLock
      .mockReturnValueOnce({
        task: { id: 'task-1', title: 'Task 1', status: 'pending' },
        action: 'start',
      })
      .mockReturnValue(null);
    mockGetSlot.mockReturnValue({
      id: 1,
      status: 'awaiting_review',
      slot_path: '/tmp/pool-0',
      task_branch: 'steroids/task-task-1',
      remote_url: 'git@github.com:org/repo.git',
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pushes the task branch before partial release when a slot enters awaiting_review', async () => {
    const callOrder: string[] = [];
    mockPushWithRetries.mockImplementation(() => {
      callOrder.push('push');
      return { success: true };
    });
    mockPartialReleaseSlot.mockImplementation(() => {
      callOrder.push('partial-release');
    });

    await runOrchestratorLoop({
      projectPath: '/tmp/test',
      runnerId: 'runner-1',
    });

    expect(mockPushWithRetries).toHaveBeenCalledWith(
      '/tmp/pool-0',
      'origin',
      'steroids/task-task-1',
      2,
      [2000, 8000],
      true
    );
    expect(mockPartialReleaseSlot).toHaveBeenCalledWith({}, 1);
    expect(mockReleaseSlot).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['push', 'partial-release']);
  });

  it('returns the task to pending and fully releases the slot when the durability push fails', async () => {
    mockPushWithRetries.mockReturnValue({ success: false, error: 'push failed' });
    mockIncrementTaskFailureCount.mockReturnValue(1);

    await runOrchestratorLoop({
      projectPath: '/tmp/test',
      runnerId: 'runner-1',
    });

    expect(mockIncrementTaskFailureCount).toHaveBeenCalledWith({}, 'task-1');
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      {},
      'task-1',
      'pending',
      'orchestrator',
      'Returned to pending because task branch push failed before review handoff (1/3)'
    );
    expect(mockReleaseSlot).toHaveBeenCalledWith({}, 1);
    expect(mockPartialReleaseSlot).not.toHaveBeenCalled();
  });
});
