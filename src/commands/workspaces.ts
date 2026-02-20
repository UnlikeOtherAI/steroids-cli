import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids workspaces - List and clean parallel workspace clones
 */

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { generateHelp } from '../cli/help.js';
import { createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';
import {
  openGlobalDatabase,
  listParallelSessionRunners,
  removeParallelSessionRunner,
  revokeWorkstreamLeasesForSession,
} from '../runners/global-db.js';
import { loadConfig } from '../config/loader.js';
import { getDefaultWorkspaceRoot, getProjectHash } from '../parallel/clone.js';

const HELP = generateHelp({
  command: 'workspaces',
  description: 'Inspect and clean parallel workspace clones',
  details:
    'List workspace clones created for parallel execution and remove stale or completed clones from disk.',
  usage: ['steroids workspaces <subcommand> [options]'],
  subcommands: [
    { name: 'list', description: 'List workspace clones for the current project' },
    { name: 'clean', description: 'Clean workspace clones for the current project' },
  ],
  options: [
    { long: 'project', short: 'p', description: 'Project directory to inspect (defaults to cwd)', values: '<path>' },
    { long: 'all', description: 'Include active/locked workspace clones when cleaning' },
  ],
  examples: [
    { command: 'steroids workspaces list', description: 'List workspace clones in the current project' },
    { command: 'steroids workspaces clean', description: 'Clean non-active workspace clones' },
    { command: 'steroids workspaces clean --all', description: 'Remove all workspace clones for project' },
  ],
  related: [
    { command: 'steroids runners start --parallel', description: 'Create parallel workstream clones' },
    { command: 'steroids merge', description: 'Merge completed parallel workstreams' },
  ],
});

interface WorkspaceQueryRow {
  session_id: string | null;
  session_status: string | null;
  session_created_at: string | null;
  session_completed_at: string | null;
  workstream_id: string | null;
  branch_name: string | null;
  section_ids: string | null;
  clone_path: string | null;
  workstream_status: string | null;
  runner_id: string | null;
  workstream_created_at: string | null;
  workstream_completed_at: string | null;
}

interface WorkspaceRecord {
  sessionId: string;
  sessionStatus: string;
  workstreamId: string;
  branchName: string;
  sectionIds: string[];
  clonePath: string;
  workstreamStatus: string;
  runnerId: string | null;
  workstreamCreatedAt: string;
  workstreamCompletedAt: string | null;
  sessionCreatedAt: string;
  sessionCompletedAt: string | null;
  active: boolean;
  cleanable: boolean;
  exists: boolean;
}

interface OrphanWorkspace {
  workstreamId: string;
  clonePath: string;
}

interface CleanResult {
  deleted: string[];
  skipped: string[];
  failures: string[];
}

const TERMINAL_PARALLEL_SESSION_STATUSES = new Set(['completed', 'failed', 'aborted']);

function isActiveParallelSessionStatus(status: string): boolean {
  return !TERMINAL_PARALLEL_SESSION_STATUSES.has(status);
}

function terminateRunnerPid(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function drainParallelSessionsForCleanup(records: WorkspaceRecord[]): void {
  const sessionIds = [...new Set(records.map((record) => record.sessionId))];

  for (const sessionId of sessionIds) {
    revokeWorkstreamLeasesForSession(sessionId);

    const runners = listParallelSessionRunners(sessionId);
    for (const runner of runners) {
      if (runner.pid) {
        terminateRunnerPid(runner.pid);
      }
      removeParallelSessionRunner(runner.id);
    }
  }
}

function resolveProjectPath(projectArg?: string): string {
  const projectPath = resolve(projectArg ?? process.cwd());
  const projectDbPath = join(projectPath, '.steroids', 'steroids.db');

  if (!existsSync(projectPath)) {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }

  if (!existsSync(projectDbPath)) {
    throw new Error(`Not a steroids project: ${projectPath}`);
  }

  return projectPath;
}

function parseSectionIds(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function getActiveSessionIds(db: Database.Database, projectPath: string): Set<string> {
  const active = new Set<string>();

  const runningSessions = db
    .prepare(
      `SELECT id
       FROM parallel_sessions
       WHERE project_path = ?
         AND status NOT IN ('completed', 'failed', 'aborted')`
    )
    .all(projectPath) as Array<{ id: string }>;

  for (const row of runningSessions) {
    active.add(row.id);
  }

  const runningRunners = db
    .prepare(
      "SELECT parallel_session_id FROM runners WHERE status = 'running' AND parallel_session_id IS NOT NULL"
    )
    .all() as Array<{ parallel_session_id: string | null }>;

  for (const row of runningRunners) {
    if (row.parallel_session_id) {
      active.add(row.parallel_session_id);
    }
  }

  return active;
}

function normalizeWorkspaceRoot(projectPath: string): string {
  const configured = loadConfig(projectPath).runners?.parallel?.workspaceRoot;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured);
  }
  return getDefaultWorkspaceRoot();
}

function collectWorkspaceData(
  db: Database.Database,
  projectPath: string
): { records: WorkspaceRecord[]; orphans: OrphanWorkspace[]; workspaceRoot: string } {
  const workspaceRoot = normalizeWorkspaceRoot(projectPath);
  const projectWorkspaceRoot = resolve(workspaceRoot, getProjectHash(projectPath));
  const activeSessionIds = getActiveSessionIds(db, projectPath);

  const rows = db
    .prepare(`
      SELECT
        s.id AS session_id,
        s.status AS session_status,
        s.created_at AS session_created_at,
        s.completed_at AS session_completed_at,
        w.id AS workstream_id,
        w.branch_name,
        w.section_ids,
        w.clone_path,
        w.status AS workstream_status,
        w.runner_id,
        w.created_at AS workstream_created_at,
        w.completed_at AS workstream_completed_at
      FROM parallel_sessions s
      LEFT JOIN workstreams w ON s.id = w.session_id
      WHERE s.project_path = ?
      ORDER BY s.created_at DESC, w.created_at ASC
    `)
    .all(projectPath) as WorkspaceQueryRow[];

  const known = new Set<string>();
  const records: WorkspaceRecord[] = [];

  for (const row of rows) {
    if (!row.workstream_id) {
      continue;
    }

    const workstreamId = row.workstream_id;
    const sessionId = row.session_id ?? 'unknown';
    const sessionStatus = row.session_status ?? 'unknown';
    const clonePath = resolve(row.clone_path ?? join(projectWorkspaceRoot, workstreamId));
    const workstreamStatus = row.workstream_status ?? sessionStatus;
    const sessionActive = activeSessionIds.has(sessionId) || isActiveParallelSessionStatus(sessionStatus);
    const cleanable =
      !sessionActive &&
      workstreamStatus !== 'running' &&
      !isActiveParallelSessionStatus(sessionStatus);

    known.add(clonePath);

    records.push({
      sessionId,
      sessionStatus,
      workstreamId,
      branchName: row.branch_name ?? '',
      sectionIds: parseSectionIds(row.section_ids),
      clonePath,
      workstreamStatus,
      runnerId: row.runner_id ?? null,
      workstreamCreatedAt: row.workstream_created_at ?? row.session_created_at ?? new Date().toISOString(),
      workstreamCompletedAt: row.workstream_completed_at ?? row.session_completed_at ?? null,
      sessionCreatedAt: row.session_created_at ?? new Date().toISOString(),
      sessionCompletedAt: row.session_completed_at,
      active: sessionActive,
      cleanable,
      exists: existsSync(clonePath),
    });
  }

  const orphans: OrphanWorkspace[] = [];
  if (existsSync(projectWorkspaceRoot)) {
    for (const entry of readdirSync(projectWorkspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const name = entry.name;
      if (!name.startsWith('ws-')) {
        continue;
      }

      const clonePath = resolve(projectWorkspaceRoot, name);
      if (known.has(clonePath)) {
        continue;
      }

      orphans.push({
        workstreamId: name,
        clonePath,
      });
    }
  }

  return { records, orphans, workspaceRoot };
}

function toWorkspaceRowOutput(records: WorkspaceRecord[]): Array<Record<string, unknown>> {
  return records.map((record) => ({
    session_id: record.sessionId,
    session_status: record.sessionStatus,
    workstream_id: record.workstreamId,
    branch_name: record.branchName,
    section_ids: record.sectionIds,
    clone_path: record.clonePath,
    status: record.workstreamStatus,
    active: record.active,
    cleanable: record.cleanable,
    exists: record.exists,
    runner_id: record.runnerId,
    workstream_created_at: record.workstreamCreatedAt,
    workstream_completed_at: record.workstreamCompletedAt,
    session_created_at: record.sessionCreatedAt,
    session_completed_at: record.sessionCompletedAt,
  }));
}

function toOrphanRowOutput(orphans: OrphanWorkspace[]): Array<Record<string, string>> {
  return orphans.map((orphan) => ({
    workstream_id: orphan.workstreamId,
    clone_path: orphan.clonePath,
  }));
}

function executeClean(
  records: WorkspaceRecord[],
  orphans: OrphanWorkspace[],
  removeAll: boolean,
  dryRun: boolean
): CleanResult {
  const targets = new Map<string, OrphanWorkspace | WorkspaceRecord>();

  for (const record of records) {
    if (!removeAll && !record.cleanable) {
      continue;
    }
    targets.set(record.clonePath, record);
  }

  if (removeAll) {
    for (const orphan of orphans) {
      targets.set(orphan.clonePath, orphan);
    }
  }

  const deleted: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];

  for (const path of [...targets.keys()].sort()) {
    if (!existsSync(path)) {
      skipped.push(path);
      continue;
    }

    if (dryRun) {
      skipped.push(path);
      continue;
    }

    try {
      rmSync(path, { recursive: true, force: true });
      deleted.push(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${path}: ${message}`);
    }
  }

  return { deleted, skipped, failures };
}

async function listWorkspaces(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'workspaces', subcommand: 'list', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      project: { type: 'string', short: 'p' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (positionals.length > 0) {
    out.error(ErrorCode.INVALID_ARGUMENTS, `Unexpected arguments: ${positionals.join(', ')}`);
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  let db: Database.Database;
  let projectPath: string;
  let closeDb: () => void;

  try {
    projectPath = resolveProjectPath(values.project as string | undefined);
    const globalDb = openGlobalDatabase();
    db = globalDb.db;
    closeDb = globalDb.close;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.error(ErrorCode.NOT_INITIALIZED, message);
    process.exit(getExitCode(ErrorCode.NOT_INITIALIZED));
  }

  try {
    const { records, orphans, workspaceRoot } = collectWorkspaceData(db, projectPath);

    if (out.isJson()) {
      out.success({
        project_path: projectPath,
        workspace_root: workspaceRoot,
        workspaces: toWorkspaceRowOutput(records),
        orphans: toOrphanRowOutput(orphans),
      });
      return;
    }

    out.log(`Project: ${projectPath}`);
    out.log(`Workspace root: ${workspaceRoot}`);

    if (records.length === 0 && orphans.length === 0) {
      out.log('No workspace clones found.');
      return;
    }

    for (const row of records) {
      const statusBits = [
        row.active ? '[active]' : '',
        row.cleanable ? '' : '[busy]',
      ].filter(Boolean).join(' ');

      out.log(
        `${row.workstreamId}  session=${row.sessionId}  status=${row.workstreamStatus}  branch=${row.branchName}\n` +
          `  path=${row.clonePath}  sections=${row.sectionIds.join(',') || '(none)'}` +
          (statusBits ? `  ${statusBits}` : '')
      );
    }

    if (orphans.length > 0) {
      out.log(`Orphaned: ${orphans.length}`);
      for (const orphan of orphans) {
        out.log(`  ${orphan.workstreamId}  path=${orphan.clonePath}`);
      }
    }
  } finally {
    closeDb();
  }
}

async function cleanWorkspaces(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'workspaces', subcommand: 'clean', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      project: { type: 'string', short: 'p' },
      all: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (positionals.length > 0) {
    out.error(ErrorCode.INVALID_ARGUMENTS, `Unexpected arguments: ${positionals.join(', ')}`);
    process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }

  let db: Database.Database;
  let projectPath: string;
  let closeDb: () => void;
  const removeAll = Boolean(values.all);

  try {
    projectPath = resolveProjectPath(values.project as string | undefined);
    const globalDb = openGlobalDatabase();
    db = globalDb.db;
    closeDb = globalDb.close;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.error(ErrorCode.NOT_INITIALIZED, message);
    process.exit(getExitCode(ErrorCode.NOT_INITIALIZED));
  }

  try {
    const { records, orphans, workspaceRoot } = collectWorkspaceData(db, projectPath);

    if (removeAll && !flags.dryRun) {
      drainParallelSessionsForCleanup(records);
    }

    const result = executeClean(records, orphans, removeAll, flags.dryRun);

    if (result.failures.length > 0) {
      out.error(
        ErrorCode.GENERAL_ERROR,
        removeAll
          ? 'One or more workspace clean operations failed'
          : 'One or more eligible workspace clean operations failed',
        {
          project_path: projectPath,
          failures: result.failures,
        }
      );
      process.exit(getExitCode(ErrorCode.GENERAL_ERROR));
    }

    if (out.isJson()) {
      out.success({
        project_path: projectPath,
        workspace_root: workspaceRoot,
        dry_run: flags.dryRun,
        removed: result.deleted,
        skipped: result.skipped,
        failures: result.failures,
        remove_all: removeAll,
      });
      return;
    }

    if (flags.dryRun) {
      if (result.skipped.length === 0) {
        out.log('No workspaces would be removed.');
        return;
      }

      out.log(`Would remove ${result.skipped.length} workspace(s):`);
      for (const path of result.skipped) {
        out.log(`  ${path}`);
      }
      return;
    }

    if (result.deleted.length === 0 && result.skipped.length === 0) {
      out.log('No workspace clones were removed.');
      return;
    }

    if (result.deleted.length > 0) {
      out.log(`Removed ${result.deleted.length} workspace(s):`);
      for (const path of result.deleted) {
        out.log(`  ${path}`);
      }
    }

    if (result.skipped.length > 0) {
      out.log(`Skipped ${result.skipped.length} workspace(s):`);
      for (const path of result.skipped) {
        out.log(`  ${path}`);
      }
    }
  } finally {
    closeDb();
  }
}

export async function workspacesCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      await listWorkspaces(subArgs, flags);
      break;
    case 'clean':
      await cleanWorkspaces(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
  }
}
