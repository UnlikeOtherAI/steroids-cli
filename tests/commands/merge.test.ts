import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultFlags, type GlobalFlags } from '../../src/cli/flags.js';

const mockOpenGlobalDatabase = jest.fn();
const mockOpenDatabase = jest.fn();
const mockRunParallelMerge = jest.fn() as unknown as jest.Mock;

jest.unstable_mockModule('../../src/runners/global-db.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
}));

jest.unstable_mockModule('../../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../../src/parallel/merge.js', () => ({
  runParallelMerge: mockRunParallelMerge,
}));

interface MergeResult {
  success: boolean;
  completedCommits: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

let mergeCommand: (args: string[], flags: GlobalFlags) => Promise<void>;

const tempPaths: string[] = [];
let globalDb: Database.Database;
let originalCwd = process.cwd();
let consoleLogSpy: ReturnType<typeof jest.spyOn>;
let processExitSpy: ReturnType<typeof jest.spyOn>;

function createGlobalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parallel_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      section_ids TEXT NOT NULL,
      status TEXT NOT NULL,
      clone_path TEXT,
      runner_id TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeProjectPath(prefix: string): string {
  const projectPath = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  const steroidsDir = path.join(projectPath, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });
  writeFileSync(path.join(steroidsDir, 'steroids.db'), '');
  tempPaths.push(projectPath);
  return projectPath;
}

function writeParallelSession(
  db: Database.Database,
  id: string,
  projectPath: string,
  createdAt: string = new Date().toISOString(),
  status = 'running'
): void {
  db.prepare(
    'INSERT INTO parallel_sessions (id, project_path, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, projectPath, status, createdAt);
}

function writeWorkstream(
  db: Database.Database,
  options: {
    id: string;
    sessionId: string;
    branchName: string;
    sectionIds: string[];
    status?: string;
    createdAt?: string;
    completedAt?: string | null;
  }
): void {
  const {
    id,
    sessionId,
    branchName,
    sectionIds,
    status = 'completed',
    createdAt = new Date().toISOString(),
    completedAt = new Date().toISOString(),
  } = options;

  db.prepare(`
    INSERT INTO workstreams (
      id,
      session_id,
      branch_name,
      section_ids,
      status,
      created_at,
      completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionId,
    branchName,
    JSON.stringify(sectionIds),
    status,
    createdAt,
    completedAt
  );
}

function parseSuccessPayload(mock: ReturnType<typeof jest.spyOn>): any {
  return JSON.parse(mock.mock.calls[0]?.[0] as string) as any;
}

function parseErrorPayload(mock: ReturnType<typeof jest.spyOn>): any {
  return JSON.parse(mock.mock.calls[0]?.[0] as string) as any;
}

function registerMergeSuccess(
  result: MergeResult = {
    success: true,
    completedCommits: 2,
    conflicts: 1,
    skipped: 0,
    errors: [],
  }
): void {
  (mockRunParallelMerge as any).mockResolvedValue(result);
}

beforeEach(async () => {
  jest.clearAllMocks();
  originalCwd = process.cwd();
  globalDb = createGlobalDb();

  mockOpenGlobalDatabase.mockReturnValue({
    db: globalDb,
    close: jest.fn(),
  });

  mockOpenDatabase.mockReturnValue({
    close: jest.fn(),
  });

  registerMergeSuccess({
    success: true,
    completedCommits: 0,
    conflicts: 0,
    skipped: 0,
    errors: [],
  });

  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as any;

  ({ mergeCommand } = await import('../../src/commands/merge.js'));
});

afterEach(() => {
  if (process.cwd() !== originalCwd) {
    process.chdir(originalCwd);
  }

  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target && existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }

  if (globalDb) {
    globalDb.close();
  }

  consoleLogSpy.mockRestore();
  processExitSpy.mockRestore();
});

describe('mergeCommand', () => {
  it('resolves latest session for a project by created_at', async () => {
    const projectPath = makeProjectPath('steroids-merge-latest');
    writeParallelSession(globalDb, 'old', projectPath, '2024-01-01T00:00:00Z');
    writeParallelSession(globalDb, 'latest', projectPath, '2024-01-02T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-latest',
      sessionId: 'latest',
      branchName: 'steroids/ws-latest',
      sectionIds: ['A'],
      completedAt: '2024-01-02T00:00:00Z',
      createdAt: '2024-01-02T00:00:00Z',
    });
    writeWorkstream(globalDb, {
      id: 'ws-old',
      sessionId: 'old',
      branchName: 'steroids/ws-old',
      sectionIds: ['B'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    await mergeCommand(['--project', projectPath], {
      ...getDefaultFlags(),
      dryRun: true,
      json: true,
    });

    const payload = parseSuccessPayload(consoleLogSpy);
    expect(payload.data.session_id).toBe('latest');
  });

  it('resolves a specific session when --session is provided', async () => {
    const projectPath = makeProjectPath('steroids-merge-specific');
    writeParallelSession(globalDb, 'specific', projectPath, '2024-01-03T00:00:00Z');
    writeParallelSession(globalDb, 'fallback', projectPath, '2024-01-04T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-specific',
      sessionId: 'specific',
      branchName: 'steroids/ws-specific',
      sectionIds: ['A'],
      completedAt: '2024-01-03T00:00:00Z',
      createdAt: '2024-01-03T00:00:00Z',
    });
    writeWorkstream(globalDb, {
      id: 'ws-fallback',
      sessionId: 'fallback',
      branchName: 'steroids/ws-fallback',
      sectionIds: ['A'],
      completedAt: '2024-01-04T00:00:00Z',
      createdAt: '2024-01-04T00:00:00Z',
    });

    await mergeCommand(['--project', projectPath, '--session', 'specific'], {
      ...getDefaultFlags(),
      dryRun: true,
      json: true,
    });

    const payload = parseSuccessPayload(consoleLogSpy);
    expect(payload.data.session_id).toBe('specific');
  });

  it('resolves a specific session when --session-id alias is provided', async () => {
    const projectPath = makeProjectPath('steroids-merge-session-alias');
    writeParallelSession(globalDb, 'specific', projectPath, '2024-01-03T00:00:00Z');
    writeParallelSession(globalDb, 'fallback', projectPath, '2024-01-04T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-specific',
      sessionId: 'specific',
      branchName: 'steroids/ws-specific',
      sectionIds: ['A'],
      completedAt: '2024-01-03T00:00:00Z',
      createdAt: '2024-01-03T00:00:00Z',
    });
    writeWorkstream(globalDb, {
      id: 'ws-fallback',
      sessionId: 'fallback',
      branchName: 'steroids/ws-fallback',
      sectionIds: ['A'],
      completedAt: '2024-01-04T00:00:00Z',
      createdAt: '2024-01-04T00:00:00Z',
    });

    await mergeCommand(['--project', projectPath, '--session-id', 'specific'], {
      ...getDefaultFlags(),
      dryRun: true,
      json: true,
    });

    const payload = parseSuccessPayload(consoleLogSpy);
    expect(payload.data.session_id).toBe('specific');
  });

  it('orders workstreams by completed_at for merge execution', async () => {
    const projectPath = makeProjectPath('steroids-merge-order');
    writeParallelSession(globalDb, 'order-session', projectPath, '2024-01-01T00:00:00Z');

    writeWorkstream(globalDb, {
      id: 'ws-mid',
      sessionId: 'order-session',
      branchName: 'steroids/ws-mid',
      sectionIds: ['sec-2'],
      completedAt: '2024-01-03T00:00:00Z',
      createdAt: '2024-01-03T00:00:00Z',
    });
    writeWorkstream(globalDb, {
      id: 'ws-old',
      sessionId: 'order-session',
      branchName: 'steroids/ws-old',
      sectionIds: ['sec-1'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });
    writeWorkstream(globalDb, {
      id: 'ws-new',
      sessionId: 'order-session',
      branchName: 'steroids/ws-new',
      sectionIds: ['sec-3'],
      completedAt: null,
      createdAt: '2024-01-04T00:00:00Z',
    });

    registerMergeSuccess();

    await mergeCommand(['--project', projectPath], {
      ...getDefaultFlags(),
      json: true,
    });

    const request = mockRunParallelMerge.mock.calls[0]?.[0] as {
      sessionId: string;
      workstreams: Array<{ id: string; branchName: string }>;
    };

    expect(request.sessionId).toBe('order-session');
    expect(request.workstreams.map((item) => item.id)).toEqual([
      'ws-old',
      'ws-mid',
      'ws-new',
    ]);
  });

  it('returns parseable dry-run output including section ids', async () => {
    const projectPath = makeProjectPath('steroids-merge-dry');
    writeParallelSession(globalDb, 'dry-session', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-dry',
      sessionId: 'dry-session',
      branchName: 'steroids/ws-dry',
      sectionIds: ['alpha', 'beta'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    await mergeCommand(['--project', projectPath], {
      ...getDefaultFlags(),
      dryRun: true,
      json: true,
    });

    const payload = parseSuccessPayload(consoleLogSpy);
    expect(payload.data.workstreams).toHaveLength(1);
    expect(payload.data.workstreams[0].section_ids).toEqual(['alpha', 'beta']);
  });

  it('defaults to current working directory when --project is omitted', async () => {
    const projectPath = makeProjectPath('steroids-merge-default-project');
    process.chdir(projectPath);
    const resolvedProjectPath = path.resolve(process.cwd());

    writeParallelSession(globalDb, 'default', resolvedProjectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-default',
      sessionId: 'default',
      branchName: 'steroids/ws-default',
      sectionIds: ['default'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    await mergeCommand([], {
      ...getDefaultFlags(),
      dryRun: true,
      json: true,
    });

    const payload = parseSuccessPayload(consoleLogSpy);
    expect(payload.data.project_path).toBe(resolvedProjectPath);
    expect(payload.data.session_id).toBe('default');
  });

  it('passes CLI merge options through to runParallelMerge', async () => {
    const projectPath = makeProjectPath('steroids-merge-options');
    writeParallelSession(globalDb, 'session', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-options',
      sessionId: 'session',
      branchName: 'steroids/ws-options',
      sectionIds: ['alpha'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    registerMergeSuccess({
      success: true,
      completedCommits: 5,
      conflicts: 1,
      skipped: 0,
      errors: [],
    });

    await mergeCommand(
      ['--project', projectPath, '--remote', 'upstream', '--main-branch', 'trunk'],
      { ...getDefaultFlags(), json: true }
    );

    const request = mockRunParallelMerge.mock.calls[0]?.[0] as {
      projectPath: string;
      remote: string;
      mainBranch: string;
    };

    expect(request.projectPath).toBe(projectPath);
    expect(request.remote).toBe('upstream');
    expect(request.mainBranch).toBe('trunk');
  });

  it('outputs success payload after a merge completes', async () => {
    const projectPath = makeProjectPath('steroids-merge-success');
    writeParallelSession(globalDb, 'session', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-success',
      sessionId: 'session',
      branchName: 'steroids/ws-success',
      sectionIds: ['alpha'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    registerMergeSuccess({
      success: true,
      completedCommits: 4,
      conflicts: 2,
      skipped: 1,
      errors: [],
    });

    await mergeCommand(['--project', projectPath], { ...getDefaultFlags(), json: true });

    const payload = parseSuccessPayload(consoleLogSpy);
    expect(payload.success).toBe(true);
    expect(payload.data.completed_commits).toBe(4);
    expect(payload.data.conflicts).toBe(2);
    expect(payload.data.skipped).toBe(1);
    expect(payload.data.session_id).toBe('session');
  });

  it('returns not found when explicit session id does not exist', async () => {
    const projectPath = makeProjectPath('steroids-merge-missing');
    writeParallelSession(globalDb, 'other', projectPath, '2024-01-01T00:00:00Z');

    await expect(
      mergeCommand(['--project', projectPath, '--session', 'missing'], {
        ...getDefaultFlags(),
        json: true,
      })
    ).rejects.toThrow('Parallel session not found: missing');
  });

  it('returns not found when no parallel sessions exist for the project', async () => {
    const projectPath = makeProjectPath('steroids-merge-no-session');

    await expect(
      mergeCommand(['--project', projectPath], {
        ...getDefaultFlags(),
        dryRun: true,
        json: true,
      })
    ).rejects.toThrow(`No parallel sessions found for project: ${projectPath}`);
  });

  it('returns not found when session has no completed workstreams', async () => {
    const projectPath = makeProjectPath('steroids-merge-empty');
    writeParallelSession(globalDb, 'empty', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-empty',
      sessionId: 'empty',
      branchName: 'steroids/ws-empty',
      sectionIds: ['alpha'],
      status: 'running',
      completedAt: null,
      createdAt: '2024-01-01T00:00:00Z',
    });

    await expect(
      mergeCommand(['--project', projectPath, '--session', 'empty'], {
        ...getDefaultFlags(),
        json: true,
      })
    ).rejects.toThrow('No completed workstreams found for session: empty');
  });

  it('returns NOT_INITIALIZED when project database cannot be opened', async () => {
    const projectPath = makeProjectPath('steroids-merge-not-init');
    writeParallelSession(globalDb, 'session', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-not-init',
      sessionId: 'session',
      branchName: 'steroids/ws-not-init',
      sectionIds: ['alpha'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    mockOpenDatabase.mockImplementationOnce(() => {
      throw new Error('database does not exist');
    });

    await expect(
      mergeCommand(['--project', projectPath], { ...getDefaultFlags(), json: true })
    ).rejects.toThrow('process.exit(3)');

    const payload = parseErrorPayload(consoleLogSpy);
    expect(payload.error.code).toBe('NOT_INITIALIZED');
    expect(processExitSpy).toHaveBeenCalledWith(3);
  });

  it('returns RESOURCE_LOCKED when merge lock cannot be acquired', async () => {
    const projectPath = makeProjectPath('steroids-merge-locked');
    writeParallelSession(globalDb, 'session', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-locked',
      sessionId: 'session',
      branchName: 'steroids/ws-locked',
      sectionIds: ['alpha'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    (mockRunParallelMerge as any).mockResolvedValue({
      success: false,
      completedCommits: 0,
      conflicts: 0,
      skipped: 0,
      errors: ['Could not acquire merge lock (held by another process)'],
    });

    await expect(
      mergeCommand(['--project', projectPath], { ...getDefaultFlags(), json: true })
    ).rejects.toThrow('process.exit(6)');

    const payload = parseErrorPayload(consoleLogSpy);
    expect(payload.error.code).toBe('RESOURCE_LOCKED');
    expect(payload.error.message).toContain('Could not acquire merge lock');
  });

  it('returns GENERAL_ERROR for non-lock merge failures', async () => {
    const projectPath = makeProjectPath('steroids-merge-general');
    writeParallelSession(globalDb, 'session', projectPath, '2024-01-01T00:00:00Z');
    writeWorkstream(globalDb, {
      id: 'ws-general',
      sessionId: 'session',
      branchName: 'steroids/ws-general',
      sectionIds: ['alpha'],
      completedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
    });

    (mockRunParallelMerge as any).mockResolvedValue({
      success: false,
      completedCommits: 0,
      conflicts: 0,
      skipped: 0,
      errors: ['Unexpected merge failure'],
    });

    await expect(
      mergeCommand(['--project', projectPath], { ...getDefaultFlags(), json: true })
    ).rejects.toThrow('process.exit(1)');

    const payload = parseErrorPayload(consoleLogSpy);
    expect(payload.error.code).toBe('GENERAL_ERROR');
  });
});
