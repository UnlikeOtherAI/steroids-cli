/**
 * Daemon — Credit Pause Heartbeat Wiring Test
 *
 * Verifies that startDaemon passes onHeartbeat to runOrchestratorLoop
 * and that the callback updates the runner heartbeat during credit pause.
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock functions ──────────────────────────────────────────────────────

let capturedLoopOptions: any = null;

const mockRunOrchestratorLoop = jest.fn().mockImplementation(async (options) => {
  capturedLoopOptions = options;
});

const mockUpdateRunnerHeartbeat = jest.fn();
const mockRegisterRunner = jest.fn().mockReturnValue({
  runnerId: 'test-runner-id',
  close: jest.fn(),
});
const mockDbRun = jest.fn();
const mockDbPrepare = jest.fn().mockReturnValue({ run: mockDbRun, get: jest.fn(), all: jest.fn().mockReturnValue([]) });
const mockOpenGlobalDatabase = jest.fn().mockReturnValue({
  db: { prepare: mockDbPrepare },
  close: jest.fn(),
});
const mockCreateHeartbeatManager = jest.fn().mockReturnValue({
  start: jest.fn(),
  stop: jest.fn(),
});
const mockHasActiveRunnerForProject = jest.fn().mockReturnValue(false);
const mockGetRegisteredProject = jest.fn().mockReturnValue(null);
const mockUpdateProjectStats = jest.fn();
const mockUpdateRunnerStatus = jest.fn();
const mockUpdateRunnerCurrentTask = jest.fn();
const mockUnregisterRunner = jest.fn();
const mockSyncProjectStats = jest.fn();

// ── Module mocks ────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/runners/orchestrator-loop.js', () => ({
  runOrchestratorLoop: mockRunOrchestratorLoop,
}));

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
  updateParallelSessionStatus: jest.fn(),
  revokeWorkstreamLeasesForSession: jest.fn(),
  listParallelSessionRunners: jest.fn().mockReturnValue([]),
  removeParallelSessionRunner: jest.fn(),
  recordValidationEscalation: jest.fn().mockReturnValue({ id: 1 }),
  resolveValidationEscalationsForSession: jest.fn().mockReturnValue(0),
}));

jest.unstable_mockModule('../src/runners/heartbeat.js', () => ({
  createHeartbeatManager: mockCreateHeartbeatManager,
}));

jest.unstable_mockModule('../src/runners/wakeup.js', () => ({
  hasActiveRunnerForProject: mockHasActiveRunnerForProject,
}));

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProject: mockGetRegisteredProject,
  updateProjectStats: mockUpdateProjectStats,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: jest.fn().mockReturnValue({ db: {}, close: jest.fn() }),
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  createTask: jest.fn(),
  getTask: jest.fn(),
  updateTaskStatus: jest.fn(),
  approveTask: jest.fn(),
  rejectTask: jest.fn(),
  getTaskRejections: jest.fn().mockReturnValue([]),
  getTaskAudit: jest.fn().mockReturnValue([]),
  getLatestSubmissionNotes: jest.fn(),
  listTasks: jest.fn().mockReturnValue([]),
  addAuditEntry: jest.fn(),
  getTaskCountsByStatus: jest.fn().mockReturnValue({
    pending: 0, in_progress: 0, review: 0, completed: 0,
  }),
}));

jest.unstable_mockModule('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-runner-id'),
}));

// ── Import module under test ────────────────────────────────────────────

// We need to import daemon.ts but it uses registerRunner, updateRunnerStatus, etc.
// which are defined in the same file. We mock the internal functions by mocking
// the global-db module that they depend on.
// Actually, since registerRunner, updateRunnerHeartbeat, etc. are in the same file,
// we can't easily mock them. Instead, we'll capture the options passed to
// runOrchestratorLoop and verify the onHeartbeat wiring.

// The daemon module exports are in the same file, and the key functions like
// updateRunnerHeartbeat are called directly. We mock the global-db module
// so that all DB operations succeed.

const daemon = await import('../src/runners/daemon.js');

// ── Tests ───────────────────────────────────────────────────────────────

describe('Daemon — onHeartbeat wiring for credit pause', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedLoopOptions = null;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // Prevent process.exit from actually exiting
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes onHeartbeat callback to runOrchestratorLoop', async () => {
    await daemon.startDaemon({
      projectPath: '/tmp/test-project',
    });

    expect(mockRunOrchestratorLoop).toHaveBeenCalledTimes(1);
    expect(capturedLoopOptions).toBeDefined();
    expect(typeof capturedLoopOptions.onHeartbeat).toBe('function');
  });

  it('onHeartbeat callback updates runner heartbeat via global DB', async () => {
    await daemon.startDaemon({
      projectPath: '/tmp/test-project',
    });

    expect(capturedLoopOptions).toBeDefined();
    expect(typeof capturedLoopOptions.onHeartbeat).toBe('function');

    // Clear mock call history to isolate the onHeartbeat call
    mockDbPrepare.mockClear();
    mockDbRun.mockClear();

    // Invoke the onHeartbeat callback (simulating what credit-pause.ts does)
    capturedLoopOptions.onHeartbeat();

    // The callback should have triggered a DB update to the heartbeat
    // updateRunnerHeartbeat opens global DB and runs:
    // UPDATE runners SET heartbeat_at = datetime('now') WHERE id = ?
    expect(mockOpenGlobalDatabase).toHaveBeenCalled();
    expect(mockDbPrepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE runners SET heartbeat_at')
    );
  });

  it('passes runnerId to runOrchestratorLoop for incident tracking', async () => {
    await daemon.startDaemon({
      projectPath: '/tmp/test-project',
    });

    expect(capturedLoopOptions).toBeDefined();
    expect(capturedLoopOptions.runnerId).toBe('test-runner-id');
  });

  it('passes shouldStop callback to runOrchestratorLoop', async () => {
    await daemon.startDaemon({
      projectPath: '/tmp/test-project',
    });

    expect(capturedLoopOptions).toBeDefined();
    expect(typeof capturedLoopOptions.shouldStop).toBe('function');
    // Initially shouldStop returns false
    expect(capturedLoopOptions.shouldStop()).toBe(false);
  });
});
