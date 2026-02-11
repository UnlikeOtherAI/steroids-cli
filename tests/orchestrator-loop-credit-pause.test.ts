/**
 * Orchestrator Loop — Credit Pause Integration Tests
 *
 * Tests the credit exhaustion handling branches in orchestrator-loop.ts:
 * 1. Single-task path: pause_credit_exhaustion from runCoderPhase → break vs continue
 * 2. Batch coder path: checkBatchCreditExhaustion → handleCreditExhaustion → continue/break
 * 3. Batch reviewer path: checkBatchCreditExhaustion → handleCreditExhaustion → continue/break
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock functions ──────────────────────────────────────────────────────

const mockOpenDatabase = jest.fn();
const mockGetDbPath = jest.fn().mockReturnValue('/tmp/test/.steroids/steroids.db');
const mockAutoMigrate = jest.fn().mockReturnValue({ applied: false, migrations: [] });
const mockGetTask = jest.fn();
const mockGetSection = jest.fn().mockReturnValue(null);
const mockSelectNextTask = jest.fn();
const mockSelectTaskBatch = jest.fn();
const mockMarkTaskInProgress = jest.fn();
const mockGetTaskCounts = jest.fn().mockReturnValue({
  pending: 0, in_progress: 0, review: 0, completed: 0, disputed: 0, failed: 0, total: 0,
});
const mockInvokeCoderBatch = jest.fn();
const mockInvokeReviewerBatch = jest.fn();
const mockLoadConfig = jest.fn();
const mockListTasks = jest.fn().mockReturnValue([]);
const mockLogActivity = jest.fn();
const mockGetRegisteredProject = jest.fn().mockReturnValue(null);
const mockRunCoderPhase = jest.fn();
const mockRunReviewerPhase = jest.fn();
const mockHandleCreditExhaustion = jest.fn();
const mockCheckBatchCreditExhaustion = jest.fn();
const mockExecSync = jest.fn();

// ── Module mocks ────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
  getDbPath: mockGetDbPath,
}));

jest.unstable_mockModule('../src/migrations/index.js', () => ({
  autoMigrate: mockAutoMigrate,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: mockGetTask,
  getSection: mockGetSection,
  listTasks: mockListTasks,
}));

jest.unstable_mockModule('../src/orchestrator/task-selector.js', () => ({
  selectNextTask: mockSelectNextTask,
  selectTaskBatch: mockSelectTaskBatch,
  markTaskInProgress: mockMarkTaskInProgress,
  getTaskCounts: mockGetTaskCounts,
}));

jest.unstable_mockModule('../src/orchestrator/coder.js', () => ({
  invokeCoderBatch: mockInvokeCoderBatch,
}));

jest.unstable_mockModule('../src/orchestrator/reviewer.js', () => ({
  invokeReviewerBatch: mockInvokeReviewerBatch,
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/runners/activity-log.js', () => ({
  logActivity: mockLogActivity,
}));

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProject: mockGetRegisteredProject,
}));

jest.unstable_mockModule('../src/commands/loop-phases.js', () => ({
  runCoderPhase: mockRunCoderPhase,
  runReviewerPhase: mockRunReviewerPhase,
}));

jest.unstable_mockModule('../src/runners/credit-pause.js', () => ({
  handleCreditExhaustion: mockHandleCreditExhaustion,
  checkBatchCreditExhaustion: mockCheckBatchCreditExhaustion,
}));

jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
}));

// ── Import module under test ────────────────────────────────────────────

const { runOrchestratorLoop } = await import('../src/runners/orchestrator-loop.js');

// ── Helpers ─────────────────────────────────────────────────────────────

const mockDb = {} as any;
const mockClose = jest.fn();

function setupDefaults() {
  mockOpenDatabase.mockReturnValue({ db: mockDb, close: mockClose });
  mockLoadConfig.mockReturnValue({
    sections: { batchMode: false, maxBatchSize: 10 },
  });
  mockGetRegisteredProject.mockReturnValue(null);
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'in_progress',
    section_id: null,
    source_file: null,
    file_path: null,
    file_line: null,
    file_commit_sha: null,
    file_content_hash: null,
    rejection_count: 0,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    ...overrides,
  };
}

function makeCreditAlert(role = 'coder') {
  return {
    action: 'pause_credit_exhaustion',
    provider: 'claude',
    model: 'claude-sonnet-4',
    role,
    message: 'Insufficient credits',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Orchestrator Loop — Credit Pause', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaults();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Single-task path: credit exhaustion from runCoderPhase ──────

  describe('single-task path — credit exhaustion', () => {
    it('calls handleCreditExhaustion when runCoderPhase returns pause_credit_exhaustion', async () => {
      const task = makeTask();
      const alert = makeCreditAlert('coder');

      mockSelectNextTask
        .mockReturnValueOnce({ task, action: 'start' })
        .mockReturnValue(null);

      mockRunCoderPhase.mockResolvedValue(alert);
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
        runnerId: 'runner-1',
      });

      expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-sonnet-4',
          role: 'coder',
          message: 'Insufficient credits',
          projectPath: '/tmp/test',
          runnerId: 'runner-1',
          db: mockDb,
          onceMode: false,
        })
      );
    });

    it('breaks loop when handleCreditExhaustion returns { resolved: false }', async () => {
      const task = makeTask();

      mockSelectNextTask
        .mockReturnValueOnce({ task, action: 'start' })
        .mockReturnValue(null);

      mockRunCoderPhase.mockResolvedValue(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
      });

      expect(mockSelectNextTask).toHaveBeenCalledTimes(1);
    });

    it('continues loop when handleCreditExhaustion returns { resolved: true }', async () => {
      const task = makeTask();

      mockSelectNextTask
        .mockReturnValueOnce({ task, action: 'start' })
        .mockReturnValue(null);

      mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: true, resolution: 'config_changed' });

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
      });

      expect(mockSelectNextTask).toHaveBeenCalledTimes(2);
    });

    it('handles credit exhaustion from runReviewerPhase in single-task path', async () => {
      const task = makeTask({ status: 'review' });
      const alert = makeCreditAlert('reviewer');

      mockSelectNextTask
        .mockReturnValueOnce({ task, action: 'review' })
        .mockReturnValue(null);

      mockRunReviewerPhase.mockResolvedValue(alert);
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
      });

      expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-sonnet-4',
          role: 'reviewer',
          projectPath: '/tmp/test',
          db: mockDb,
        })
      );
    });

    it('passes onceMode=true when running in --once mode', async () => {
      const task = makeTask();

      mockSelectNextTask.mockReturnValueOnce({ task, action: 'start' });
      mockRunCoderPhase.mockResolvedValue(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'immediate_fail' });

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
        once: true,
      });

      expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
        expect.objectContaining({
          onceMode: true,
        })
      );
    });

    it('passes shouldStop and onHeartbeat to handleCreditExhaustion', async () => {
      const task = makeTask();
      const shouldStop = jest.fn().mockReturnValue(false);
      const onHeartbeat = jest.fn();

      mockSelectNextTask
        .mockReturnValueOnce({ task, action: 'start' })
        .mockReturnValue(null);

      mockRunCoderPhase.mockResolvedValue(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
        shouldStop,
        onHeartbeat,
      });

      expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldStop,
          onHeartbeat,
        })
      );
    });
  });

  // ── 2. Batch coder path: credit exhaustion ────────────────────────

  describe('batch coder path — credit exhaustion', () => {
    beforeEach(() => {
      mockLoadConfig.mockReturnValue({
        sections: { batchMode: true, maxBatchSize: 10 },
      });
    });

    it('checks batch coder result for credit exhaustion', async () => {
      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];
      const batch = { tasks, sectionId: 'sec-1', sectionName: 'Section 1' };
      const batchResult = { success: false, exitCode: 1, stdout: '', stderr: 'credits', duration: 100, timedOut: false, taskCount: 2 };

      mockSelectTaskBatch
        .mockReturnValueOnce(batch)
        .mockReturnValue(null);

      mockInvokeCoderBatch.mockResolvedValue(batchResult);
      mockCheckBatchCreditExhaustion.mockReturnValue(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

      mockSelectNextTask.mockReturnValue(null);

      await runOrchestratorLoop({
        projectPath: '/tmp/test',
      });

      expect(mockCheckBatchCreditExhaustion).toHaveBeenCalledWith(
        batchResult, 'coder', '/tmp/test'
      );
      expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-sonnet-4',
          role: 'coder',
          projectPath: '/tmp/test',
        })
      );
    });

    it('breaks loop when batch coder credit pause returns { resolved: false }', async () => {
      const tasks = [makeTask()];
      const batch = { tasks, sectionId: 'sec-1', sectionName: 'Section 1' };

      mockSelectTaskBatch.mockReturnValueOnce(batch).mockReturnValue(null);
      mockInvokeCoderBatch.mockResolvedValue({
        success: false, exitCode: 1, stdout: '', stderr: '', duration: 100, timedOut: false, taskCount: 1,
      });
      mockCheckBatchCreditExhaustion.mockReturnValue(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

      mockSelectNextTask.mockReturnValue(null);

      await runOrchestratorLoop({ projectPath: '/tmp/test' });

      expect(mockSelectTaskBatch).toHaveBeenCalledTimes(1);
    });

    it('continues loop when batch coder credit pause returns { resolved: true }', async () => {
      const tasks = [makeTask()];
      const batch = { tasks, sectionId: 'sec-1', sectionName: 'Section 1' };

      mockSelectTaskBatch
        .mockReturnValueOnce(batch)
        .mockReturnValue(null);
      mockSelectNextTask.mockReturnValue(null);

      mockInvokeCoderBatch.mockResolvedValue({
        success: false, exitCode: 1, stdout: '', stderr: '', duration: 100, timedOut: false, taskCount: 1,
      });
      mockCheckBatchCreditExhaustion.mockReturnValue(makeCreditAlert());
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: true, resolution: 'config_changed' });

      await runOrchestratorLoop({ projectPath: '/tmp/test' });

      expect(mockSelectTaskBatch).toHaveBeenCalledTimes(2);
    });
  });

  // ── 3. Batch reviewer path: credit exhaustion ─────────────────────

  describe('batch reviewer path — credit exhaustion', () => {
    beforeEach(() => {
      mockLoadConfig.mockReturnValue({
        sections: { batchMode: true, maxBatchSize: 10 },
      });
    });

    it('checks batch reviewer result for credit exhaustion', async () => {
      const tasks = [makeTask({ id: 'task-1', status: 'in_progress' })];
      const batch = { tasks, sectionId: 'sec-1', sectionName: 'Section 1' };

      mockSelectTaskBatch.mockReturnValueOnce(batch).mockReturnValue(null);

      const coderResult = { success: true, exitCode: 0, stdout: 'done', stderr: '', duration: 100, timedOut: false, taskCount: 1 };
      mockInvokeCoderBatch.mockResolvedValue(coderResult);
      mockCheckBatchCreditExhaustion
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeCreditAlert('reviewer'));

      mockGetTask.mockReturnValue(makeTask({ id: 'task-1', status: 'review' }));

      const reviewerResult = { success: false, exitCode: 1, stdout: '', stderr: 'credits', duration: 100, timedOut: false, taskCount: 1 };
      mockInvokeReviewerBatch.mockResolvedValue(reviewerResult);

      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });
      mockSelectNextTask.mockReturnValue(null);

      await runOrchestratorLoop({ projectPath: '/tmp/test' });

      expect(mockCheckBatchCreditExhaustion).toHaveBeenCalledTimes(2);
      expect(mockCheckBatchCreditExhaustion).toHaveBeenCalledWith(
        reviewerResult, 'reviewer', '/tmp/test'
      );
      expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-sonnet-4',
          role: 'reviewer',
          projectPath: '/tmp/test',
        })
      );
    });

    it('breaks loop when batch reviewer credit pause returns { resolved: false }', async () => {
      const tasks = [makeTask({ id: 'task-1' })];
      const batch = { tasks, sectionId: 'sec-1', sectionName: 'Section 1' };

      mockSelectTaskBatch.mockReturnValueOnce(batch).mockReturnValue(null);

      mockInvokeCoderBatch.mockResolvedValue({
        success: true, exitCode: 0, stdout: '', stderr: '', duration: 100, timedOut: false, taskCount: 1,
      });
      mockCheckBatchCreditExhaustion
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeCreditAlert('reviewer'));

      mockGetTask.mockReturnValue(makeTask({ status: 'review' }));
      mockInvokeReviewerBatch.mockResolvedValue({
        success: false, exitCode: 1, stdout: '', stderr: '', duration: 100, timedOut: false, taskCount: 1,
      });
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });
      mockSelectNextTask.mockReturnValue(null);

      await runOrchestratorLoop({ projectPath: '/tmp/test' });

      expect(mockSelectTaskBatch).toHaveBeenCalledTimes(1);
    });

    it('continues loop when batch reviewer credit pause returns { resolved: true }', async () => {
      const tasks = [makeTask({ id: 'task-1' })];
      const batch = { tasks, sectionId: 'sec-1', sectionName: 'Section 1' };

      mockSelectTaskBatch
        .mockReturnValueOnce(batch)
        .mockReturnValue(null);

      mockInvokeCoderBatch.mockResolvedValue({
        success: true, exitCode: 0, stdout: '', stderr: '', duration: 100, timedOut: false, taskCount: 1,
      });
      mockCheckBatchCreditExhaustion
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(makeCreditAlert('reviewer'));

      mockGetTask.mockReturnValue(makeTask({ status: 'review' }));
      mockInvokeReviewerBatch.mockResolvedValue({
        success: false, exitCode: 1, stdout: '', stderr: '', duration: 100, timedOut: false, taskCount: 1,
      });
      mockHandleCreditExhaustion.mockResolvedValue({ resolved: true, resolution: 'config_changed' });
      mockSelectNextTask.mockReturnValue(null);

      await runOrchestratorLoop({ projectPath: '/tmp/test' });

      expect(mockSelectTaskBatch).toHaveBeenCalledTimes(2);
    });
  });
});
