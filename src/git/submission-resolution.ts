import { execSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { openGlobalDatabase } from '../runners/global-db.js';
import { isCommitReachable, isCommitReachableWithFetch } from './status.js';

interface WorkstreamSource {
  clonePath: string;
  branchName: string;
}

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

function fetchWorkstreamBranch(
  projectPath: string,
  clonePath: string,
  branchName: string,
  suffix: string
): boolean {
  const fetchRef = `refs/steroids/recovery/${safeRecoveryRef(branchName)}-${suffix}`;

  try {
    execSync(
      'git',
      [
        '-C',
        projectPath,
        'fetch',
        clonePath,
        `+${branchName}:${fetchRef}`,
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the latest reachable commit among historical submission candidates.
 * Falls back to parallel workstream clone fetches if the commit is missing locally.
 */
export function resolveLatestReachableSubmissionCommitSha(
  projectPath: string,
  candidateShas: string[]
): string | null {
  const normalizedShas = Array.from(new Set(
    candidateShas
      .map(sha => sha.trim())
      .filter(sha => sha.length > 0)
  ));

  for (const sha of normalizedShas) {
    if (isCommitReachableWithFetch(projectPath, sha, { forceFetch: true })) {
      return sha;
    }
  }

  const sources = getParallelWorkstreamSources(projectPath);
  if (sources.length === 0) {
    return null;
  }

  const suffix = Date.now().toString(36);
  for (const source of sources) {
    const fetched = fetchWorkstreamBranch(projectPath, source.clonePath, source.branchName, suffix);
    if (!fetched) continue;
  }

  for (const sha of normalizedShas) {
    if (isCommitReachable(projectPath, sha)) {
      return sha;
    }
  }

  return null;
}
