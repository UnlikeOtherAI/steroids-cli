/**
 * Basic wakeup functionality tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

interface TestProject {
  path: string;
  name: string;
  cleanup: () => void;
}

function createTestProject(name: string, taskCounts: {
  pending?: number;
  in_progress?: number;
  review?: number;
  completed?: number;
} = {}): TestProject {
  const projectPath = join('/tmp', `steroids-test-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(projectPath, { recursive: true });
  const steroidsDir = join(projectPath, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });
  const dbPath = join(steroidsDir, 'steroids.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const { pending = 0, in_progress = 0, review = 0, completed = 0 } = taskCounts;
  for (let i = 0; i < pending; i++) {
    db.prepare(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`).run(
      `pending-${i}`, `Pending Task ${i}`, 'pending'
    );
  }
  for (let i = 0; i < in_progress; i++) {
    db.prepare(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`).run(
      `in-progress-${i}`, `In Progress Task ${i}`, 'in_progress'
    );
  }
  for (let i = 0; i < review; i++) {
    db.prepare(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`).run(
      `review-${i}`, `Review Task ${i}`, 'review'
    );
  }
  for (let i = 0; i < completed; i++) {
    db.prepare(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`).run(
      `completed-${i}`, `Completed Task ${i}`, 'completed'
    );
  }
  db.close();
  return {
    path: projectPath,
    name,
    cleanup: () => {
      try {
        rmSync(projectPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

function cleanupTestProjects(projects: TestProject[]): void {
  projects.forEach((p) => p.cleanup());
}

// Mock modules before imports
const mockSpawn = jest.fn();
const mockOpenGlobalDatabase = jest.fn();
const mockGetRegisteredProjects = jest.fn();
const mockFindStaleRunners = jest.fn();
const mockCheckLockStatus = jest.fn();
const mockRemoveLock = jest.fn();

// Mock node:child_process
jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
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

// Create mock database
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

// Import module under test
const { wakeup } = await import('../src/runners/wakeup.js');

describe('wakeup() - basic functionality', () => {
  let testProjects: TestProject[] = [];

  beforeEach(() => {
    jest.clearAllMocks();

    mockCheckLockStatus.mockReturnValue({
      locked: false,
      isZombie: false,
    });

    mockFindStaleRunners.mockReturnValue([]);

    mockOpenGlobalDatabase.mockReturnValue({
      db: mockGlobalDb,
      close: jest.fn(),
    });

    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: jest.fn(),
    });
  });

  afterEach(() => {
    cleanupTestProjects(testProjects);
    testProjects = [];
    jest.clearAllMocks();
  });

  it('should return empty result when no registered projects', async () => {
    mockGetRegisteredProjects.mockReturnValue([]);

    const results = await wakeup({ quiet: true });

    expect(results.length).toBeGreaterThan(0);
    const result = results.find((r) => r.reason === 'No registered projects');
    expect(result).toBeDefined();
    expect(result?.action).toBe('none');
  });

  it('should clean up stale runners before checking projects', async () => {
    const staleRunner = {
      id: 'stale-runner-id',
      pid: 99999,
      status: 'running',
    };

    mockFindStaleRunners.mockReturnValue([staleRunner]);
    mockGetRegisteredProjects.mockReturnValue([]);

    const mockRun = jest.fn();
    const mockPrepare = jest.fn().mockReturnValue({ run: mockRun });
    mockGlobalDb.prepare = mockPrepare;

    const results = await wakeup({ quiet: true });

    expect(mockPrepare).toHaveBeenCalledWith('DELETE FROM runners WHERE id = ?');
    expect(mockRun).toHaveBeenCalledWith('stale-runner-id');

    const cleanupResult = results.find((r) => r.action === 'cleaned');
    expect(cleanupResult).toBeDefined();
    expect(cleanupResult?.staleRunners).toBe(1);
  });

  it('should skip projects that do not exist', async () => {
    mockGetRegisteredProjects.mockReturnValue([
      { path: '/nonexistent-project-12345', enabled: true, name: 'Missing' },
    ]);

    mockGlobalDb.prepare.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      all: jest.fn(),
      run: jest.fn(),
    });

    const results = await wakeup({ quiet: true });

    const skippedResult = results.find(
      (r) => r.projectPath === '/nonexistent-project-12345' && r.action === 'none'
    );
    expect(skippedResult).toBeDefined();
    expect(skippedResult?.reason).toContain('not found');
  });

  it('should skip projects with active runners', async () => {
    const project = createTestProject('with-runner', { pending: 3 });
    testProjects.push(project);

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    // Mock: project has an active runner
    const mockGet = jest.fn().mockReturnValueOnce({ 1: 1 });

    mockGlobalDb.prepare.mockReturnValue({
      get: mockGet,
      all: jest.fn(),
      run: jest.fn(),
    });

    const results = await wakeup({ quiet: true });

    expect(mockSpawn).not.toHaveBeenCalled();

    const result = results.find((r) => r.projectPath === project.path);
    expect(result?.action).toBe('none');
    expect(result?.reason).toContain('already active');
  });

  it('should skip projects with no pending work', async () => {
    const project = createTestProject('no-work', { completed: 5 });
    testProjects.push(project);

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    mockGlobalDb.prepare.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      all: jest.fn(),
      run: jest.fn(),
    });

    const results = await wakeup({ quiet: true });

    expect(mockSpawn).not.toHaveBeenCalled();

    const result = results.find((r) => r.projectPath === project.path);
    expect(result?.action).toBe('none');
    expect(result?.reason).toContain('No pending tasks');
  });
});
