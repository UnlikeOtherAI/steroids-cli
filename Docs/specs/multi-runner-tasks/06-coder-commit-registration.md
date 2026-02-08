# Hook Coder to Register Commits

## Problem
After the coder completes work, we need to:
1. Detect which commits were made during this task
2. Register them in the `task_commits` table
3. Update the task's `latest_commit` field

## Files to Modify
- `src/orchestrator/coder.ts` - Add commit registration after coder completes
- `src/runners/orchestrator-loop.ts` - Record base_commit before coder starts
- `src/git/status.ts` - Add helper to get commits between two refs

## Implementation

### Step 1: Add git helpers to src/git/status.ts

```typescript
/**
 * Get current HEAD commit hash
 */
export function getCurrentCommit(projectPath: string): string {
  return execSync('git rev-parse HEAD', {
    cwd: projectPath,
    encoding: 'utf-8',
  }).trim();
}

/**
 * Get commits between two refs (exclusive base, inclusive head)
 */
export function getCommitsBetween(
  projectPath: string,
  baseCommit: string,
  headCommit: string = 'HEAD'
): Array<{ hash: string; message: string; files: string[] }> {
  // Get commit hashes and messages
  const logOutput = execSync(
    `git log --format="%H|%s" ${baseCommit}..${headCommit}`,
    { cwd: projectPath, encoding: 'utf-8' }
  ).trim();

  if (!logOutput) return [];

  const commits = logOutput.split('\n').map(line => {
    const [hash, message] = line.split('|');
    return { hash, message, files: [] as string[] };
  });

  // Get changed files for each commit
  for (const commit of commits) {
    const filesOutput = execSync(
      `git diff-tree --no-commit-id --name-only -r ${commit.hash}`,
      { cwd: projectPath, encoding: 'utf-8' }
    ).trim();

    commit.files = filesOutput ? filesOutput.split('\n') : [];
  }

  return commits;
}

/**
 * Get parent commit of a given commit
 */
export function getCommitParent(
  projectPath: string,
  commitHash: string
): string | null {
  try {
    return execSync(`git rev-parse ${commitHash}^`, {
      cwd: projectPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null; // No parent (root commit)
  }
}
```

### Step 2: Update orchestrator-loop.ts

Before invoking coder, record the base commit:

```typescript
import { getCurrentCommit } from '../git/status.js';
import { updateTaskCommitTracking } from '../database/commits.js';

// In the loop, before invoking coder:
async function runCoderPhase(db: Database.Database, task: Task, projectPath: string) {
  // Record where we're starting from
  const baseCommit = getCurrentCommit(projectPath);

  // If this is the first attempt, set base_commit
  // Otherwise, just update attempt_base_commit
  if (!task.base_commit) {
    updateTaskCommitTracking(db, task.id, {
      base_commit: baseCommit,
      attempt_base_commit: baseCommit,
      current_attempt: 1,
    });
  } else {
    updateTaskCommitTracking(db, task.id, {
      attempt_base_commit: baseCommit,
      current_attempt: (task.current_attempt || 0) + 1,
    });
  }

  // Invoke coder
  await invokeCoder(task, projectPath);

  // After coder completes, register commits
  await registerCoderCommits(db, task.id, baseCommit, projectPath);
}
```

### Step 3: Add commit registration function

```typescript
import { registerCommit, updateTaskCommitTracking, isCommitRegistered } from '../database/commits.js';
import { getCommitsBetween, getCurrentCommit } from '../git/status.js';

async function registerCoderCommits(
  db: Database.Database,
  taskId: string,
  baseCommit: string,
  projectPath: string
): Promise<void> {
  const currentHead = getCurrentCommit(projectPath);

  // If no new commits, nothing to register
  if (currentHead === baseCommit) {
    console.log('No new commits from coder');
    return;
  }

  // Get all commits made since base
  const commits = getCommitsBetween(projectPath, baseCommit, currentHead);

  // Get task's current attempt number
  const task = db.prepare('SELECT current_attempt FROM tasks WHERE id = ?').get(taskId) as { current_attempt: number };
  const attemptNumber = task?.current_attempt || 1;

  // Register each commit
  for (const commit of commits) {
    // Skip if already registered (e.g., if coder is resumed)
    if (isCommitRegistered(db, commit.hash)) {
      continue;
    }

    registerCommit(db, {
      taskId,
      commitHash: commit.hash,
      commitMessage: commit.message,
      attemptNumber,
      filesChanged: commit.files,
    });

    console.log(`Registered commit: ${commit.hash.slice(0, 8)} - ${commit.message}`);
  }

  // Update task's latest commit
  updateTaskCommitTracking(db, taskId, {
    latest_commit: currentHead,
  });
}
```

### Step 4: Handle rejection (increment attempt)

When a task is rejected, the current attempt's commits are marked rejected and attempt number increments:

```typescript
// In tasks.ts or wherever rejection is handled
async function handleTaskRejection(
  db: Database.Database,
  taskId: string,
  reason: string
): Promise<void> {
  const task = db.prepare('SELECT current_attempt FROM tasks WHERE id = ?').get(taskId) as { current_attempt: number };

  // Mark this attempt's commits as rejected
  markCommitsRejected(db, taskId, task.current_attempt, reason);

  // Task status goes back to pending, coder will be invoked again
  // current_attempt will be incremented when coder starts
}
```

## Coder Commit Message Format

For easier tracking, we could recommend coders use a specific format:

```
[steroids:{taskId}] Actual commit message here
```

But this is optional - the registration tracks commits by time/parent relationship, not by message parsing.

## Testing

```bash
# Start a task
steroids tasks update <task-id> --status in_progress

# Manually invoke coder (or let runner do it)
# Coder makes some commits

# Check commits were registered
sqlite3 .steroids/steroids.db "SELECT commit_hash, commit_message, attempt_number FROM task_commits WHERE task_id = '<task-id>'"

# Check task's latest_commit
sqlite3 .steroids/steroids.db "SELECT latest_commit, current_attempt FROM tasks WHERE id = '<task-id>'"
```

## Edge Cases

- **Coder makes no commits**: Nothing to register, `latest_commit` stays null/unchanged
- **Coder is interrupted**: Commits made so far are registered on next run
- **Duplicate registration**: `isCommitRegistered()` check prevents duplicates
- **Rebase invalidates hashes**: Out of scope for initial implementation (document as known limitation)
