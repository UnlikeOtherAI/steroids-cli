/**
 * Tests for wakeup multi-project iteration
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { SpawnOptions } from 'node:child_process';

// Mock modules before imports
const mockSpawn = jest.fn();
const mockExistsSync = jest.fn();
const mockOpenGlobalDatabase = jest.fn();
const mockGetRegisteredProjects = jest.fn();
const mockFindStaleRunners = jest.fn();
const mockCheckLockStatus = jest.fn();
const mockRemoveLock = jest.fn();

// Mock node:child_process
jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Mock node:fs
jest.unstable_mockModule('node:fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: jest.fn(),
  realpathSync: (p: string) => p,
  statSync: jest.fn(),
}));

// Mock global-db
jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
  getGlobalDbPath: () => '/mock/.steroids/steroids.db',
  getGlobalSteroidsDir: () => '/mock/.steroids',
  isGlobalDbInitialized: () => true,
}));

// Mock projects
jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProjects: mockGetRegisteredProjects,
}));

// Mock heartbeat
jest.unstable_mockModule('../src/runners/heartbeat.js', () => ({
  findStaleRunners: mockFindStaleRunners,
}));

// Mock lock
jest.unstable_mockModule('../src/runners/lock.js', () => ({
  checkLockStatus: mockCheckLockStatus,
  removeLock: mockRemoveLock,
}));

// Mock better-sqlite3
const mockDb = {
  prepare: jest.fn().mockReturnThis(),
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
  exec: jest.fn(),
  close: jest.fn(),
  pragma: jest.fn(),
};

jest.unstable_mockModule('better-sqlite3', () => ({
  default: jest.fn(() => mockDb),
}));

// Now import the module under test
const { wakeup, hasActiveRunnerForProject, checkWakeupNeeded } = await import(
  '../src/runners/wakeup.js'
);

describe('wakeup multi-project iteration', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset mockDb methods
    mockDb.prepare.mockReturnValue({
      get: jest.fn(),
      all: jest.fn(),
      run: jest.fn(),
    });

    // Default mock implementations
    mockCheckLockStatus.mockReturnValue({
      locked: false,
      isZombie: false,
    });

    mockFindStaleRunners.mockReturnValue([]);

    mockOpenGlobalDatabase.mockReturnValue({
      db: mockDb,
      close: jest.fn(),
    });

    mockExistsSync.mockReturnValue(true);

    // Mock spawn to return a fake child process
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('wakeup()', () => {
    it('should iterate over all registered enabled projects', () => {
      // Setup: 3 registered projects
      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
        { path: '/project2', enabled: true, name: 'Project 2' },
        { path: '/project3', enabled: true, name: 'Project 3' },
      ]);

      // Mock existsSync to return true for project DBs
      mockExistsSync.mockImplementation((path) => {
        return String(path).includes('.steroids');
      });

      // Setup mock for hasActiveRunnerForProject and projectHasPendingWork
      const mockGet = jest.fn()
        .mockReturnValueOnce(undefined) // hasActiveRunnerForProject for project1
        .mockReturnValueOnce({ count: 5 }) // projectHasPendingWork for project1
        .mockReturnValueOnce(undefined) // hasActiveRunnerForProject for project2
        .mockReturnValueOnce({ count: 0 }) // projectHasPendingWork for project2
        .mockReturnValueOnce(undefined) // hasActiveRunnerForProject for project3
        .mockReturnValueOnce({ count: 0 }); // projectHasPendingWork for project3

      mockDb.prepare.mockReturnValue({
        get: mockGet,
        all: jest.fn(),
        run: jest.fn(),
      });

      const results = wakeup({ quiet: true });

      // Should have results for all 3 projects
      expect(results.length).toBeGreaterThan(0);

      // Should have called getRegisteredProjects
      expect(mockGetRegisteredProjects).toHaveBeenCalledWith(false);

      // Should have spawned runner for project1
      const startedResult = results.find((r) => r.action === 'started');
      expect(startedResult).toBeDefined();
      expect(startedResult?.projectPath).toBe('/project1');
    });

    it('should skip projects that do not exist', () => {
      mockGetRegisteredProjects.mockReturnValue([
        { path: '/existing', enabled: true, name: 'Exists' },
        { path: '/missing', enabled: true, name: 'Missing' },
      ]);

      // Only /existing exists
      mockExistsSync.mockImplementation((path) => {
        return String(path).includes('/existing');
      });

      mockDb.get.mockReturnValue(undefined); // No active runners
      mockDb.get.mockReturnValueOnce({ count: 0 }); // No pending work

      const results = wakeup({ quiet: true });

      // Should have skipped /missing
      const skippedResult = results.find(
        (r) => r.projectPath === '/missing' && r.action === 'none'
      );
      expect(skippedResult).toBeDefined();
      expect(skippedResult?.reason).toContain('not found');
    });

    it('should skip projects with active runners', () => {
      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
      ]);

      // Mock: project1 has an active runner
      const mockGet = jest.fn().mockReturnValueOnce({ 1: 1 }); // hasActiveRunnerForProject returns true

      mockDb.prepare.mockReturnValue({
        get: mockGet,
        all: jest.fn(),
        run: jest.fn(),
      });

      const results = wakeup({ quiet: true });

      // Should not spawn a new runner
      expect(mockSpawn).not.toHaveBeenCalled();

      // Should have a result indicating runner already active
      const result = results.find((r) => r.projectPath === '/project1');
      expect(result?.action).toBe('none');
      expect(result?.reason).toContain('already active');
    });

    it('should skip projects with no pending work', () => {
      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
      ]);

      // Mock: no active runner, no pending tasks
      const mockGet = jest.fn()
        .mockReturnValueOnce(undefined) // hasActiveRunnerForProject
        .mockReturnValueOnce({ count: 0 }); // projectHasPendingWork

      mockDb.prepare.mockReturnValue({
        get: mockGet,
        all: jest.fn(),
        run: jest.fn(),
      });

      const results = wakeup({ quiet: true });

      // Should not spawn a new runner
      expect(mockSpawn).not.toHaveBeenCalled();

      // Should have a result indicating no pending tasks
      const result = results.find((r) => r.projectPath === '/project1');
      expect(result?.action).toBe('none');
      expect(result?.reason).toContain('No pending tasks');
    });

    it('should start runners for projects with pending work', () => {
      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
      ]);

      // Mock existsSync for project DB
      mockExistsSync.mockImplementation((path) => String(path).includes('.steroids'));

      // Mock: no active runner, has pending tasks
      const mockGet = jest.fn()
        .mockReturnValueOnce(undefined) // hasActiveRunnerForProject
        .mockReturnValueOnce({ count: 3 }); // projectHasPendingWork

      mockDb.prepare.mockReturnValue({
        get: mockGet,
        all: jest.fn(),
        run: jest.fn(),
      });

      const results = wakeup({ quiet: true });

      // Should spawn a new runner with --project flag
      expect(mockSpawn).toHaveBeenCalledWith(
        'steroids',
        ['runners', 'start', '--detach', '--project', '/project1'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        })
      );

      // Should have a result indicating started
      const result = results.find((r) => r.projectPath === '/project1');
      expect(result?.action).toBe('started');
      expect(result?.pid).toBe(12345);
    });

    it('should handle dry-run mode without spawning', () => {
      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
      ]);

      // Mock existsSync for project DB
      mockExistsSync.mockImplementation((path) => String(path).includes('.steroids'));

      // Mock: no active runner, has pending work
      const mockGet = jest.fn()
        .mockReturnValueOnce(undefined) // hasActiveRunnerForProject
        .mockReturnValueOnce({ count: 3 }); // projectHasPendingWork

      mockDb.prepare.mockReturnValue({
        get: mockGet,
        all: jest.fn(),
        run: jest.fn(),
      });

      const results = wakeup({ quiet: true, dryRun: true });

      // Should NOT spawn
      expect(mockSpawn).not.toHaveBeenCalled();

      // Should have a result indicating would_start
      const result = results.find((r) => r.projectPath === '/project1');
      expect(result?.action).toBe('would_start');
    });

    it('should clean up stale runners before checking projects', () => {
      const staleRunner = {
        id: 'stale-runner-id',
        pid: 99999,
        status: 'running',
      };

      mockFindStaleRunners.mockReturnValue([staleRunner]);
      mockGetRegisteredProjects.mockReturnValue([]);

      // Mock prepare/run for DELETE
      const mockRun = jest.fn();
      const mockPrepare = jest.fn().mockReturnValue({ run: mockRun });
      mockDb.prepare = mockPrepare;

      const results = wakeup({ quiet: true });

      // Should have called prepare with DELETE statement
      expect(mockPrepare).toHaveBeenCalledWith('DELETE FROM runners WHERE id = ?');
      expect(mockRun).toHaveBeenCalledWith('stale-runner-id');

      // Should have a cleanup result
      const cleanupResult = results.find((r) => r.action === 'cleaned');
      expect(cleanupResult).toBeDefined();
      expect(cleanupResult?.staleRunners).toBe(1);
    });

    it('should return empty result when no registered projects', () => {
      mockGetRegisteredProjects.mockReturnValue([]);

      const results = wakeup({ quiet: true });

      // Should have a result indicating no registered projects
      expect(results.length).toBeGreaterThan(0);
      const result = results.find((r) => r.reason === 'No registered projects');
      expect(result).toBeDefined();
      expect(result?.action).toBe('none');
    });
  });

  describe('hasActiveRunnerForProject()', () => {
    it('should return true when a runner is active for the project', () => {
      const mockGet = jest.fn().mockReturnValue({ 1: 1 });
      const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const result = hasActiveRunnerForProject('/project1');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE project_path = ?')
      );
    });

    it('should return false when no runner is active', () => {
      const mockGet = jest.fn().mockReturnValue(undefined);
      const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const result = hasActiveRunnerForProject('/project1');

      expect(result).toBe(false);
    });

    it('should filter out stopped runners', () => {
      // The SQL query includes "status != 'stopped'"
      const mockGet = jest.fn().mockReturnValue(undefined);
      const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const result = hasActiveRunnerForProject('/project1');

      expect(result).toBe(false);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("status != 'stopped'")
      );
    });

    it('should filter out stale runners (heartbeat older than 5 minutes)', () => {
      // The SQL query includes "heartbeat_at > datetime('now', '-5 minutes')"
      const mockGet = jest.fn().mockReturnValue(undefined);
      const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const result = hasActiveRunnerForProject('/project1');

      expect(result).toBe(false);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("heartbeat_at > datetime('now', '-5 minutes')")
      );
    });
  });

  describe('checkWakeupNeeded()', () => {
    it('should return false when runner is healthy', () => {
      mockCheckLockStatus.mockReturnValue({
        locked: true,
        pid: 12345,
        isZombie: false,
      });

      mockFindStaleRunners.mockReturnValue([]);

      const result = checkWakeupNeeded();

      expect(result.needed).toBe(false);
      expect(result.reason).toContain('healthy');
    });

    it('should return true when stale runners exist', () => {
      mockCheckLockStatus.mockReturnValue({
        locked: true,
        pid: 12345,
        isZombie: false,
      });

      mockFindStaleRunners.mockReturnValue([
        { id: 'stale-1', pid: 99999, status: 'running' },
      ]);

      const result = checkWakeupNeeded();

      expect(result.needed).toBe(true);
      expect(result.reason).toContain('stale runner');
    });

    it('should return true when zombie lock exists', () => {
      mockCheckLockStatus.mockReturnValue({
        locked: false,
        isZombie: true,
      });

      const result = checkWakeupNeeded();

      expect(result.needed).toBe(true);
      expect(result.reason).toContain('Zombie lock');
    });

    it('should return true when projects have pending work', () => {
      mockCheckLockStatus.mockReturnValue({
        locked: false,
        isZombie: false,
      });

      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
      ]);

      // Mock existsSync for project DB
      mockExistsSync.mockImplementation((path) => String(path).includes('.steroids'));

      // Mock: project has pending work
      const mockGet = jest.fn().mockReturnValueOnce({ count: 5 });
      const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const result = checkWakeupNeeded();

      expect(result.needed).toBe(true);
      expect(result.reason).toContain('pending tasks');
    });

    it('should return false when no pending work', () => {
      mockCheckLockStatus.mockReturnValue({
        locked: false,
        isZombie: false,
      });

      mockGetRegisteredProjects.mockReturnValue([
        { path: '/project1', enabled: true, name: 'Project 1' },
      ]);

      // Mock: project has no pending work
      const mockGet = jest.fn().mockReturnValueOnce({ count: 0 });
      const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
      mockDb.prepare = mockPrepare;

      const result = checkWakeupNeeded();

      expect(result.needed).toBe(false);
      expect(result.reason).toContain('No pending tasks');
    });
  });
});
