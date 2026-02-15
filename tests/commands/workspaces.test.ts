import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultFlags, type GlobalFlags } from '../../src/cli/flags.js';
import { getProjectHash } from '../../src/parallel/clone.js';

const mockOpenGlobalDatabase = jest.fn();
const mockLoadConfig = jest.fn();

jest.unstable_mockModule('../../src/runners/global-db.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
}));

jest.unstable_mockModule('../../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

interface WorkspaceCleanResult {
  removed: string[];
  skipped: string[];
  failures: string[];
}

interface WorkspacesPayload {
  project_path: string;
  workspace_root: string;
  workspaces?: Array<{ workstream_id: string; cleanable: boolean; active: boolean }>;
  orphans?: Array<{ workstream_id: string }>;
}

let workspacesCommand: (args: string[], flags: GlobalFlags) => Promise<void>;
let globalDb: Database.Database;
let workspaceRoot: string;
const tempPaths: string[] = [];
let originalCwd = process.cwd();
let consoleLogSpy: ReturnType<typeof jest.spyOn>;
let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
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

    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pid INTEGER,
      project_path TEXT,
      current_task_id TEXT,
      started_at TEXT,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      section_id TEXT,
      parallel_session_id TEXT
    );
  `);
  return db;
}

function makeTempPath(prefix: string): string {
  const result = mkdtempSync(path.join(tmpdir(), `${prefix}-`));
  tempPaths.push(result);
  return result;
}

function makeProjectPath(): string {
  const projectPath = makeTempPath('steroids-workspace-project');
  const steroidsDir = path.join(projectPath, '.steroids');
  mkdirSync(steroidsDir, { recursive: true });
  writeFileSync(path.join(steroidsDir, 'steroids.db'), '');
  return projectPath;
}

function createWorkspaceLayout(projectPath: string, workspaceRoot: string, workstreamIds: string[]): void {
  const hashRoot = path.join(workspaceRoot, getProjectHash(projectPath));
  mkdirSync(hashRoot, { recursive: true });

  for (const id of workstreamIds) {
    mkdirSync(path.join(hashRoot, id), { recursive: true });
  }
}

function makeSession(
  db: Database.Database,
  id: string,
  projectPath: string,
  status: 'running' | 'completed' | 'failed' | 'merging',
  createdAt: string
): void {
  db.prepare(
    'INSERT INTO parallel_sessions (id, project_path, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, projectPath, status, createdAt);
}

function makeWorkstream(
  db: Database.Database,
  params: {
    id: string;
    sessionId: string;
    branchName: string;
    sectionIds: string[];
    status: 'running' | 'completed' | 'failed';
    createdAt: string;
  }
): void {
  db.prepare(`
    INSERT INTO workstreams (
      id, session_id, branch_name, section_ids, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.sessionId,
    params.branchName,
    JSON.stringify(params.sectionIds),
    params.status,
    params.createdAt
  );
}

function parseSuccessPayload<T>(mock: ReturnType<typeof jest.spyOn>): T {
  const payload = JSON.parse(mock.mock.calls[0]?.[0] as string) as { data: T };
  return payload.data;
}

function parseErrorPayload(mock: ReturnType<typeof jest.spyOn>): { message: string } {
  const payload = JSON.parse(mock.mock.calls[0]?.[0] as string) as {
    error: { message: string };
  };
  return payload.error;
}

beforeEach(async () => {
  jest.clearAllMocks();
  originalCwd = process.cwd();
  globalDb = createGlobalDb();
  workspaceRoot = makeTempPath('steroids-workspace-root');

  mockLoadConfig.mockReturnValue({
    runners: {
      parallel: {
        workspaceRoot,
      },
    },
  });

  mockOpenGlobalDatabase.mockReturnValue({
    db: globalDb,
    close: jest.fn(),
  });

  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  processExitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as any;

  ({ workspacesCommand } = await import('../../src/commands/workspaces.js'));
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

  if (globalDb && globalDb.open) {
    globalDb.close();
  }

  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  processExitSpy.mockRestore();
});

describe('workspacesCommand', () => {
  it('lists recorded workstreams and orphaned workspace clones', async () => {
    const projectPath = makeProjectPath();
    const hashRoot = path.join(workspaceRoot, getProjectHash(projectPath));
    createWorkspaceLayout(projectPath, workspaceRoot, ['ws-complete', 'ws-running']);
    createWorkspaceLayout(projectPath, workspaceRoot, ['ws-orphan']);

    makeSession(globalDb, 'sess-complete', projectPath, 'completed', '2024-01-01T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-complete',
      sessionId: 'sess-complete',
      branchName: 'steroids/ws-complete',
      sectionIds: ['alpha'],
      status: 'completed',
      createdAt: '2024-01-01T00:00:00Z',
    });

    makeSession(globalDb, 'sess-running', projectPath, 'running', '2024-01-02T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-running',
      sessionId: 'sess-running',
      branchName: 'steroids/ws-running',
      sectionIds: ['beta'],
      status: 'completed',
      createdAt: '2024-01-02T00:00:00Z',
    });

    await workspacesCommand(['list', '--project', projectPath], {
      ...getDefaultFlags(),
      json: true,
    });

    const payload = parseSuccessPayload<WorkspacesPayload>(consoleLogSpy);

    expect(payload.project_path).toBe(projectPath);
    expect(payload.workspace_root).toBe(path.resolve(workspaceRoot));
    expect(payload.workspaces).toHaveLength(2);
    expect(payload.orphans).toHaveLength(1);

    const complete = payload.workspaces?.find((row) => row.workstream_id === 'ws-complete');
    const running = payload.workspaces?.find((row) => row.workstream_id === 'ws-running');

    expect(complete?.cleanable).toBe(true);
    expect(running?.active).toBe(true);
    expect(running?.cleanable).toBe(false);
  });

  it('cleans default set of non-active cleanable workspaces', async () => {
    const projectPath = makeProjectPath();
    createWorkspaceLayout(projectPath, workspaceRoot, ['ws-complete', 'ws-running']);

    makeSession(globalDb, 'sess-complete', projectPath, 'completed', '2024-01-01T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-complete',
      sessionId: 'sess-complete',
      branchName: 'steroids/ws-complete',
      sectionIds: ['alpha'],
      status: 'completed',
      createdAt: '2024-01-01T00:00:00Z',
    });

    makeSession(globalDb, 'sess-running', projectPath, 'running', '2024-01-02T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-running',
      sessionId: 'sess-running',
      branchName: 'steroids/ws-running',
      sectionIds: ['beta'],
      status: 'completed',
      createdAt: '2024-01-02T00:00:00Z',
    });

    await workspacesCommand(['clean', '--project', projectPath], {
      ...getDefaultFlags(),
      json: true,
    });

    const payload = parseSuccessPayload<WorkspaceCleanResult>(consoleLogSpy);
    expect(payload.removed).toHaveLength(1);
    expect(payload.removed[0]).toBe(path.join(workspaceRoot, getProjectHash(projectPath), 'ws-complete'));
    expect(payload.skipped).toHaveLength(0);
    expect(payload.failures).toHaveLength(0);

    expect(existsSync(path.join(workspaceRoot, getProjectHash(projectPath), 'ws-complete'))).toBe(false);
    expect(existsSync(path.join(workspaceRoot, getProjectHash(projectPath), 'ws-running'))).toBe(true);
  });

  it('cleans all workspaces with --all', async () => {
    const projectPath = makeProjectPath();
    const hashRoot = path.join(workspaceRoot, getProjectHash(projectPath));
    createWorkspaceLayout(projectPath, workspaceRoot, ['ws-complete', 'ws-running', 'ws-orphan']);

    makeSession(globalDb, 'sess-complete', projectPath, 'completed', '2024-01-01T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-complete',
      sessionId: 'sess-complete',
      branchName: 'steroids/ws-complete',
      sectionIds: ['alpha'],
      status: 'completed',
      createdAt: '2024-01-01T00:00:00Z',
    });

    makeSession(globalDb, 'sess-running', projectPath, 'running', '2024-01-02T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-running',
      sessionId: 'sess-running',
      branchName: 'steroids/ws-running',
      sectionIds: ['beta'],
      status: 'completed',
      createdAt: '2024-01-02T00:00:00Z',
    });

    await workspacesCommand(['clean', '--project', projectPath, '--all'], {
      ...getDefaultFlags(),
      json: true,
    });

    const payload = parseSuccessPayload<WorkspaceCleanResult>(consoleLogSpy);
    expect(payload.removed).toHaveLength(3);
    expect(payload.skipped).toHaveLength(0);
    expect(payload.failures).toHaveLength(0);

    expect(existsSync(path.join(hashRoot, 'ws-complete'))).toBe(false);
    expect(existsSync(path.join(hashRoot, 'ws-running'))).toBe(false);
    expect(existsSync(path.join(hashRoot, 'ws-orphan'))).toBe(false);
  });

  it('reports workspaces on dry-run without deleting them', async () => {
    const projectPath = makeProjectPath();
    const hashRoot = path.join(workspaceRoot, getProjectHash(projectPath));
    createWorkspaceLayout(projectPath, workspaceRoot, ['ws-complete']);

    makeSession(globalDb, 'sess-complete', projectPath, 'completed', '2024-01-01T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-complete',
      sessionId: 'sess-complete',
      branchName: 'steroids/ws-complete',
      sectionIds: ['alpha'],
      status: 'completed',
      createdAt: '2024-01-01T00:00:00Z',
    });

    await workspacesCommand(['clean', '--project', projectPath], {
      ...getDefaultFlags(),
      json: true,
      dryRun: true,
    });

    const payload = parseSuccessPayload<WorkspaceCleanResult>(consoleLogSpy);
    expect(payload.removed).toHaveLength(0);
    expect(payload.skipped).toHaveLength(1);
    expect(payload.skipped[0]).toBe(path.join(hashRoot, 'ws-complete'));
    expect(existsSync(path.join(hashRoot, 'ws-complete'))).toBe(true);
  });

  it('defaults project path to the current working directory', async () => {
    const projectPath = makeProjectPath();
    process.chdir(projectPath);

    makeSession(globalDb, 'sess-complete', projectPath, 'completed', '2024-01-01T00:00:00Z');
    makeWorkstream(globalDb, {
      id: 'ws-complete',
      sessionId: 'sess-complete',
      branchName: 'steroids/ws-complete',
      sectionIds: ['alpha'],
      status: 'completed',
      createdAt: '2024-01-01T00:00:00Z',
    });
    createWorkspaceLayout(projectPath, workspaceRoot, ['ws-complete']);

    await workspacesCommand(['list'], {
      ...getDefaultFlags(),
      json: true,
    });

    const payload = parseSuccessPayload<WorkspacesPayload>(consoleLogSpy);
    expect(payload.project_path).toBe(path.resolve(realpathSync(projectPath)));
    expect(payload.workspace_root).toBe(path.resolve(workspaceRoot));
  });

  it('returns not-initialized error when project is missing .steroids.db', async () => {
    const projectPath = makeTempPath('steroids-workspace-missing-db');
    expect(() => {
      process.chdir(projectPath);
    }).not.toThrow();

    try {
      await workspacesCommand(['list'], {
        ...getDefaultFlags(),
        json: true,
      });
      throw new Error('Expected process exit');
    } catch (error) {
      expect((error as Error).message).toBe('process.exit(3)');
    }

    const payload = parseErrorPayload(consoleLogSpy);
    expect(payload.message).toBe(`Not a steroids project: ${path.resolve(realpathSync(projectPath))}`);
  });
});
