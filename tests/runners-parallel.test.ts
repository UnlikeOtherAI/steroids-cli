import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { addSectionDependency, createSection, createTask } from '../src/database/queries.js';

interface MockSpawnHandle {
  pid: number;
  unref: jest.SpiedFunction<any>;
}

const mockLoadConfig = jest.fn();
const mockCreateWorkspaceClone = jest.fn();
const mockOpenGlobalDatabase = jest.fn();
const mockSpawn = jest.fn();

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/parallel/clone.js', () => ({
  createWorkspaceClone: mockCreateWorkspaceClone,
}));

jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
  getGlobalSteroidsDir: () => '/tmp/.steroids',
  getGlobalDbPath: () => '/tmp/.steroids/steroids.db',
  isGlobalDbInitialized: () => true,
}));

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

const createMockProcess = (pid: number = 9001): MockSpawnHandle => ({
  pid,
  unref: jest.fn(),
});

let testModule: typeof import('../src/commands/runners-parallel.js');

const tempPaths: string[] = [];

type TestProject = {
  path: string;
  db: Database.Database;
  close: () => void;
};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  tempPaths.push(dir);
  return dir;
}

function createTestProject(): TestProject {
  const projectPath = makeTempDir('steroids-parallel-plan');
  const steroidsDir = path.join(projectPath, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });

  const dbPath = path.join(steroidsDir, 'steroids.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  return {
    path: projectPath,
    db,
    close: () => db.close(),
  };
}

function cleanupTempDirs(): void {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

beforeEach(async () => {
  if (!testModule) {
    testModule = await import('../src/commands/runners-parallel.js');
  }

  jest.clearAllMocks();

  mockLoadConfig.mockReturnValue({
    runners: {
      parallel: {
        enabled: true,
        maxClones: 3,
      },
      daemonLogs: false,
    },
  });

  mockSpawn.mockReturnValue(createMockProcess(9001));
});

afterEach(() => {
  cleanupTempDirs();
});

describe('parseSectionIds', () => {
  it('splits comma-separated section IDs and trims whitespace', () => {
    expect(testModule.parseSectionIds('abc, def ,  ,ghi')).toEqual(['abc', 'def', 'ghi']);
  });
});

describe('getConfiguredMaxClones', () => {
  it('uses configured max clones when valid', () => {
    mockLoadConfig.mockReturnValue({
      runners: {
        parallel: {
          maxClones: 5,
          enabled: true,
        },
      },
    });

    expect(testModule.getConfiguredMaxClones('/tmp/project')).toBe(5);
  });

  it('falls back to 3 when config max clones is invalid', () => {
    mockLoadConfig.mockReturnValue({
      runners: {
        parallel: {
          maxClones: 0,
          enabled: true,
        },
      },
    });

    expect(testModule.getConfiguredMaxClones('/tmp/project')).toBe(3);
  });
});

describe('buildParallelRunPlan', () => {
  it('builds a plan with dependency partitioning and max-clone override', () => {
    const project = createTestProject();

    const sectionA = createSection(project.db, 'Section A');
    const sectionB = createSection(project.db, 'Section B');
    const sectionC = createSection(project.db, 'Section C');

    createTask(project.db, 'A task', { sectionId: sectionA.id });
    createTask(project.db, 'B task', { sectionId: sectionB.id });
    createTask(project.db, 'C task', { sectionId: sectionC.id });

    addSectionDependency(project.db, sectionC.id, sectionB.id);

    const plan = testModule.buildParallelRunPlan(project.path, 2);

    expect(plan.maxClones).toBe(2);
    expect(plan.workstreams.length).toBe(2);
    expect(plan.workstreams[0].sectionIds.length).toBe(1);

    project.close();
  });

  it('throws when parallel mode is disabled', () => {
    const project = createTestProject();
    mockLoadConfig.mockReturnValue({
      runners: {
        parallel: {
          enabled: false,
          maxClones: 2,
        },
      },
    });

    expect(() => {
      testModule.buildParallelRunPlan(project.path);
    }).toThrow('Parallel mode is disabled. Set runners.parallel.enabled: true to use --parallel.');

    project.close();
  });

  it('throws when dependency cycle is detected', () => {
    const project = createTestProject();

    const sectionA = createSection(project.db, 'A');
    const sectionB = createSection(project.db, 'B');

    createTask(project.db, 'A task', { sectionId: sectionA.id });

    project.db
      .prepare('INSERT INTO section_dependencies (section_id, depends_on_section_id) VALUES (?, ?)')
      .run(sectionA.id, sectionB.id);
    project.db
      .prepare('INSERT INTO section_dependencies (section_id, depends_on_section_id) VALUES (?, ?)')
      .run(sectionB.id, sectionA.id);

    expect(() => {
      testModule.buildParallelRunPlan(project.path);
    }).toThrow(testModule.CyclicDependencyError);

    project.close();
  });
});

describe('launchParallelSession', () => {
  it('records workstreams and starts detached clone runners', () => {
    const globalDb = new Database(':memory:');
    globalDb.exec(`
      CREATE TABLE parallel_sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE workstreams (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        section_ids TEXT NOT NULL,
        clone_path TEXT,
        status TEXT NOT NULL,
        runner_id TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const close = jest.fn();
    mockOpenGlobalDatabase.mockReturnValue({ db: globalDb, close });

    const workspacePath = makeTempDir('steroids-parallel-workspace');
    mockCreateWorkspaceClone.mockReturnValue({ workspacePath });

    mockSpawn.mockReturnValue(createMockProcess(1234));

    const plan: Parameters<typeof testModule.launchParallelSession>[0] = {
      sessionId: 'session-1',
      projectPath: '/tmp/project',
      maxClones: 3,
      workstreams: [
        {
          id: 'ws-abc',
          branchName: 'steroids/ws-abc',
          sectionIds: ['sec-1', 'sec-2'],
          sectionNames: ['Section 1', 'Section 2'],
        },
      ],
    };

    const sessionId = testModule.launchParallelSession(plan, '/tmp/project');

    expect(sessionId).toBe('session-1');
    const session = globalDb
      .prepare('SELECT id, project_path, status FROM parallel_sessions WHERE id = ?')
      .get('session-1') as { id: string; project_path: string; status: string };
    expect(session).toMatchObject({
      id: 'session-1',
      project_path: '/tmp/project',
      status: 'running',
    });

    const workstream = globalDb
      .prepare('SELECT id, branch_name, section_ids, clone_path, status FROM workstreams WHERE id = ?')
      .get('ws-abc') as {
        id: string;
        branch_name: string;
        section_ids: string;
        clone_path: string;
        status: string;
      };

    expect(workstream).toMatchObject({
      id: 'ws-abc',
      branch_name: 'steroids/ws-abc',
      status: 'running',
      section_ids: JSON.stringify(['sec-1', 'sec-2']),
      clone_path: workspacePath,
    });

    expect(mockSpawn).toHaveBeenCalledWith(process.execPath, [
      process.argv[1],
      'runners',
      'start',
      '--project',
      workspacePath,
      '--parallel',
      '--section-ids',
      'sec-1,sec-2',
      '--branch',
      'steroids/ws-abc',
      '--parallel-session-id',
      'session-1',
    ], {
      detached: true,
      stdio: 'ignore',
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnedProcess = mockSpawn.mock.results[0].value as { unref: jest.Mock };
    expect(spawnedProcess.unref).toHaveBeenCalled();

    const workstreamCount = globalDb
      .prepare('SELECT COUNT(*) AS count FROM workstreams')
      .get() as { count: number };
    expect(workstreamCount.count).toBeGreaterThan(0);

    expect(globalDb
      .prepare('SELECT id FROM workstreams WHERE id = ?')
      .get('ws-abc')
    ).toMatchObject({ id: 'ws-abc' });

    globalDb.close();
  });
});

describe('spawnDetachedRunner', () => {
  it('uses ignore stdio when daemon logs are disabled', () => {
    const child = createMockProcess(4321);
    mockSpawn.mockReturnValue(child);

    const result = testModule.spawnDetachedRunner({
      projectPath: '/tmp/project',
      args: ['runners', 'start'],
    });

    expect(result).toEqual({ pid: 4321 });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['runners', 'start'],
      {
        detached: true,
        stdio: 'ignore',
      }
    );
  });

  it('creates a log file and returns renamed log path when daemon logs are enabled', () => {
    mockLoadConfig.mockReturnValue({
      runners: {
        parallel: {
          enabled: true,
          maxClones: 3,
        },
        daemonLogs: true,
      },
    });

    const child = createMockProcess(9876);
    mockSpawn.mockReturnValue(child);

    const result = testModule.spawnDetachedRunner({
      projectPath: '/tmp/project',
      args: ['runners', 'start'],
    });

    expect(result).toMatchObject({ pid: 9876 });
    expect(result.logFile).toMatch(/daemon-9876\.log$/);
    expect(child.unref).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(process.execPath, ['runners', 'start'], {
      detached: true,
      stdio: expect.arrayContaining([expect.any(Number)]),
    });
  });
});
