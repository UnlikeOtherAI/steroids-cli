/**
 * Workspace clone manager for parallel execution.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type StatFs = ReturnType<typeof statfsSync>;

export interface WorkspaceCloneOptions {
  projectPath: string;
  workstreamId: string;
  branchName: string;
  workspaceRoot?: string;
  force?: boolean;
}

export interface WorkspaceCloneResult {
  projectPath: string;
  workspaceRoot: string;
  workspacePath: string;
  branchName: string;
  projectHash: string;
  usedLocalClone: boolean;
  steroidsSymlinkPath: string;
}

export interface IntegrationWorkspaceOptions {
  projectPath: string;
  sessionId: string;
  baseBranch: string;
  remote?: string;
  workspaceRoot?: string;
  integrationBranchName?: string;
}

export interface IntegrationWorkspaceResult extends WorkspaceCloneResult {
  integrationBranchName: string;
  integrationWorkstreamId: string;
}

export class WorkspaceCloneError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'WorkspaceCloneError';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WorkspaceCloneError);
    }
  }
}

function normalizeWorkstreamDirectory(workstreamId: string): string {
  return workstreamId.startsWith('ws-') ? workstreamId : `ws-${workstreamId}`;
}

function normalizeFsIdentifier(value: unknown): string | undefined {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }

  if (typeof value === 'object' && value !== null) {
    const nested = value as { val?: unknown };
    if (nested.val !== undefined) {
      return String(nested.val);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function getFileSystemId(stats: StatFs): string {
  const raw =
    // Primary signal: f_fsid (as specified in parallel workspace design docs)
    normalizeFsIdentifier((stats as { f_fsid?: unknown }).f_fsid)
    ?? normalizeFsIdentifier((stats as { fsid?: unknown }).fsid)
    ?? normalizeFsIdentifier((stats as { type?: unknown }).type);

  if (!raw) {
    throw new WorkspaceCloneError('Unable to determine filesystem identity for clone placement');
  }

  return raw;
}

/**
 * Resolve the project hash used for workspace grouping.
 */
export function getProjectHash(projectPath: string): string {
  return createHash('sha1')
    .update(resolve(projectPath))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Default root for parallel workspaces: ~/.steroids/workspaces
 */
export function getDefaultWorkspaceRoot(): string {
  return join(homedir(), '.steroids', 'workspaces');
}

export function getWorkspacePath(
  projectPath: string,
  workstreamId: string,
  workspaceRoot: string = getDefaultWorkspaceRoot()
): string {
  return resolveWorkspacePath(resolve(workspaceRoot), resolve(projectPath), workstreamId);
}

/**
 * Determine whether two paths are on the same filesystem by comparing fs identifiers.
 */
export function isSameFileSystem(leftPath: string, rightPath: string): boolean {
  const leftStats = statfsSync(leftPath);
  const rightStats = statfsSync(rightPath);

  return getFileSystemId(leftStats) === getFileSystemId(rightStats);
}

function resolveWorkspacePath(
  workspaceRoot: string,
  projectPath: string,
  workstreamId: string
): string {
  const normalizedWorkstreamDir = normalizeWorkstreamDirectory(workstreamId);
  return join(workspaceRoot, getProjectHash(projectPath), normalizedWorkstreamDir);
}

function resolveSteroidsDir(projectPath: string): string {
  const steroidsDir = join(resolve(projectPath), '.steroids');

  if (!existsSync(steroidsDir)) {
    throw new WorkspaceCloneError(`Missing .steroids directory: ${steroidsDir}`);
  }

  const resolved = realpathSync(steroidsDir);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) {
    throw new WorkspaceCloneError(`Expected .steroids to be a directory: ${resolved}`);
  }

  return resolved;
}

function verifySteroidsSymlink(steroidsPath: string): void {
  const dbPath = join(steroidsPath, 'steroids.db');
  accessSync(dbPath, constants.R_OK);
}

function createWorkspaceSymlink(
  clonePath: string,
  projectPath: string
): string {
  const targetSteroidsPath = resolveSteroidsDir(projectPath);
  const destination = join(clonePath, '.steroids');

  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }

  // Use the resolved path to avoid symlink chain surprises.
  symlinkSync(targetSteroidsPath, destination);
  verifySteroidsSymlink(destination);

  return destination;
}

/**
 * Create an isolated workspace clone for one parallel workstream.
 */
export function createWorkspaceClone(options: WorkspaceCloneOptions): WorkspaceCloneResult {
  const projectPath = resolve(options.projectPath);
  const workspaceRoot = resolve(options.workspaceRoot ?? getDefaultWorkspaceRoot());
  const workspacePath = getWorkspacePath(projectPath, options.workstreamId, workspaceRoot);

  const projectHash = getProjectHash(projectPath);

  if (!existsSync(projectPath)) {
    throw new WorkspaceCloneError(`Project path does not exist: ${projectPath}`);
  }

  if (!lstatSync(projectPath).isDirectory()) {
    throw new WorkspaceCloneError(`Project path is not a directory: ${projectPath}`);
  }

  if (existsSync(workspacePath)) {
    if (!options.force) {
      throw new WorkspaceCloneError(`Workspace already exists: ${workspacePath}`);
    }
    rmSync(workspacePath, { recursive: true, force: true });
  }

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(resolve(workspacePath, '..'), { recursive: true });

  const usedLocalClone = isSameFileSystem(projectPath, workspaceRoot);
  const cloneArgs = ['clone', ...(usedLocalClone ? ['--local'] : []), projectPath, workspacePath];

  try {
    // hardcoded command, no user input
    execFileSync('git', cloneArgs, { cwd: process.cwd(), stdio: 'inherit' });
  } catch (error: unknown) {
    rmSync(workspacePath, { recursive: true, force: true });
    throw new WorkspaceCloneError('Git clone failed', error);
  }

  try {
    // hardcoded command, no user input
    execFileSync(
      'git',
      ['-C', workspacePath, 'checkout', '-b', options.branchName],
      { stdio: 'inherit' }
    );
  } catch (error: unknown) {
    rmSync(workspacePath, { recursive: true, force: true });
    throw new WorkspaceCloneError('Failed to create branch in clone', error);
  }

  let steroidsSymlinkPath: string;
  try {
    steroidsSymlinkPath = createWorkspaceSymlink(workspacePath, projectPath);
  } catch (error: unknown) {
    rmSync(workspacePath, { recursive: true, force: true });
    throw new WorkspaceCloneError('Failed to create .steroids symlink', error);
  }

  return {
    projectPath,
    workspaceRoot,
    workspacePath,
    branchName: options.branchName,
    projectHash,
    usedLocalClone,
    steroidsSymlinkPath,
  };
}

function getIntegrationWorkstreamId(sessionId: string): string {
  return `integration-${sessionId.slice(0, 8)}`;
}

export function createIntegrationWorkspace(options: IntegrationWorkspaceOptions): IntegrationWorkspaceResult {
  const remote = options.remote ?? 'origin';
  const integrationWorkstreamId = getIntegrationWorkstreamId(options.sessionId);
  const integrationBranchName = options.integrationBranchName ?? `steroids/integration-${options.sessionId.slice(0, 8)}`;

  const clone = createWorkspaceClone({
    projectPath: options.projectPath,
    workstreamId: integrationWorkstreamId,
    branchName: integrationBranchName,
    workspaceRoot: options.workspaceRoot,
    force: true,
  });

  try {
    execFileSync(
      'git',
      ['-C', clone.workspacePath, 'fetch', remote, options.baseBranch],
      { stdio: 'inherit' }
    );
    execFileSync(
      'git',
      ['-C', clone.workspacePath, 'checkout', '-B', integrationBranchName, `${remote}/${options.baseBranch}`],
      { stdio: 'inherit' }
    );
  } catch (error) {
    rmSync(clone.workspacePath, { recursive: true, force: true });
    throw new WorkspaceCloneError('Failed to bootstrap integration workspace branch', error);
  }

  return {
    ...clone,
    integrationBranchName,
    integrationWorkstreamId,
  };
}
