/**
 * Git helper operations used by parallel merge orchestration.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ParallelMergeError } from './merge-errors.js';

export interface GitCommandOptions {
  allowFailure?: boolean;
  maxBuffer?: number;
  timeoutMs?: number;
}

export function runGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {}
): string {
  const { allowFailure = false, timeoutMs = 120_000 } = options;

  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: options.maxBuffer,
    }).trim();
  } catch (error: unknown) {
    if (allowFailure) {
      if (error instanceof Error) {
        const err = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
        return [err.stdout, err.stderr]
          .map((value) => (typeof value === 'string' ? value : value?.toString()))
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      return '';
    }

    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    const details = [stderr, stdout].filter(Boolean).join('\n') || err.message || 'Unknown git error';
    throw new ParallelMergeError(`Git command failed: git ${args.join(' ')}\n${details}`, 'GIT_ERROR');
  }
}

export function cleanTreeHasConflicts(projectPath: string): boolean {
  const status = runGitCommand(projectPath, ['status', '--porcelain']);
  return status.split('\n').some((line) => line.startsWith('UU') || line.includes('U'));
}

export function hasUnmergedFiles(projectPath: string): boolean {
  const unmerged = runGitCommand(projectPath, ['diff', '--name-only', '--diff-filter=U']);
  return unmerged.trim().length > 0;
}

export function gitStatusLines(projectPath: string): string[] {
  const status = runGitCommand(projectPath, ['status', '--porcelain']);
  return status.split('\n').filter(Boolean);
}

export function hasCherryPickInProgress(projectPath: string): boolean {
  return existsSync(resolve(projectPath, '.git', 'CHERRY_PICK_HEAD'));
}

export function getWorkstreamCommitList(
  projectPath: string,
  remote: string,
  workstreamBranch: string,
  mainBranch: string
): string[] {
  const arg = `${mainBranch}..${remote}/${workstreamBranch}`;
  const output = runGitCommand(
    projectPath,
    ['log', arg, '--format=%H', '--reverse'],
    { allowFailure: true }
  );

  if (/error:|fatal:|error /.test(output.toLowerCase()) && !isMissingRemoteBranchFailure(output)) {
    throw new ParallelMergeError(
      `Failed to list commits from ${remote}/${workstreamBranch}: ${output}`,
      'COMMIT_LIST_FAILED'
    );
  }

  if (isMissingRemoteBranchFailure(output)) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getCommitPatch(projectPath: string, commitSha: string): string {
  return runGitCommand(projectPath, ['show', commitSha, '--']);
}

export function getCommitMessage(projectPath: string, commitSha: string): string {
  return runGitCommand(projectPath, ['log', '-1', '--format=%s%n%b', commitSha]);
}

export function getCommitShortSha(commitSha: string): string {
  return commitSha.length > 7 ? commitSha.slice(0, 7) : commitSha;
}

export function getConflictedFiles(projectPath: string): string[] {
  const output = runGitCommand(projectPath, ['diff', '--name-only', '--diff-filter=U']);
  return output.split('\n').filter(Boolean);
}

export function getCachedDiff(projectPath: string): string {
  return runGitCommand(projectPath, ['diff', '--cached']);
}

export function getCachedFiles(projectPath: string): string[] {
  const output = runGitCommand(projectPath, ['diff', '--cached', '--name-only']);
  return output.split('\n').filter(Boolean);
}

export function isNonFatalFetchResult(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('couldn\'t find remote ref') ||
    lower.includes('does not exist') ||
    lower.includes('fatal: remote ref does not exist')
  );
}

export function isMissingRemoteBranchFailure(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('couldn\'t find remote ref') ||
    (lower.includes('remote branch') && lower.includes('not found')) ||
    lower.includes('unknown revision or path not in the working tree') ||
    lower.includes('does not exist') ||
    lower.includes('fatal: remote ref does not exist')
  );
}

export function safeRunMergeCommand(projectPath: string, remote: string, branchName: string): void {
  const output = runGitCommand(projectPath, ['fetch', '--prune', remote, branchName], { allowFailure: true });
  const lower = output.toLowerCase();

  if (!/error:|fatal:/.test(lower)) {
    return;
  }

  if (isNonFatalFetchResult(lower)) {
    return;
  }

  throw new ParallelMergeError(`Failed to fetch ${branchName} from ${remote}: ${output}`, 'FETCH_FAILED');
}

export function isNoPushError(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes('error:') || lower.includes('fatal:');
}
