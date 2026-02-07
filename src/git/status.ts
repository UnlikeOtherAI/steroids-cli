/**
 * Git status and diff utilities
 */

import { execSync } from 'node:child_process';

/**
 * Get git status output
 */
export function getGitStatus(projectPath: string = process.cwd()): string {
  try {
    return execSync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * Get git diff output
 */
export function getGitDiff(
  projectPath: string = process.cwd(),
  ref?: string
): string {
  try {
    const cmd = ref ? `git diff ${ref}` : 'git diff';
    return execSync(cmd, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  } catch {
    return '';
  }
}

/**
 * Get list of modified files
 */
export function getModifiedFiles(
  projectPath: string = process.cwd(),
  ref?: string
): string[] {
  try {
    const cmd = ref ? `git diff --name-only ${ref}` : 'git diff --name-only HEAD~1';
    const output = execSync(cmd, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if there are uncommitted changes
 */
export function hasUncommittedChanges(
  projectPath: string = process.cwd()
): boolean {
  const status = getGitStatus(projectPath);
  return status.trim().length > 0;
}

/**
 * Check if we're in a git repository
 */
export function isGitRepo(projectPath: string = process.cwd()): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
