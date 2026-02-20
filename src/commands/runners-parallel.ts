import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { openDatabase } from '../database/connection.js';
import { createWorkspaceClone } from '../parallel/clone.js';
import { loadConfig } from '../config/loader.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import { partitionWorkstreams, CyclicDependencyError, type WorkstreamSection } from '../parallel/scheduler.js';
import { listSections } from '../database/queries.js';

export interface ParallelWorkstreamPlan {
  sessionId: string;
  projectPath: string;
  projectRepoId: string;
  maxClones: number;
  workstreams: Array<{
    id: string;
    branchName: string;
    sectionIds: string[];
    sectionNames: string[];
  }>;
}

function getProjectRepoId(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

export function parseSectionIds(value: string): string[] {
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function printParallelPlan(_projectPath: string, plan: ParallelWorkstreamPlan): void {
  console.log(`Parallel plan for ${plan.projectPath}`);
  console.log(`Repo ID: ${plan.projectRepoId}`);
  console.log(`Session: ${plan.sessionId}`);
  console.log(`Workstreams: ${plan.workstreams.length}`);
  console.log(`Max clones: ${plan.maxClones}`);

  for (let i = 0; i < plan.workstreams.length; i += 1) {
    const workstream = plan.workstreams[i];
    console.log(`${i + 1}. ${workstream.id} (${workstream.branchName})`);

    for (const sectionName of workstream.sectionNames) {
      console.log(`   - ${sectionName}`);
    }
  }
}

export function getConfiguredMaxClones(projectPath: string): number {
  const config = loadConfig(projectPath);
  const configured = config.runners?.parallel?.maxClones;

  return Number.isFinite(Number(configured)) && Number(configured) > 0
    ? Number(configured)
    : 3;
}

export function buildParallelRunPlan(projectPath: string, maxClonesOverride?: number): ParallelWorkstreamPlan {
  const sessionId = uuidv4();
  const shortSessionId = sessionId.slice(0, 8);
  const projectRepoId = getProjectRepoId(projectPath);
  const config = loadConfig(projectPath);

  if (config.runners?.parallel?.enabled !== true) {
    throw new Error('Parallel mode is disabled. Set runners.parallel.enabled: true to use --parallel.');
  }

  const configuredMaxClones = getConfiguredMaxClones(projectPath);
  const effectiveMaxClones = maxClonesOverride ?? configuredMaxClones;
  const { db, close } = openDatabase(projectPath);

  try {
    const sections = listSections(db);
    if (sections.length === 0) {
      throw new Error('No sections found');
    }

    const dependencyRows = db
      .prepare('SELECT section_id AS sectionId, depends_on_section_id AS dependsOnSectionId FROM section_dependencies')
      .all() as {
        sectionId: string;
        dependsOnSectionId: string;
      }[];

    const workstreamSections = sections.map((section) => ({
      id: section.id,
      name: section.name,
      position: section.position,
    }) as WorkstreamSection);

    const workstreams = partitionWorkstreams(
      workstreamSections,
      dependencyRows.map((dep) => ({
        sectionId: dep.sectionId,
        dependsOnSectionId: dep.dependsOnSectionId,
      }))
    );

    const pendingRows = db
      .prepare(
        `SELECT section_id as sectionId, COUNT(*) as count
         FROM tasks
         WHERE section_id IN (${sections.map(() => '?').join(',')})
           AND status != 'completed'
         GROUP BY section_id`
      )
      .all(...sections.map((section) => section.id)) as Array<{
      sectionId: string;
      count: number;
    }>;

    const pendingMap = new Map<string, number>(pendingRows.map((row) => [row.sectionId, row.count]));
    const sectionNameById = new Map(sections.map((section) => [section.id, section.name]));

    const activeWorkstreams = workstreams.workstreams
      .map((sectionIds, index) => {
        const sectionNames = sectionIds
          .map((sectionId) => sectionNameById.get(sectionId) ?? sectionId);

        const workstream: ParallelWorkstreamPlan['workstreams'][number] = {
          id: `ws-${shortSessionId}-${index + 1}`,
          branchName: `steroids/ws-${shortSessionId}-${index + 1}`,
          sectionIds,
          sectionNames,
        };

        return workstream;
      })
      .filter((workstream) =>
        workstream.sectionIds.some((sectionId) => (pendingMap.get(sectionId) ?? 0) > 0)
      );

    const filteredWorkstreams = activeWorkstreams.slice(0, effectiveMaxClones);

    if (filteredWorkstreams.length === 0) {
      throw new Error('No pending workstreams');
    }

    return {
      sessionId,
      projectPath,
      projectRepoId,
      maxClones: effectiveMaxClones,
      workstreams: filteredWorkstreams,
    };
  } finally {
    close();
  }
}

export function launchParallelSession(plan: ParallelWorkstreamPlan, projectPath: string): string {
  const { db, close } = openGlobalDatabase();
  const configuredWorkspaceRoot = loadConfig(projectPath).runners?.parallel?.workspaceRoot;

  try {
    const activeSession = db
      .prepare(
        `SELECT id, status
         FROM parallel_sessions
         WHERE project_repo_id = ?
           AND status NOT IN ('completed', 'failed', 'aborted')
         LIMIT 1`
      )
      .get(plan.projectRepoId) as { id: string; status: string } | undefined;

    if (activeSession) {
      throw new Error(
        `Active parallel session already exists for this repository: ${activeSession.id} (${activeSession.status})`
      );
    }

    db.prepare(
      'INSERT INTO parallel_sessions (id, project_path, project_repo_id, status) VALUES (?, ?, ?, ?)'
    ).run(plan.sessionId, projectPath, plan.projectRepoId, 'running');

    const insertWorkstream = db.prepare(
      `INSERT INTO workstreams (
        id, session_id, branch_name, section_ids, status, clone_path
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const workstream of plan.workstreams) {
      let workspacePath: string | null = null;

      try {
        const workspaceClone = createWorkspaceClone({
          projectPath,
          workstreamId: workstream.id,
          branchName: workstream.branchName,
          workspaceRoot: configuredWorkspaceRoot,
        });

        workspacePath = workspaceClone.workspacePath;

        insertWorkstream.run(
          workstream.id,
          plan.sessionId,
          workstream.branchName,
          JSON.stringify(workstream.sectionIds),
          'running',
          workspaceClone.workspacePath
        );

        const spawnResult = spawnDetachedRunner({
          projectPath: workspaceClone.workspacePath,
          args: [
            process.argv[1],
            'runners',
            'start',
            '--project', workspaceClone.workspacePath,
            '--parallel',
            '--section-ids', workstream.sectionIds.join(','),
            '--branch', workstream.branchName,
            '--parallel-session-id', plan.sessionId,
          ],
        });

        if (!spawnResult.pid) {
          throw new Error(`Failed to start clone runner for ${workstream.branchName}`);
        }
      } catch (error: unknown) {
        if (workspacePath) {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }

        throw error;
      }
    }
  } finally {
    close();
  }

  return plan.sessionId;
}

export function spawnDetachedRunner(options: { projectPath: string; args: string[] }): { pid: number | null; logFile?: string } {
  const config = loadConfig(options.projectPath);
  const daemonLogsEnabled = config.runners?.daemonLogs !== false;

  let logFile: string | undefined;
  let logFd: number | undefined;

  if (daemonLogsEnabled) {
    const logsDir = path.join(os.homedir(), '.steroids', 'runners', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const tempLogPath = path.join(logsDir, `daemon-${Date.now()}.log`);
    logFd = fs.openSync(tempLogPath, 'a');
    logFile = tempLogPath;
  }

  const child = spawn(
    process.execPath,
    options.args,
    {
      cwd: options.projectPath,
      detached: true,
      stdio: daemonLogsEnabled && logFd !== undefined
        ? ['ignore', logFd, logFd]
        : 'ignore',
    }
  );
  child.unref();

  if (logFd !== undefined) {
    fs.closeSync(logFd);
  }

  let finalLogPath: string | undefined;
  if (logFile && child.pid) {
    const logsDir = path.dirname(logFile);
    finalLogPath = path.join(logsDir, `daemon-${child.pid}.log`);
    try {
      fs.renameSync(logFile, finalLogPath);
    } catch {
      finalLogPath = logFile;
    }
  }

  return { pid: child.pid ?? null, logFile: finalLogPath };
}

export { CyclicDependencyError };
