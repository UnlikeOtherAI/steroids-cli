import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const mockLoadConfig = jest.fn<() => unknown>();
const mockOpenDatabase = jest.fn<() => unknown>();
const mockRecoverStuckTasks = jest.fn<() => Promise<unknown>>();
const mockCleanupInvocationLogs = jest.fn<() => unknown>();
const mockPollIntakeProject = jest.fn<() => Promise<unknown>>();
const mockGetProviderBackoffRemainingMs = jest.fn<() => number>();
const mockRunPeriodicSanitiseForProject = jest.fn<() => unknown>();
const mockSanitisedActionCount = jest.fn<() => number>();
const mockProjectHasPendingWork = jest.fn<() => Promise<boolean>>();
const mockHasActiveRunnerForProject = jest.fn<() => boolean>();
const mockStartRunner = jest.fn<() => unknown>();
const mockWaitForRunnerRegistration = jest.fn<() => Promise<boolean>>();
const mockReconcileProjectParallelState = jest.fn<() => unknown>();

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/health/stuck-task-recovery.js', () => ({
  recoverStuckTasks: mockRecoverStuckTasks,
}));

jest.unstable_mockModule('../src/cleanup/invocation-logs.js', () => ({
  cleanupInvocationLogs: mockCleanupInvocationLogs,
}));

jest.unstable_mockModule('../src/intake/poller.js', () => ({
  pollIntakeProject: mockPollIntakeProject,
}));

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  getProviderBackoffRemainingMs: mockGetProviderBackoffRemainingMs,
}));

jest.unstable_mockModule('../src/runners/wakeup-sanitise.js', () => ({
  SanitiseSummary: {},
  runPeriodicSanitiseForProject: mockRunPeriodicSanitiseForProject,
  sanitisedActionCount: mockSanitisedActionCount,
}));

jest.unstable_mockModule('../src/runners/wakeup-checks.js', () => ({
  projectHasPendingWork: mockProjectHasPendingWork,
  hasActiveRunnerForProject: mockHasActiveRunnerForProject,
}));

jest.unstable_mockModule('../src/runners/wakeup-runner.js', () => ({
  startRunner: mockStartRunner,
}));

jest.unstable_mockModule('../src/runners/wakeup-registration.js', () => ({
  waitForRunnerRegistration: mockWaitForRunnerRegistration,
}));

jest.unstable_mockModule('../src/runners/wakeup-project-parallel.js', () => ({
  reconcileProjectParallelState: mockReconcileProjectParallelState,
}));

const { processWakeupProject } = await import('../src/runners/wakeup-project.js');

describe('processWakeupProject intake integration', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = join('/tmp', `steroids-wakeup-intake-${process.pid}-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    mockLoadConfig.mockReturnValue({
      intake: { enabled: true, pollIntervalMinutes: 15, maxReportsPerPoll: 50 },
      runners: { parallel: { enabled: false } },
      ai: {},
    });
    mockOpenDatabase.mockReturnValue({
      db: { transaction: (callback: () => void) => callback },
      close: jest.fn(),
    });
    mockRecoverStuckTasks.mockResolvedValue({
      actions: [],
      skippedDueToSafetyLimit: false,
    });
    mockCleanupInvocationLogs.mockReturnValue({ deletedFiles: 0 });
    mockPollIntakeProject.mockResolvedValue({
      status: 'success',
      reason: 'Persisted 1 intake report(s) across 1 connector(s)',
      totalReportsPersisted: 1,
      connectorResults: [
        {
          source: 'github',
          status: 'success',
          reportsPersisted: 1,
          nextCursor: null,
          reason: 'Persisted 1 report(s)',
        },
      ],
    });
    mockGetProviderBackoffRemainingMs.mockReturnValue(0);
    mockRunPeriodicSanitiseForProject.mockReturnValue({});
    mockSanitisedActionCount.mockReturnValue(0);
    mockProjectHasPendingWork.mockResolvedValue(false);
    mockHasActiveRunnerForProject.mockReturnValue(false);
    mockReconcileProjectParallelState.mockReturnValue(null);
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('polls intake during project maintenance before deciding there is no pending task work', async () => {
    const log = jest.fn();

    const result = await processWakeupProject({
      globalDb: {},
      projectPath,
      dryRun: false,
      log,
    });

    const firstPollCall = (mockPollIntakeProject.mock.calls as unknown[][])[0]?.[0];
    expect(firstPollCall).toEqual({
      projectDb: expect.any(Object),
      config: mockLoadConfig.mock.results[0]?.value,
      dryRun: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        action: 'none',
        reason: 'No pending tasks',
        projectPath,
        polledIntakeReports: 1,
        intakePollErrors: 0,
      })
    );
    expect(log).toHaveBeenCalledWith(
      `Intake poll for ${projectPath}: Persisted 1 intake report(s) across 1 connector(s)`
    );
  });
});
