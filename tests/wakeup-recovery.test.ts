/**
 * Wakeup integration tests for stuck-task recovery wiring.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

interface TestProject {
  path: string;
  cleanup: () => void;
}

function createTestProjectWithPendingWork(name: string): TestProject {
  const projectPath = join('/tmp', `steroids-test-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(join(projectPath, '.steroids'), { recursive: true });

  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`).run('t1', 'Task 1', 'pending');
  db.close();

  return {
    path: projectPath,
    cleanup: () => {
      try {
        rmSync(projectPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

const mockSpawn = jest.fn();
const mockOpenGlobalDatabase = jest.fn();
const mockGetRegisteredProjects = jest.fn();
const mockFindStaleRunners = jest.fn();
const mockCheckLockStatus = jest.fn();
const mockRemoveLock = jest.fn();
const mockOpenDatabase = jest.fn();
const mockLoadConfig = jest.fn();
// Type the mock loosely; ts-jest can otherwise infer `never` for mockResolvedValue().
const mockRecoverStuckTasks: any = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
  getGlobalDbPath: () => '/mock/.steroids/steroids.db',
  getGlobalSteroidsDir: () => '/mock/.steroids',
  isGlobalDbInitialized: () => true,
}));

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProjects: mockGetRegisteredProjects,
}));

jest.unstable_mockModule('../src/runners/heartbeat.js', () => ({
  findStaleRunners: mockFindStaleRunners,
}));

jest.unstable_mockModule('../src/runners/lock.js', () => ({
  checkLockStatus: mockCheckLockStatus,
  removeLock: mockRemoveLock,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/health/stuck-task-recovery.js', () => ({
  recoverStuckTasks: mockRecoverStuckTasks,
}));

const createMockDb = () => ({
  prepare: jest.fn().mockReturnThis(),
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  exec: jest.fn(),
  close: jest.fn(),
  pragma: jest.fn(),
});

const mockGlobalDb = createMockDb();
const mockProjectDb = createMockDb();

const { wakeup } = await import('../src/runners/wakeup.js');

describe('wakeup() - stuck task recovery integration', () => {
  let project: TestProject | null = null;

  beforeEach(() => {
    jest.clearAllMocks();

    project = createTestProjectWithPendingWork('wakeup-recovery');

    mockCheckLockStatus.mockReturnValue({
      locked: false,
      isZombie: false,
    });
    mockFindStaleRunners.mockReturnValue([]);

    mockOpenGlobalDatabase.mockReturnValue({
      db: mockGlobalDb,
      close: jest.fn(),
    });

    // No active runners for the project.
    mockGlobalDb.prepare.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn(),
    });

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    mockOpenDatabase.mockReturnValue({
      db: mockProjectDb,
      close: jest.fn(),
    });

    mockLoadConfig.mockReturnValue({
      health: { autoRecover: true },
    });

    mockRecoverStuckTasks.mockResolvedValue({
      report: {
        timestamp: new Date('2026-02-10T00:00:00.000Z'),
        orphanedTasks: [],
        hangingInvocations: [],
        zombieRunners: [],
        deadRunners: [],
        dbInconsistencies: [],
      },
      actions: [
        { kind: 'task', targetId: 't1', failureMode: 'orphaned_task', resolution: 'auto_restart', reason: 'x' },
        { kind: 'runner', targetId: 'r1', failureMode: 'zombie_runner', resolution: 'auto_restart', reason: 'y' },
      ],
      skippedDueToSafetyLimit: true,
    });
  });

  afterEach(() => {
    project?.cleanup();
    project = null;
    jest.clearAllMocks();
  });

  it('calls recoverStuckTasks() and surfaces recoveredActions + skippedRecoveryDueToSafetyLimit in WakeupResult', async () => {
    if (!project) throw new Error('project not created');

    const results = await wakeup({ quiet: true, dryRun: true });

    expect(mockRecoverStuckTasks).toHaveBeenCalledTimes(1);
    expect(mockRecoverStuckTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: project.path,
        projectDb: mockProjectDb,
        globalDb: mockGlobalDb,
        dryRun: true,
      })
    );

    const r = results.find((x) => x.projectPath === project?.path);
    expect(r).toBeDefined();
    expect(r?.recoveredActions).toBe(2);
    expect(r?.skippedRecoveryDueToSafetyLimit).toBe(true);

    // dryRun should never spawn runners.
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
