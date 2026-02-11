/**
 * Loop Command (foreground) — Credit Pause Integration Tests
 *
 * Tests src/commands/loop.ts:387-408: the handleCreditExhaustion() call
 * inside loopCommand's main loop and its three resolution branches:
 *   1. config_changed  → continue (retry with new provider)
 *   2. stopped         → break out of loop
 *   3. immediate_fail  → process.exit(1)
 *
 * Also verifies that --once passes onceMode: true to handleCreditExhaustion.
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock functions ──────────────────────────────────────────────────────

const mockOpenDatabase = jest.fn();
const mockGetSection = jest.fn().mockReturnValue(null);
const mockGetSectionByName = jest.fn().mockReturnValue(null);
const mockListSections = jest.fn().mockReturnValue([]);
const mockSelectNextTask = jest.fn();
const mockMarkTaskInProgress = jest.fn();
const mockGetTaskCounts = jest.fn().mockReturnValue({
  pending: 0, in_progress: 0, review: 0, completed: 0, disputed: 0, failed: 0, total: 0,
});
const mockHasActiveRunnerForProject = jest.fn().mockReturnValue(false);
const mockGetRegisteredProject = jest.fn().mockReturnValue(null);
const mockRunCoderPhase = jest.fn();
const mockRunReviewerPhase = jest.fn();
const mockHandleCreditExhaustion = jest.fn();
const mockCreateOutput = jest.fn().mockReturnValue({
  success: jest.fn(),
  error: jest.fn(),
});

// ── Module mocks ────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getSection: mockGetSection,
  getSectionByName: mockGetSectionByName,
  listSections: mockListSections,
}));

jest.unstable_mockModule('../src/orchestrator/task-selector.js', () => ({
  selectNextTask: mockSelectNextTask,
  markTaskInProgress: mockMarkTaskInProgress,
  getTaskCounts: mockGetTaskCounts,
}));

jest.unstable_mockModule('../src/runners/wakeup.js', () => ({
  hasActiveRunnerForProject: mockHasActiveRunnerForProject,
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
}));

jest.unstable_mockModule('../src/cli/help.js', () => ({
  generateHelp: jest.fn().mockReturnValue('HELP TEXT'),
}));

jest.unstable_mockModule('../src/cli/output.js', () => ({
  createOutput: mockCreateOutput,
}));

jest.unstable_mockModule('../src/cli/errors.js', () => ({
  ErrorCode: { CONFIG_ERROR: 'CONFIG_ERROR', NOT_INITIALIZED: 'NOT_INITIALIZED', RESOURCE_LOCKED: 'RESOURCE_LOCKED', SECTION_NOT_FOUND: 'SECTION_NOT_FOUND' },
  getExitCode: jest.fn().mockReturnValue(1),
}));

// ── Import module under test ────────────────────────────────────────────

const { loopCommand } = await import('../src/commands/loop.js');

// ── Helpers ─────────────────────────────────────────────────────────────

const mockDb = {} as any;
const mockClose = jest.fn();

function setupDefaults() {
  mockOpenDatabase.mockReturnValue({ db: mockDb, close: mockClose });
  mockHasActiveRunnerForProject.mockReturnValue(false);
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

const defaultFlags = {
  json: true,
  quiet: false,
  verbose: false,
  help: false,
  version: false,
  noColor: false,
  dryRun: false,
  noHooks: false,
  noWait: false,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('loopCommand — Credit Pause Integration', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaults();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Mock process.exit to throw instead of exiting
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('continues loop when handleCreditExhaustion resolves with config_changed', async () => {
    const task = makeTask();

    // First iteration: credit exhaustion → config_changed → continue
    // Second iteration: no more tasks → break
    mockSelectNextTask
      .mockReturnValueOnce({ task, action: 'start' })
      .mockReturnValue(null);

    mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: true, resolution: 'config_changed' });

    await loopCommand([], defaultFlags);

    // Should have selected tasks twice: once for the credit-exhausted iteration, once after continue
    expect(mockSelectNextTask).toHaveBeenCalledTimes(2);
    expect(mockHandleCreditExhaustion).toHaveBeenCalledTimes(1);
    expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        model: 'claude-sonnet-4',
        role: 'coder',
        message: 'Insufficient credits',
        runnerId: 'foreground',
        db: mockDb,
        onceMode: false,
      })
    );
  });

  it('breaks loop when handleCreditExhaustion resolves with stopped', async () => {
    const task = makeTask();

    mockSelectNextTask.mockReturnValueOnce({ task, action: 'start' });
    mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

    await loopCommand([], defaultFlags);

    // Should only select once — loop breaks after 'stopped'
    expect(mockSelectNextTask).toHaveBeenCalledTimes(1);
    expect(mockHandleCreditExhaustion).toHaveBeenCalledTimes(1);
    // Verify close() is called (finally block)
    expect(mockClose).toHaveBeenCalled();
  });

  it('calls process.exit(1) when handleCreditExhaustion resolves with immediate_fail', async () => {
    const task = makeTask();

    mockSelectNextTask.mockReturnValueOnce({ task, action: 'start' });
    mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'immediate_fail' });

    await expect(loopCommand([], defaultFlags)).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockHandleCreditExhaustion).toHaveBeenCalledTimes(1);
  });

  it('passes onceMode: true when --once flag is set', async () => {
    const task = makeTask();

    mockSelectNextTask.mockReturnValueOnce({ task, action: 'start' });
    mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'immediate_fail' });

    await expect(loopCommand(['--once'], defaultFlags)).rejects.toThrow('process.exit(1)');

    expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
      expect.objectContaining({
        onceMode: true,
      })
    );
  });

  it('passes onceMode: false when --once flag is not set', async () => {
    const task = makeTask();

    mockSelectNextTask.mockReturnValueOnce({ task, action: 'start' });
    mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

    await loopCommand([], defaultFlags);

    expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
      expect.objectContaining({
        onceMode: false,
      })
    );
  });

  it('handles credit exhaustion from reviewer phase', async () => {
    const task = makeTask({ status: 'review' });
    const alert = makeCreditAlert('reviewer');

    mockSelectNextTask
      .mockReturnValueOnce({ task, action: 'review' })
      .mockReturnValue(null);

    mockRunReviewerPhase.mockResolvedValueOnce(alert);
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: true, resolution: 'config_changed' });

    await loopCommand([], defaultFlags);

    expect(mockHandleCreditExhaustion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        model: 'claude-sonnet-4',
        role: 'reviewer',
        runnerId: 'foreground',
        db: mockDb,
      })
    );
  });

  it('passes shouldStop that always returns false for foreground loop', async () => {
    const task = makeTask();

    mockSelectNextTask.mockReturnValueOnce({ task, action: 'start' });
    mockRunCoderPhase.mockResolvedValueOnce(makeCreditAlert());
    mockHandleCreditExhaustion.mockResolvedValue({ resolved: false, resolution: 'stopped' });

    await loopCommand([], defaultFlags);

    const callArgs = mockHandleCreditExhaustion.mock.calls[0][0];
    expect(typeof callArgs.shouldStop).toBe('function');
    expect(callArgs.shouldStop()).toBe(false);
  });
});
