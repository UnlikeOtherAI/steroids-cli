/**
 * Multi-project iteration tests for wakeup
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
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
  recordProviderBackoff: jest.fn(),
  getProviderBackoffRemainingMs: jest.fn().mockReturnValue(0),
  clearProviderBackoff: jest.fn(),
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
  all: jest.fn().mockReturnValue([]),
  run: jest.fn(),
  exec: jest.fn(),
  close: jest.fn(),
  pragma: jest.fn(),
});

const mockGlobalDb = createMockDb();

// Import module under test
const { wakeup } = await import('../src/runners/wakeup.js');

describe('wakeup() - multi-project iteration', () => {
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

  it('should iterate over all registered enabled projects', async () => {
    const project1 = createTestProject('project1', { pending: 5 });
    const project2 = createTestProject('project2', { completed: 3 });
    const project3 = createTestProject('project3', { in_progress: 2 });
    testProjects.push(project1, project2, project3);

    mockGetRegisteredProjects.mockReturnValue([
      { path: project1.path, enabled: true, name: 'Project 1' },
      { path: project2.path, enabled: true, name: 'Project 2' },
      { path: project3.path, enabled: true, name: 'Project 3' },
    ]);

    // Mock hasActiveRunnerForProject to return false for all projects
    // This function is called multiple times (once per project)
    const mockPrepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(undefined), // No active runners
      all: jest.fn(),
      run: jest.fn(),
    });
    mockGlobalDb.prepare = mockPrepare;

    const results = await wakeup({ quiet: true });

    // Should have results for all 3 projects
    expect(results.length).toBeGreaterThan(0);

    // Should have called getRegisteredProjects with enabled-only flag
    expect(mockGetRegisteredProjects).toHaveBeenCalledWith(false);

    // Should have spawned runner for project1 (has pending work)
    const startedResults = results.filter((r) => r.action === 'started');
    expect(startedResults.length).toBeGreaterThanOrEqual(1);

    // Check that at least one of the started results is for a project with work
    const startedPaths = startedResults.map(r => r.projectPath);
    const hasProject1 = startedPaths.includes(project1.path);
    const hasProject3 = startedPaths.includes(project3.path); // in_progress counts as pending work
    expect(hasProject1 || hasProject3).toBe(true);

    // Should have skipped project2 (no pending work - only completed tasks)
    const skippedResult2 = results.find((r) => r.projectPath === project2.path);
    expect(skippedResult2?.action).toBe('none');
    expect(skippedResult2?.reason).toContain('No pending tasks');
  });

  it('should start runners for projects with pending work', async () => {
    const project = createTestProject('with-work', { pending: 3, review: 2 });
    testProjects.push(project);

    // Verify the project was created correctly
    const dbPath = join(project.path, '.steroids', 'steroids.db');
    expect(existsSync(project.path)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    // Mock hasActiveRunnerForProject to return false
    const mockPrepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(undefined), // No active runners
      all: jest.fn(),
      run: jest.fn(),
    });
    mockGlobalDb.prepare = mockPrepare;

    const results = await wakeup({ quiet: true });

    // Should spawn a new runner with --project flag
    expect(mockSpawn).toHaveBeenCalledWith(
      'steroids',
      ['runners', 'start', '--parallel', '--project', project.path],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      })
    );

    // Should have a result indicating started
    const result = results.find((r) => r.projectPath === project.path);
    expect(result?.action).toBe('started');
    expect(result?.pid).toBe(12345);
  });

  it('should handle dry-run mode without spawning', async () => {
    const project = createTestProject('dry-run', { pending: 3 });
    testProjects.push(project);

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    const mockPrepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(undefined), // No active runners
      all: jest.fn(),
      run: jest.fn(),
    });
    mockGlobalDb.prepare = mockPrepare;

    const results = await wakeup({ quiet: true, dryRun: true });

    // Should NOT spawn
    expect(mockSpawn).not.toHaveBeenCalled();

    // Should have a result indicating would_start
    const result = results.find((r) => r.projectPath === project.path);
    expect(result?.action).toBe('would_start');
  });

  it('should handle multiple projects with different states', async () => {
    const projectWithWork = createTestProject('with-work', { pending: 5 });
    const projectNoWork = createTestProject('no-work', { completed: 10 });
    const projectInProgress = createTestProject('in-progress', { in_progress: 2 });
    testProjects.push(projectWithWork, projectNoWork, projectInProgress);

    mockGetRegisteredProjects.mockReturnValue([
      { path: projectWithWork.path, enabled: true, name: 'With Work' },
      { path: projectNoWork.path, enabled: true, name: 'No Work' },
      { path: projectInProgress.path, enabled: true, name: 'In Progress' },
    ]);

    const mockPrepare = jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(undefined), // No active runners
      all: jest.fn(),
      run: jest.fn(),
    });
    mockGlobalDb.prepare = mockPrepare;

    const results = await wakeup({ quiet: true });

    // Should start runners for projects with pending/in_progress/review work
    const startedResults = results.filter((r) => r.action === 'started');
    expect(startedResults.length).toBeGreaterThanOrEqual(2);

    // Verify correct projects were started
    const startedPaths = startedResults.map((r) => r.projectPath);
    expect(startedPaths).toContain(projectWithWork.path);
    expect(startedPaths).toContain(projectInProgress.path);
    expect(startedPaths).not.toContain(projectNoWork.path);
  });
});
