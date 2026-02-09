/**
 * Git status and diff utilities
 */

import { execSync } from 'node:child_process';

/**
 * Get the current HEAD commit SHA
 */
export function getCurrentCommitSha(projectPath: string = process.cwd()): string | null {
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
 * Get short (7 char) commit SHA
 */
export function getShortCommitSha(projectPath: string = process.cwd()): string | null {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

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

/**
 * Find the commit hash for a task by searching commit messages
 * Returns the most recent commit that mentions the task title
 */
export function findTaskCommit(
  projectPath: string,
  taskTitle: string
): string | null {
  try {
    // Search last 20 commits for one mentioning the task
    const log = execSync('git log --oneline -20', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Look for commit message containing key words from task title
    const titleWords = taskTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const lines = log.trim().split('\n');

    for (const line of lines) {
      const [hash, ...messageParts] = line.split(' ');
      const message = messageParts.join(' ').toLowerCase();

      // Check if at least 2 significant words match
      let matches = 0;
      for (const word of titleWords) {
        if (message.includes(word)) matches++;
      }
      if (matches >= 2 || (titleWords.length <= 2 && matches >= 1)) {
        return hash;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the diff of a specific commit
 */
export function getCommitDiff(
  projectPath: string,
  commitHash: string
): string {
  try {
    return execSync(`git show ${commitHash} --stat --patch`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/**
 * Get files changed in a specific commit
 */
export function getCommitFiles(
  projectPath: string,
  commitHash: string
): string[] {
  try {
    const output = execSync(`git show --name-only --pretty=format: ${commitHash}`, {
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
 * Check if a specific file is tracked by git
 */
export function isFileTracked(
  filePath: string,
  projectPath: string = process.cwd()
): boolean {
  try {
    execSync(`git ls-files --error-unmatch "${filePath}"`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific file has uncommitted changes (staged or unstaged)
 */
export function isFileDirty(
  filePath: string,
  projectPath: string = process.cwd()
): boolean {
  try {
    const status = execSync(`git status --porcelain -- "${filePath}"`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return status.length > 0;
  } catch {
    return true;
  }
}

/**
 * Get the SHA of the most recent commit that modified a file
 */
export function getFileLastCommit(
  filePath: string,
  projectPath: string = process.cwd()
): string | null {
  try {
    return execSync(`git log -1 --format=%H -- "${filePath}"`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the git blob hash of a file at HEAD (content-addressable hash)
 */
export function getFileContentHash(
  filePath: string,
  projectPath: string = process.cwd()
): string | null {
  try {
    return execSync(`git rev-parse HEAD:"${filePath}"`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}
