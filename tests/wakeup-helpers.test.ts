/**
 * Tests for wakeup helper functions
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
const mockOpenGlobalDatabase = jest.fn();
const mockGetRegisteredProjects = jest.fn();
const mockFindStaleRunners = jest.fn();
const mockCheckLockStatus = jest.fn();

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
  removeLock: jest.fn(),
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
const {
  hasActiveRunnerForProject,
  hasActiveParallelSessionForProject,
  checkWakeupNeeded,
} = await import('../src/runners/wakeup.js');

describe('hasActiveRunnerForProject()', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockOpenGlobalDatabase.mockReturnValue({
      db: mockGlobalDb,
      close: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return true when a runner is active for the project', () => {
    const mockGet = jest.fn().mockReturnValue({ 1: 1 });
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveRunnerForProject('/project1');

    expect(result).toBe(true);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE project_path = ?')
    );
  });

  it('should return false when no runner is active', () => {
    const mockGet = jest.fn().mockReturnValue(undefined);
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveRunnerForProject('/project1');

    expect(result).toBe(false);
  });

  it('should filter out stopped runners', () => {
    const mockGet = jest.fn().mockReturnValue(undefined);
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveRunnerForProject('/project1');

    expect(result).toBe(false);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("status != 'stopped'")
    );
  });

  it('should filter out stale runners (heartbeat older than 5 minutes)', () => {
    const mockGet = jest.fn().mockReturnValue(undefined);
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveRunnerForProject('/project1');

    expect(result).toBe(false);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat_at > datetime('now', '-5 minutes')")
    );
  });

  it('should ignore parallel runners when checking active runners', () => {
    const mockGet = jest.fn().mockReturnValue(undefined);
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveRunnerForProject('/project1');

    expect(result).toBe(false);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('parallel_session_id IS NULL')
    );
  });
});

describe('hasActiveParallelSessionForProject()', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockOpenGlobalDatabase.mockReturnValue({
      db: mockGlobalDb,
      close: jest.fn(),
    });
  });

  it('should return true when project has an active parallel session', () => {
    const mockGet = jest.fn().mockReturnValue({ 1: 1 });
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveParallelSessionForProject('/project1');

    expect(result).toBe(true);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('SELECT 1 FROM parallel_sessions')
    );
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('status NOT IN')
    );
  });

  it('should return false when project has no active parallel session', () => {
    const mockGet = jest.fn().mockReturnValue(undefined);
    const mockPrepare = jest.fn().mockReturnValue({ get: mockGet });
    mockGlobalDb.prepare = mockPrepare;

    const result = hasActiveParallelSessionForProject('/project1');

    expect(result).toBe(false);
  });
});

describe('checkWakeupNeeded()', () => {
  let testProjects: TestProject[] = [];

  beforeEach(() => {
    jest.clearAllMocks();

    mockOpenGlobalDatabase.mockReturnValue({
      db: mockGlobalDb,
      close: jest.fn(),
    });
  });

  afterEach(() => {
    cleanupTestProjects(testProjects);
    testProjects = [];
    jest.clearAllMocks();
  });

  it('should return false when runner is healthy', async () => {
    mockCheckLockStatus.mockReturnValue({
      locked: true,
      pid: 12345,
      isZombie: false,
    });

    mockFindStaleRunners.mockReturnValue([]);

    const result = await checkWakeupNeeded();

    expect(result.needed).toBe(false);
    expect(result.reason).toContain('healthy');
  });

  it('should return true when stale runners exist', async () => {
    mockCheckLockStatus.mockReturnValue({
      locked: true,
      pid: 12345,
      isZombie: false,
    });

    mockFindStaleRunners.mockReturnValue([
      { id: 'stale-1', pid: 99999, status: 'running' },
    ]);

    const result = await checkWakeupNeeded();

    expect(result.needed).toBe(true);
    expect(result.reason).toContain('stale runner');
  });

  it('should return true when zombie lock exists', async () => {
    mockCheckLockStatus.mockReturnValue({
      locked: false,
      isZombie: true,
    });

    const result = await checkWakeupNeeded();

    expect(result.needed).toBe(true);
    expect(result.reason).toContain('Zombie lock');
  });

  it('should return true when projects have pending work', async () => {
    const project = createTestProject('with-work', { pending: 5 });
    testProjects.push(project);

    mockCheckLockStatus.mockReturnValue({
      locked: false,
      isZombie: false,
    });

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    const result = await checkWakeupNeeded();

    expect(result.needed).toBe(true);
    expect(result.reason).toContain('pending tasks');
  });

  it('should return false when no pending work', async () => {
    const project = createTestProject('no-work', { completed: 10 });
    testProjects.push(project);

    mockCheckLockStatus.mockReturnValue({
      locked: false,
      isZombie: false,
    });

    mockGetRegisteredProjects.mockReturnValue([
      { path: project.path, enabled: true, name: 'Project 1' },
    ]);

    const result = await checkWakeupNeeded();

    expect(result.needed).toBe(false);
    expect(result.reason).toContain('No pending tasks');
  });
});
