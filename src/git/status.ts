/**
 * Git status and diff utilities
 */

import { execSync, execFileSync } from 'node:child_process';

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
    // Search last 50 commits across all branches (including worktree branches)
    // --all ensures commits made in parallel worktrees are visible
    const log = execSync('git log --oneline --all -50', {
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
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], {
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
    const status = execFileSync('git', ['status', '--porcelain', '--', filePath], {
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
    return execFileSync('git', ['log', '-1', '--format=%H', '--', filePath], {
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
    return execFileSync('git', ['rev-parse', `HEAD:${filePath}`], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get recent commits with SHA and message
 */
export function getRecentCommits(
  projectPath: string = process.cwd(),
  count: number = 5,
  sinceSha?: string
): Array<{ sha: string; message: string }> {
  try {
    const range = sinceSha ? `${sinceSha}..HEAD` : `-${count}`;
    const log = execSync(`git log ${range} --format=%H||%s`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return log.trim().split('\n').filter(Boolean).map(line => {
      const [sha, ...messageParts] = line.split('||');
      return { sha, message: messageParts.join('||') };
    });
  } catch {
    return [];
  }
}

/**
 * Get changed files since last commit
 */
export function getChangedFiles(
  projectPath: string = process.cwd()
): string[] {
  try {
    // Get both staged and unstaged files
    const output = execSync('git diff --name-only HEAD', {
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
 * Get diff summary (additions/deletions)
 */
export function getDiffSummary(
  projectPath: string = process.cwd()
): string {
  try {
    const output = execSync('git diff --stat HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return '';
  }
}

/**
 * Get diff additions and deletions count
 */
export function getDiffStats(
  projectPath: string = process.cwd(),
  ref?: string
): { additions: number; deletions: number } {
  try {
    const cmd = ref
      ? `git diff --numstat ${ref}`
      : 'git diff --numstat HEAD~1';
    const output = execSync(cmd, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let additions = 0;
    let deletions = 0;

    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      const [add, del] = line.split(/\s+/);
      additions += parseInt(add) || 0;
      deletions += parseInt(del) || 0;
    }

    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}
