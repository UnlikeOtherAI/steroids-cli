/**
 * Git push operations
 * Handles pushing completed work with resilience
 */

import { execSync } from 'node:child_process';

export interface PushResult {
  success: boolean;
  error?: string;
  commitHash?: string;
}

/**
 * Get the current commit hash
 */
export function getCurrentCommitHash(
  projectPath: string = process.cwd()
): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Push to remote repository
 */
export function pushToRemote(
  projectPath: string = process.cwd(),
  remote: string = 'origin',
  branch: string = 'main'
): PushResult {
  try {
    execSync(`git push ${remote} ${branch}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000, // 2 minute timeout
    });

    const commitHash = getCurrentCommitHash(projectPath);

    console.log(`Successfully pushed to ${remote}/${branch}`);
    return {
      success: true,
      commitHash: commitHash ?? undefined,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    const errorMsg = err.stderr ?? err.message ?? 'Unknown push error';

    console.error(`Push failed: ${errorMsg}`);

    // Classify the error
    const lowerError = errorMsg.toLowerCase();
    if (lowerError.includes('non-fast-forward') || lowerError.includes('rejected')) {
      console.warn('Push rejected due to conflict. Human intervention required.');
    } else if (lowerError.includes('connection') || lowerError.includes('timeout')) {
      console.warn('Network error. Will retry on next task completion.');
    } else if (lowerError.includes('auth')) {
      console.warn('Authentication error. Check git credentials.');
    }

    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Get remote URL for logging
 */
export function getRemoteUrl(
  projectPath: string = process.cwd(),
  remote: string = 'origin'
): string | null {
  try {
    return execSync(`git remote get-url ${remote}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if we're on a branch that tracks a remote
 */
export function hasRemoteTracking(
  projectPath: string = process.cwd()
): boolean {
  try {
    execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
