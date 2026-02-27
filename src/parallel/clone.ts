/**
 * Workspace clone manager for parallel execution.
 */

import { createHash } from 'node:crypto';

import { loadConfigFile, type SteroidsConfig } from '../config/loader.js';
import { getSkillContent } from '../commands/skills.js';

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type StatFs = ReturnType<typeof statfsSync>;

export interface WorkspaceCloneOptions {
  projectPath: string;
  workstreamId: string;
  branchName: string;
  workspaceRoot?: string;
  force?: boolean;
  /** When provided, seed the new clone from this prior workstream path instead of projectPath. */
  fromPath?: string;
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

function runGitAllowFailure(args: string[]): void {
  try {
    execFileSync('git', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    // Best-effort hydration for optional refs.
  }
}

function ensureMainOrMasterBranches(workspacePath: string): void {
  // Workstream clones may be created from a non-main checked-out branch
  // (or a prior seeded clone), so explicitly hydrate main/master refs from
  // origin to keep downstream workspace preparation deterministic.
  runGitAllowFailure(['-C', workspacePath, 'fetch', 'origin', 'main']);
  runGitAllowFailure(['-C', workspacePath, 'fetch', 'origin', 'master']);

  try {
    execFileSync('git', ['-C', workspacePath, 'rev-parse', '--verify', 'refs/remotes/origin/main'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    runGitAllowFailure(['-C', workspacePath, 'branch', '--force', 'main', 'origin/main']);
  } catch {
    // origin/main does not exist
  }

  try {
    execFileSync('git', ['-C', workspacePath, 'rev-parse', '--verify', 'refs/remotes/origin/master'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    runGitAllowFailure(['-C', workspacePath, 'branch', '--force', 'master', 'origin/master']);
  } catch {
    // origin/master does not exist
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

function ensureWorkspaceGitExcludesSteroids(workspacePath: string): void {
  const excludePath = join(workspacePath, '.git', 'info', 'exclude');
  mkdirSync(dirname(excludePath), { recursive: true });

  let existing = '';
  try {
    existing = readFileSync(excludePath, 'utf-8');
  } catch {
    existing = '';
  }

  const patterns = ['.steroids', '/.steroids'];
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  const missing = patterns.filter((pattern) => !existingLines.has(pattern));
  if (missing.length === 0) {
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(excludePath, `${prefix}${missing.join('\n')}\n`, 'utf-8');
}

function enforceWorkspaceDependencyIsolation(workspacePath: string): void {
  const nodeModulesPath = join(workspacePath, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    return;
  }

  const stats = lstatSync(nodeModulesPath);
  if (stats.isSymbolicLink()) {
    throw new WorkspaceCloneError(
      `Forbidden shared mutable dependency directory: ${nodeModulesPath} is a symlink`
    );
  }
}

export function ensureWorkspaceSteroidsSymlink(
  workspacePath: string,
  projectPath: string
): string {
  const targetSteroidsPath = resolveSteroidsDir(projectPath);
  const destination = join(workspacePath, '.steroids');

  let shouldRecreate = true;
  if (existsSync(destination)) {
    try {
      const stats = lstatSync(destination);
      if (stats.isSymbolicLink() && realpathSync(destination) === targetSteroidsPath) {
        shouldRecreate = false;
      }
    } catch {
      shouldRecreate = true;
    }
  }

  if (shouldRecreate) {
    rmSync(destination, { recursive: true, force: true });
    // Use the resolved path to avoid symlink chain surprises.
    symlinkSync(targetSteroidsPath, destination);
  }

  verifySteroidsSymlink(destination);
  ensureWorkspaceGitExcludesSteroids(workspacePath);
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

  // When seeding from a prior workstream, clone from that path (preserving full history).
  // Otherwise clone from projectPath with shallow flags.
  const cloneSource = options.fromPath ? resolve(options.fromPath) : projectPath;
  let usedLocalClone = isSameFileSystem(cloneSource, workspaceRoot);

  const buildCloneArgs = (useLocal: boolean): string[] => {
    const baseArgs = options.fromPath
      ? ['clone'] // full history — prior work is in the object store
      : ['clone', '--depth', '1', '--no-tags', '--single-branch'];
    return [...baseArgs, ...(useLocal ? ['--local'] : []), cloneSource, workspacePath];
  };

  try {
    // hardcoded command, no user input
    execFileSync('git', buildCloneArgs(usedLocalClone), { cwd: process.cwd(), stdio: 'inherit' });
  } catch (error: unknown) {
    // If --local clone failed, retry without it (handles cross-device link on macOS APFS)
    if (usedLocalClone) {
      rmSync(workspacePath, { recursive: true, force: true });
      usedLocalClone = false;
      try {
        execFileSync('git', buildCloneArgs(false), { cwd: process.cwd(), stdio: 'inherit' });
      } catch (retryError: unknown) {
        rmSync(workspacePath, { recursive: true, force: true });
        throw new WorkspaceCloneError('Git clone failed', retryError);
      }
    } else {
      rmSync(workspacePath, { recursive: true, force: true });
      throw new WorkspaceCloneError('Git clone failed', error);
    }
  }

  // When seeding from a prior workstream, git sets origin to that local path.
  // Resolve the real remote URL from projectPath (one hop) so push targets the correct remote.
  if (options.fromPath) {
    let originUrl = projectPath;
    try {
      const sourceRemote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (sourceRemote && !sourceRemote.startsWith('/') && !sourceRemote.startsWith('.') && !sourceRemote.startsWith('~')) {
        originUrl = sourceRemote;
      }
    } catch {
      // Keep projectPath — resolveRemoteUrl will classify it correctly downstream.
    }
    try {
      // hardcoded command, no user input
      execFileSync('git', ['-C', workspacePath, 'remote', 'set-url', 'origin', originUrl], { stdio: 'inherit' });
    } catch (error: unknown) {
      rmSync(workspacePath, { recursive: true, force: true });
      throw new WorkspaceCloneError('Failed to reset origin after seeding clone from prior workstream', error);
    }
  }

  ensureMainOrMasterBranches(workspacePath);

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
    steroidsSymlinkPath = ensureWorkspaceSteroidsSymlink(workspacePath, projectPath);
  } catch (error: unknown) {
    rmSync(workspacePath, { recursive: true, force: true });
    throw new WorkspaceCloneError('Failed to create .steroids symlink', error);
  }



  enforceWorkspaceDependencyIsolation(workspacePath);

  // Copy assigned skills (global + project) to the workspace clone
  try {
    const skillsToCopy = new Set<string>();
    
    // 1. Get global config skills
    const globalConfigPath = require('../config/loader.js').getGlobalConfigPath();
    if (existsSync(globalConfigPath)) {
      const globalConfig = loadConfigFile(globalConfigPath) as SteroidsConfig;
      if (globalConfig.skills) globalConfig.skills.forEach(s => skillsToCopy.add(s));
    }

    // 2. Get project config skills
    const projectConfigPath = resolve(projectPath, 'steroids.config.yaml');
    if (existsSync(projectConfigPath)) {
      const projectConfig = loadConfigFile(projectConfigPath) as SteroidsConfig;
      if (projectConfig.skills) projectConfig.skills.forEach(s => skillsToCopy.add(s));
    }

    if (skillsToCopy.size > 0) {
      const skillsDir = resolve(workspacePath, '.steroids', 'skills');
      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }
      for (const skill of skillsToCopy) {
        const skillContent = getSkillContent(skill);
        if (skillContent) {
          writeFileSync(resolve(skillsDir, `${skill}.md`), skillContent, 'utf-8');
        }
      }
    }
  } catch (error) {
    console.error('Failed to copy skills to workspace clone:', error);
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
