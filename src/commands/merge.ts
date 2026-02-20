import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids merge - Merge completed parallel workstreams
 */

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';
import { openDatabase } from '../database/connection.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import {
  runParallelMerge,
  type MergeResult,
  type MergeWorkstreamSpec,
} from '../parallel/merge.js';

const HELP = generateHelp({
  command: 'merge',
  description: 'Merge completed parallel workstreams into main',
  details: `When running parallel sessions, each workstream is merged via cherry-pick.
  This command runs the final merge step for a completed parallel session and recovers
  from stale merge locks or interrupted conflict resolution when needed.`,
  usage: [
    'steroids merge [options]',
  ],
  options: [
    { long: 'project', description: 'Project directory to merge (defaults to cwd)', values: '<path>' },
    { long: 'session', description: 'Parallel session ID (defaults to latest session for project)', values: '<id>' },
    { long: 'session-id', description: 'Alias for --session', values: '<id>' },
    { long: 'remote', description: 'Git remote to fetch from', values: '<name>', default: 'origin' },
    { long: 'main-branch', description: 'Target branch for cherry-picks', values: '<name>', default: 'main' },
    { long: 'integration-branch', description: 'Temporary integration branch name', values: '<name>' },
  ],
  examples: [
    { command: 'steroids merge', description: 'Merge latest parallel session in current project' },
    { command: 'steroids merge --project ~/projects/my-app', description: 'Merge using an explicit project path' },
    { command: 'steroids merge --session abc123', description: 'Merge a specific parallel session' },
  ],
  related: [
    { command: 'steroids runners start --parallel', description: 'Start parallel runners' },
  ],
});

interface MergeWorkstreamPlanRow {
  id: string;
  branch_name: string;
  section_ids: string;
  status: string;
  completed_at: string | null;
  created_at: string;
}

interface MergeSessionRow {
  id: string;
  status: string;
  created_at: string;
}

interface MergeSessionPlan {
  sessionId: string;
  sessionStatus: string;
  createdAt: string;
  workstreams: MergeWorkstreamSpec[];
  sectionPlans: MergeWorkstreamPlanRow[];
}

function parseSectionIds(sectionIdsJson: string): string[] {
  try {
    const parsed = JSON.parse(sectionIdsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function parseTimestamp(value: string | null): number {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function orderByCompletion(planRows: MergeWorkstreamPlanRow[]): MergeWorkstreamPlanRow[] {
  return [...planRows].sort((left, right) => {
    const completedLeft = parseTimestamp(left.completed_at);
    const completedRight = parseTimestamp(right.completed_at);

    if (completedLeft !== completedRight) {
      return completedLeft - completedRight;
    }

    return parseTimestamp(left.created_at) - parseTimestamp(right.created_at);
  });
}

function buildPlanForSession(
  db: Database.Database,
  session: MergeSessionRow,
  includeRunning: boolean
): MergeSessionPlan {
  const statusFilter = includeRunning ? '' : ' AND status = \'completed\'';

  const rows = db
    .prepare(
      `SELECT id, branch_name, section_ids, status, completed_at, created_at
       FROM workstreams
       WHERE session_id = ?${statusFilter}`
    )
    .all(session.id) as MergeWorkstreamPlanRow[];

  if (rows.length === 0) {
    return {
      sessionId: session.id,
      sessionStatus: session.status,
      createdAt: session.created_at,
      workstreams: [],
      sectionPlans: rows,
    };
  }

  const orderedRows = orderByCompletion(rows);

  const workstreams = orderedRows
    .map((row) => ({
      id: row.id,
      branchName: row.branch_name,
    }));

  return {
    sessionId: session.id,
    sessionStatus: session.status,
    createdAt: session.created_at,
    workstreams,
    sectionPlans: orderedRows,
  };
}

function findLatestSessionForProject(
  db: Database.Database,
  projectPath: string
): MergeSessionRow | null {
  return db
    .prepare(
      `SELECT id, status, created_at
       FROM parallel_sessions
       WHERE project_path = ?
       ORDER BY created_at DESC`
    )
    .get(projectPath) as MergeSessionRow | undefined ?? null;
}

function getSessionById(
  db: Database.Database,
  projectPath: string,
  sessionId: string
): MergeSessionRow | null {
  return db
    .prepare(
      `SELECT id, status, created_at
       FROM parallel_sessions
       WHERE id = ? AND project_path = ?`
    )
    .get(sessionId, projectPath) as MergeSessionRow | undefined ?? null;
}

function resolveProjectPath(projectArg: string | undefined): string {
  const projectPath = resolve(projectArg ?? process.cwd());
  const steroidsDbPath = join(projectPath, '.steroids', 'steroids.db');

  if (!existsSync(projectPath)) {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }

  if (!existsSync(steroidsDbPath)) {
    throw new Error(`Not a steroids project: ${projectPath}`);
  }

  return projectPath;
}

function resolveMergePlan(
  db: Database.Database,
  projectPath: string,
  explicitSessionId?: string
): MergeSessionPlan {
  const targetSession = explicitSessionId
    ? getSessionById(db, projectPath, explicitSessionId)
    : findLatestSessionForProject(db, projectPath);

  if (!targetSession) {
    if (explicitSessionId) {
      throw new Error(`Parallel session not found: ${explicitSessionId}`);
    }
    throw new Error(`No parallel sessions found for project: ${projectPath}`);
  }

  const plan = buildPlanForSession(db, targetSession, false);

  if (plan.sectionPlans.length === 0) {
    throw new Error(`No completed workstreams found for session: ${targetSession.id}`);
  }

  return plan;
}

function summarizeError(errors: string[]): string {
  if (errors.length === 1) {
    return errors[0];
  }

  return errors.join('; ');
}

export async function mergeCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'merge', flags });

  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string', short: 'p' },
      session: { type: 'string' },
      'session-id': { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      'main-branch': { type: 'string', default: 'main' },
      'integration-branch': { type: 'string' },
    },
    allowPositionals: false,
  });

  const explicitSession = (values['session-id'] as string | undefined)
    ?? (values.session as string | undefined);

  const projectPath = resolveProjectPath(values.project as string | undefined);

  // Merge command performs only project-scoped work and never touches other repos.
  const { db: globalDb, close: closeGlobalDb } = openGlobalDatabase();
  let plan: MergeSessionPlan;

  try {
    plan = resolveMergePlan(globalDb, projectPath, explicitSession);
  } finally {
    closeGlobalDb();
  }

  if (flags.dryRun) {
    out.success({
      project_path: projectPath,
      session_id: plan.sessionId,
      session_status: plan.sessionStatus,
      session_created_at: plan.createdAt,
      workstreams: plan.sectionPlans.map((row) => ({
        id: row.id,
        branch_name: row.branch_name,
        section_ids: parseSectionIds(row.section_ids),
        status: row.status,
        completed_at: row.completed_at,
      })),
    });
    return;
  }

  let result: MergeResult;
  const remote = values.remote as string;
  const mainBranch = values['main-branch'] as string;
  const integrationBranch = values['integration-branch'] as string | undefined;

  try {
    const { close } = openDatabase(projectPath);
    close();
  } catch (error) {
    out.error(ErrorCode.NOT_INITIALIZED, `Not a steroids project: ${projectPath}`);
    process.exit(getExitCode(ErrorCode.NOT_INITIALIZED));
  }

    result = await runParallelMerge({
      projectPath,
      sessionId: plan.sessionId,
      runnerId: randomUUID(),
      workstreams: plan.workstreams,
      remote,
      mainBranch,
      integrationBranchName: integrationBranch,
    });

  if (!result.success) {
    const isLockContention = result.errors.some((entry) => entry.includes('Could not acquire merge lock'));
    const code = isLockContention ? ErrorCode.RESOURCE_LOCKED : ErrorCode.GENERAL_ERROR;
    const message = summarizeError(result.errors);

    out.error(code, message || 'Merge failed', {
      session_id: plan.sessionId,
      project_path: projectPath,
      merge_result: result,
    });
    process.exit(getExitCode(code));
  }

  out.success({
    session_id: plan.sessionId,
    project_path: projectPath,
    session_status: plan.sessionStatus,
    workstreams: plan.sectionPlans.length,
    completed_commits: result.completedCommits,
    conflicts: result.conflicts,
    skipped: result.skipped,
  });
}
