import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { openGlobalDatabase } from '../runners/global-db.js';
import { isCommitReachable, isCommitReachableWithFetch } from './status.js';

interface WorkstreamSource {
  clonePath: string;
  branchName: string;
}

type ResolutionReason =
  | 'no_candidates'
  | 'not_reachable'
  | 'workstream_discovery_failed';

export type SubmissionHashResolution =
  | {
    status: 'resolved';
    sha: string;
    strategy: 'local_or_remote' | 'workstream_fetch';
    attempts: string[];
  }
  | {
    status: 'unresolved';
    reason: ResolutionReason;
    attempts: string[];
  };

function getProjectRepoId(projectPath: string): string {
  try {
    return realpathSync(projectPath);
  } catch {
    return resolve(projectPath);
  }
}

function getParallelWorkstreamSources(projectPath: string): WorkstreamSource[] {
  const normalizedProjectPath = getProjectRepoId(projectPath);
  const projectRepoId = getProjectRepoId(projectPath);
  const { db, close } = openGlobalDatabase();
  try {
    const rows = db
      .prepare(
        `
        SELECT ws.clone_path, ws.branch_name
        FROM workstreams ws
        JOIN parallel_sessions ps ON ps.id = ws.session_id
        WHERE (ps.project_path = ? OR ps.project_repo_id = ?)
          AND ps.status NOT IN ('failed', 'aborted')
          AND ws.clone_path IS NOT NULL
        `
      )
      .all(normalizedProjectPath, projectRepoId) as Array<{
      clone_path: string;
      branch_name: string;
    }>;

    const seen = new Set<string>();
    const sources: WorkstreamSource[] = [];
    for (const row of rows) {
      if (!row.clone_path) continue;
      const resolvedClonePath = resolve(row.clone_path);
      if (resolvedClonePath === normalizedProjectPath) continue;
      if (!existsSync(row.clone_path)) continue;

      const key = `${row.clone_path}::${row.branch_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        clonePath: row.clone_path,
        branchName: row.branch_name,
      });
    }
    return sources;
  } finally {
    close();
  }
}

function safeRecoveryRef(pathLike: string): string {
  return pathLike.replace(/[^\w.-]/g, '_');
}

function isGitRepoPath(pathValue: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: pathValue,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function cleanupRecoveryRefs(projectPath: string, refs: string[]): void {
  for (const ref of refs) {
    try {
      execSync(`git update-ref -d ${ref}`, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
      });
    } catch {
      // best effort
    }
  }
}

function fetchWorkstreamBranch(
  projectPath: string,
  clonePath: string,
  branchName: string,
  suffix: string,
  attempts: string[]
): { success: boolean; recoveryRef?: string } {
  if (!existsSync(clonePath) || !isGitRepoPath(clonePath)) {
    attempts.push(`workstream_skip:${clonePath}:invalid_repo`);
    return { success: false };
  }

  const fetchRef = `refs/steroids/recovery/${safeRecoveryRef(branchName)}-${suffix}`;
  attempts.push(`workstream_fetch:${clonePath}:${branchName}`);

  try {
    execSync(`git fetch ${clonePath} +${branchName}:${fetchRef}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    attempts.push(`workstream_fetch_ok:${clonePath}:${branchName}`);
    return { success: true, recoveryRef: fetchRef };
  } catch {
    attempts.push(`workstream_fetch_fail:${clonePath}:${branchName}`);
    return { success: false };
  }
}

/**
 * Resolve the latest reachable commit among historical submission candidates.
 * Falls back to parallel workstream clone fetches if the commit is missing locally.
 */
export function resolveSubmissionCommitWithRecovery(
  projectPath: string,
  candidateShas: string[]
): SubmissionHashResolution {
  const normalizedShas = Array.from(new Set(
    candidateShas
      .map(sha => sha.trim())
      .filter(sha => sha.length > 0)
  ));
  const attempts: string[] = [];

  if (normalizedShas.length === 0) {
    return {
      status: 'unresolved',
      reason: 'no_candidates',
      attempts,
    };
  }

  for (const sha of normalizedShas) {
    attempts.push(`local_or_remote_check:${sha}`);
    if (isCommitReachableWithFetch(projectPath, sha, { forceFetch: true })) {
      return {
        status: 'resolved',
        sha,
        strategy: 'local_or_remote',
        attempts,
      };
    }
  }

  let sources: WorkstreamSource[] = [];
  try {
    sources = getParallelWorkstreamSources(projectPath);
  } catch {
    return {
      status: 'unresolved',
      reason: 'workstream_discovery_failed',
      attempts,
    };
  }

  if (sources.length === 0) {
    return {
      status: 'unresolved',
      reason: 'not_reachable',
      attempts,
    };
  }

  const nonce = randomUUID();
  const createdRecoveryRefs: string[] = [];
  for (const source of sources) {
    const fetched = fetchWorkstreamBranch(projectPath, source.clonePath, source.branchName, nonce, attempts);
    if (fetched.recoveryRef) {
      createdRecoveryRefs.push(fetched.recoveryRef);
    }
  }

  for (const sha of normalizedShas) {
    attempts.push(`post_workstream_check:${sha}`);
    if (isCommitReachable(projectPath, sha)) {
      cleanupRecoveryRefs(projectPath, createdRecoveryRefs);
      return {
        status: 'resolved',
        sha,
        strategy: 'workstream_fetch',
        attempts,
      };
    }
  }

  cleanupRecoveryRefs(projectPath, createdRecoveryRefs);

  return {
    status: 'unresolved',
    reason: 'not_reachable',
    attempts,
  };
}
