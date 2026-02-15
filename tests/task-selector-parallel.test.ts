/**
 * Parallelism-related task selector and orchestrator-loop regression tests
 */

import Database from 'better-sqlite3';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask } from '../src/database/queries.js';

let taskSelector!: typeof import('../src/orchestrator/task-selector.js');

beforeEach(async () => {
  taskSelector = await import('../src/orchestrator/task-selector.js');
});

function createTaskDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function task(overrides: Record<string, any> = {}) {
  return {
    id: 'task-1',
    title: 'Task 1',
    status: 'review',
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

describe('task-selector parallel behaviors', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTaskDb();
  });

  afterEach(() => {
    db.close();
  });

  it('supports single-section backward compatibility with sectionId', () => {
    const { selectNextTask } = taskSelector;
    const sectionA = createSection(db, 'Section A');
    const sectionB = createSection(db, 'Section B');

    createTask(db, 'Section B task', { sectionId: sectionB.id });
    createTask(db, 'Section A task', { sectionId: sectionA.id });

    const selected = selectNextTask(db, sectionA.id);

    expect(selected).not.toBeNull();
    expect(selected?.task.title).toBe('Section A task');
  });

  it('processes sectionIds[] in the declared order', () => {
    const { selectNextTask } = taskSelector;
    const sectionA = createSection(db, 'Section A');
    const sectionB = createSection(db, 'Section B');

    createTask(db, 'Section A task', { sectionId: sectionA.id });
    createTask(db, 'Section B task', { sectionId: sectionB.id });

    const selected = selectNextTask(db, [sectionB.id, sectionA.id]);

    expect(selected).not.toBeNull();
    expect(selected?.task.title).toBe('Section B task');
  });

  it('returns null when the current section has locked pending tasks', () => {
    const { selectNextTaskWithLock } = taskSelector;
    const sectionA = createSection(db, 'Section A');
    const sectionB = createSection(db, 'Section B');
    const lockedTask = createTask(db, 'Locked task', { sectionId: sectionA.id });
    createTask(db, 'Unlocked task', { sectionId: sectionB.id });

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES (?, ?, ?)'
    ).run(lockedTask.id, 'other-runner', expiresAt);

    const selected = selectNextTaskWithLock(db, {
      runnerId: 'current-runner',
      sectionIds: [sectionA.id, sectionB.id],
      timeoutMinutes: 1,
    });

    expect(selected).toBeNull();
  });

  it('advances to next section only when current section is idle', () => {
    const { selectNextTask } = taskSelector;
    const sectionA = createSection(db, 'Section A');
    const sectionB = createSection(db, 'Section B');

    createTask(db, 'Active task', { sectionId: sectionA.id, status: 'in_progress' });
    createTask(db, 'Next task', { sectionId: sectionB.id, status: 'pending' });

    const active = selectNextTask(db, [sectionA.id, sectionB.id]);
    expect(active).not.toBeNull();
    expect(active?.task.title).toBe('Active task');

    db.prepare('UPDATE tasks SET status = ? WHERE section_id = ?').run('completed', sectionA.id);

    const selected = selectNextTask(db, [sectionA.id, sectionB.id]);
    expect(selected).not.toBeNull();
    expect(selected?.task.title).toBe('Next task');
  });

  it('detects section pending/in_progress work via hasPendingOrInProgressWork', () => {
    const { hasPendingOrInProgressWork } = taskSelector;
    const sectionA = createSection(db, 'Section A');

    expect(hasPendingOrInProgressWork(db, sectionA.id)).toBe(false);

    createTask(db, 'Pending task', { sectionId: sectionA.id, status: 'pending' });
    expect(hasPendingOrInProgressWork(db, sectionA.id)).toBe(true);

    db.prepare('UPDATE tasks SET status = ? WHERE section_id = ?').run('completed', sectionA.id);
    expect(hasPendingOrInProgressWork(db, sectionA.id)).toBe(false);
  });

  it('checks completion when all scoped sections are complete', () => {
    const { areAllTasksComplete } = taskSelector;
    const sectionA = createSection(db, 'Section A');
    const sectionB = createSection(db, 'Section B');

    createTask(db, 'Completed task', { sectionId: sectionA.id, status: 'completed' });

    expect(areAllTasksComplete(db, [sectionA.id, sectionB.id])).toBe(true);

    createTask(db, 'Pending task', { sectionId: sectionB.id, status: 'pending' });
    expect(areAllTasksComplete(db, [sectionA.id, sectionB.id])).toBe(false);
  });

  it('normalizes section filter inputs', () => {
    const { normalizeSectionFilters } = taskSelector;
    const sectionA = 'section-a';
    const sectionIds = ['section-b', 'section-c'];

    expect(normalizeSectionFilters(sectionA)).toEqual([sectionA]);
    expect(normalizeSectionFilters(undefined, sectionIds)).toEqual(sectionIds);
    expect(normalizeSectionFilters(undefined, sectionIds)).not.toBe(sectionIds);
    expect(normalizeSectionFilters(sectionA, sectionIds)).toEqual(sectionIds);
  });
});

describe('orchestrator loop and runner wiring', () => {
  const mockOpenDatabase = jest.fn();
  const mockGetDbPath = jest.fn().mockReturnValue('/tmp/test/.steroids/steroids.db');
  const mockAutoMigrate = jest.fn().mockReturnValue({ applied: false, migrations: [] });
  const mockGetTask = jest.fn() as jest.Mock;
  const mockGetSection = jest.fn().mockReturnValue(null) as jest.Mock;
  const mockSelectNextTask = jest.fn() as jest.Mock;
  const mockSelectTaskBatch = jest.fn() as jest.Mock;
  const mockMarkTaskInProgress = jest.fn() as jest.Mock;
  const mockGetTaskCounts = jest.fn().mockReturnValue({
    pending: 0,
    in_progress: 0,
    review: 0,
    completed: 0,
    disputed: 0,
    failed: 0,
    total: 0,
  }) as jest.Mock;
  const mockInvokeCoderBatch = jest.fn();
  const mockInvokeReviewerBatch = jest.fn();
  const mockLoadConfig = jest.fn() as jest.Mock;
  const mockListTasks = jest.fn().mockReturnValue([]);
  const mockLogActivity = jest.fn();
  const mockGetRegisteredProject = jest.fn().mockReturnValue(null);
  const mockRunCoderPhase = jest.fn() as jest.Mock;
  const mockRunReviewerPhase = jest.fn() as jest.Mock;
  const mockHandleCreditExhaustion = jest.fn() as jest.Mock;
  const mockCheckBatchCreditExhaustion = jest.fn() as jest.Mock;
  const mockOpenGlobalDatabase = jest.fn() as jest.Mock;

  let runOrchestratorLoop: typeof import('../src/runners/orchestrator-loop.js').runOrchestratorLoop;
  let registerRunner: typeof import('../src/runners/daemon.js').registerRunner;

  let globalDb: Database.Database;
  let loopDb: any;
  let closeLoopDb: jest.Mock;
  let closeGlobalDb: jest.Mock;

  beforeAll(async () => {
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
      getTaskCountsByStatus: jest.fn().mockReturnValue({
        pending: 0,
        in_progress: 0,
        review: 0,
        completed: 0,
      }),
      updateTaskStatus: jest.fn(),
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
      getRegisteredProjects: jest.fn().mockReturnValue([]),
      updateProjectStats: jest.fn(),
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
      execSync: jest.fn(),
      spawn: jest.fn(),
    }));
    jest.unstable_mockModule('../src/runners/global-db.js', () => ({
      openGlobalDatabase: mockOpenGlobalDatabase,
      getGlobalSteroidsDir: () => '/tmp/.steroids',
      getGlobalDbPath: () => '/tmp/.steroids/steroids.db',
      isGlobalDbInitialized: () => true,
    }));

    const { runOrchestratorLoop: loadedRunLoop } = await import('../src/runners/orchestrator-loop.js');
    const { registerRunner: loadedRegisterRunner } = await import('../src/runners/daemon.js');
    runOrchestratorLoop = loadedRunLoop;
    registerRunner = loadedRegisterRunner;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    loopDb = {};
    closeLoopDb = jest.fn();
    mockOpenDatabase.mockReturnValue({ db: loopDb, close: closeLoopDb });
    mockGetDbPath.mockReturnValue('/tmp/test/.steroids/steroids.db');
    mockAutoMigrate.mockReturnValue({ applied: false, migrations: [] });
    mockLoadConfig.mockReturnValue({ sections: { batchMode: false, maxBatchSize: 10 } });
    mockGetTask.mockReturnValue(task());
    mockSelectNextTask.mockReturnValue(null);
    (mockHandleCreditExhaustion as any).mockResolvedValue({ resolved: false, resolution: 'stopped' });

    closeGlobalDb = jest.fn();
    globalDb = new Database(':memory:');
    globalDb.exec(`
      CREATE TABLE runners (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        pid INTEGER,
        project_path TEXT,
        section_id TEXT,
        parallel_session_id TEXT,
        current_task_id TEXT,
        started_at TEXT,
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    mockOpenGlobalDatabase.mockReturnValue({ db: globalDb, close: closeGlobalDb });

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (globalDb) {
      globalDb.close();
    }
    jest.restoreAllMocks();
  });

  it('passes branchName to the reviewer phase for review pushes', async () => {
    const reviewTask = task({ id: 'task-review', status: 'review' });
    mockSelectNextTask
      .mockReturnValueOnce({ task: reviewTask, action: 'review' })
      .mockReturnValueOnce(null);
    (mockRunReviewerPhase as any).mockResolvedValue(undefined);
    mockGetTask.mockReturnValue(reviewTask);

    await runOrchestratorLoop({
      projectPath: '/tmp/test',
      branchName: 'steroids/ws-stream',
    });

    expect(mockRunReviewerPhase).toHaveBeenCalledWith(
      loopDb,
      reviewTask,
      '/tmp/test',
      false,
      undefined,
      'steroids/ws-stream'
    );
  });

  it('defaults branchName to main when not provided', async () => {
    const reviewTask = task({ id: 'task-review', status: 'review' });
    mockSelectNextTask
      .mockReturnValueOnce({ task: reviewTask, action: 'review' })
      .mockReturnValueOnce(null);
    (mockRunReviewerPhase as any).mockResolvedValue(undefined);
    mockGetTask.mockReturnValue(reviewTask);

    await runOrchestratorLoop({
      projectPath: '/tmp/test',
    });

    expect(mockRunReviewerPhase).toHaveBeenCalledWith(
      loopDb,
      reviewTask,
      '/tmp/test',
      false,
      undefined,
      'main'
    );
  });

  it('registers runner with parallelSessionId', () => {
    const { runnerId, close } = registerRunner('/tmp/parallel-project', {
      sectionIds: ['sec-A', 'sec-B'],
      parallelSessionId: 'session-1',
    });

    const row = globalDb.prepare(
      'SELECT section_id, parallel_session_id FROM runners WHERE id = ?'
    ).get(runnerId) as { section_id: string; parallel_session_id: string } | undefined;

    expect(row?.section_id).toBe('sec-A');
    expect(row?.parallel_session_id).toBe('session-1');
    close();
  });
});
