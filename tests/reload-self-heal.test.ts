import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockOpenGlobalDatabase = jest.fn<any>();
const mockGetRegisteredProjects = jest.fn<any>();
const mockLoadConfig = jest.fn<any>();
const mockOpenDatabase = jest.fn<any>();
const mockRecoverStuckTasks = jest.fn<any>();
const mockCleanupAbandonedRunners = jest.fn<any>();
const mockReconcileInvocationRuntimeState = jest.fn<any>();

jest.unstable_mockModule('../src/runners/global-db-connection.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
  withGlobalDatabase: jest.fn(),
  getGlobalSteroidsDir: jest.fn().mockReturnValue('/tmp/.steroids'),
  getGlobalDbPath: jest.fn().mockReturnValue('/tmp/.steroids/steroids.db'),
  isGlobalDbInitialized: jest.fn().mockReturnValue(true),
  getGlobalSchemaVersion: jest.fn().mockReturnValue('25'),
}));

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProjects: mockGetRegisteredProjects,
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
  loadConfigFile: jest.fn(),
  getProjectConfigPath: jest.fn().mockReturnValue('/project/.steroids.yml'),
  getGlobalConfigPath: jest.fn().mockReturnValue('/global/.steroids.yml'),
  mergeConfigs: jest.fn(),
  applyEnvOverrides: jest.fn(),
  pruneConfigToSchema: jest.fn(),
  saveConfig: jest.fn(),
  getConfigValue: jest.fn(),
  setConfigValue: jest.fn(),
  DEFAULT_CONFIG: {},
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/health/stuck-task-recovery.js', () => ({
  recoverStuckTasks: mockRecoverStuckTasks,
}));

jest.unstable_mockModule('../src/runners/abandoned-runners.js', () => ({
  cleanupAbandonedRunners: mockCleanupAbandonedRunners,
}));

jest.unstable_mockModule('../src/runners/wakeup-sanitise-runtime.js', () => ({
  reconcileInvocationRuntimeState: mockReconcileInvocationRuntimeState,
  runtimeSanitiseActionCount: jest.fn((summary: any) =>
    (summary?.recoveredApprovals ?? 0) +
    (summary?.recoveredRejects ?? 0) +
    (summary?.closedStaleInvocations ?? 0) +
    (summary?.releasedTaskLocks ?? 0),
  ),
}));

const {
  scheduleReloadSelfHeal,
  runReloadSelfHealNow,
  resetReloadSelfHealStateForTests,
} = await import('../src/self-heal/reload-sweep.js');

function createProjectDir(name: string): string {
  const dir = join(
    tmpdir(),
    `steroids-reload-self-heal-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(dir, '.steroids'), { recursive: true });
  writeFileSync(join(dir, '.steroids', 'steroids.db'), '');
  return dir;
}

describe('reload self-heal', () => {
  const createdDirs: string[] = [];
  const originalDateNow = Date.now;

  beforeEach(() => {
    jest.clearAllMocks();
    resetReloadSelfHealStateForTests();
    mockOpenGlobalDatabase.mockReturnValue({
      db: { prepare: jest.fn() },
      close: jest.fn(),
    });
    mockCleanupAbandonedRunners.mockReturnValue([
      { action: 'cleaned', reason: 'Cleaned 1 abandoned runner(s)', staleRunners: 1 },
    ]);
    mockGetRegisteredProjects.mockReturnValue([]);
    mockLoadConfig.mockReturnValue({});
    mockOpenDatabase.mockReturnValue({
      db: {},
      close: jest.fn(),
    });
    mockRecoverStuckTasks.mockResolvedValue({
      actions: [{ failureMode: 'orphaned_task' }],
      skippedDueToSafetyLimit: false,
    });
    mockReconcileInvocationRuntimeState.mockResolvedValue({
      recoveredApprovals: 0,
      recoveredRejects: 0,
      closedStaleInvocations: 0,
      releasedTaskLocks: 0,
    });
  });

  afterEach(() => {
    Date.now = originalDateNow;
    createdDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('runs global cleanup and project recovery when invoked directly', async () => {
    const projectPath = createProjectDir('direct');
    createdDirs.push(projectPath);
    mockGetRegisteredProjects.mockReturnValue([{ path: projectPath }]);

    const result = await runReloadSelfHealNow({
      source: 'project_tasks_page',
      projectPath,
    });

    expect(mockCleanupAbandonedRunners).toHaveBeenCalled();
    expect(mockRecoverStuckTasks).toHaveBeenCalled();
    expect(mockReconcileInvocationRuntimeState).toHaveBeenCalled();
    expect(result).toEqual({
      cleanedRunnerCount: 1,
      projects: [
        expect.objectContaining({
          projectPath,
          recoveredActions: 1,
          skippedRecoveryDueToSafetyLimit: false,
        }),
      ],
    });
  });

  it('collapses concurrent schedule requests and then applies cooldown', async () => {
    const projectPath = createProjectDir('cooldown');
    createdDirs.push(projectPath);
    mockGetRegisteredProjects.mockReturnValue([{ path: projectPath }]);

    let resolveRecovery: (() => void) | undefined;
    mockRecoverStuckTasks.mockImplementation(
      () => new Promise((resolve) => {
        resolveRecovery = () => resolve({
          actions: [{ failureMode: 'orphaned_task' }],
          skippedDueToSafetyLimit: false,
        });
      }),
    );

    Date.now = jest.fn(() => 10_000);

    const first = scheduleReloadSelfHeal({ source: 'runners_page' });
    const second = scheduleReloadSelfHeal({ source: 'runners_page' });

    expect(first).toEqual({ scheduled: true, reason: 'scheduled' });
    expect(second).toEqual({ scheduled: false, reason: 'already_running' });

    resolveRecovery?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const third = scheduleReloadSelfHeal({ source: 'runners_page' });
    expect(third).toEqual({ scheduled: false, reason: 'cooldown' });
  });
});
