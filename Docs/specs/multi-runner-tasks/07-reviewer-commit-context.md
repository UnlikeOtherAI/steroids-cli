# Update Reviewer to Use Commit Registry

## Problem
The reviewer currently uses `findTaskCommit()` which searches commit messages heuristically. This fails when multiple runners make interleaved commits. The reviewer needs to use the `task_commits` table to see exactly which commits belong to the task.

## Files to Modify
- `src/orchestrator/reviewer.ts` - Use commit registry for diff generation
- `src/git/status.ts` - Add diff generation between specific commits

## Implementation

### Step 1: Add diff helper to src/git/status.ts

```typescript
/**
 * Generate diff between two commits
 */
export function getDiffBetweenCommits(
  projectPath: string,
  baseCommit: string,
  targetCommit: string
): string {
  try {
    return execSync(
      `git diff ${baseCommit}..${targetCommit}`,
      { cwd: projectPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (err: any) {
    return `Error generating diff: ${err.message}`;
  }
}

/**
 * Get list of files changed between two commits
 */
export function getFilesChangedBetween(
  projectPath: string,
  baseCommit: string,
  targetCommit: string
): string[] {
  const output = execSync(
    `git diff --name-only ${baseCommit}..${targetCommit}`,
    { cwd: projectPath, encoding: 'utf-8' }
  ).trim();

  return output ? output.split('\n') : [];
}
```

### Step 2: Update reviewer.ts

Replace the current diff generation logic with commit-registry-based approach:

```typescript
import {
  getCommitsForTask,
  getCommitsForAttempt,
  getCommitHistory,
} from '../database/commits.js';
import { getDiffBetweenCommits, getFilesChangedBetween } from '../git/status.js';

interface ReviewContext {
  task: Task;
  commits: TaskCommit[];
  rejectionHistory: Array<{
    attempt: number;
    commits: TaskCommit[];
    reason: string;
  }>;
  currentDiff: string;
  filesChanged: string[];
}

/**
 * Build review context from commit registry
 */
function buildReviewContext(
  db: Database.Database,
  task: Task,
  projectPath: string
): ReviewContext {
  // Get all commits for this task
  const allCommits = getCommitsForTask(db, task.id);

  // Group by attempt for rejection history
  const commitHistory = getCommitHistory(db, task.id);
  const rejectionHistory: ReviewContext['rejectionHistory'] = [];

  for (const [attempt, commits] of commitHistory) {
    // Skip current attempt
    if (attempt === task.current_attempt) continue;

    // Find if this attempt was rejected
    const rejectedCommit = commits.find(c => c.status === 'rejected');
    if (rejectedCommit) {
      rejectionHistory.push({
        attempt,
        commits,
        reason: rejectedCommit.rejection_reason || 'No reason provided',
      });
    }
  }

  // Get current attempt's commits
  const currentCommits = getCommitsForAttempt(db, task.id, task.current_attempt || 1);

  // Generate diff
  let currentDiff = '';
  let filesChanged: string[] = [];

  if (task.attempt_base_commit && task.latest_commit) {
    currentDiff = getDiffBetweenCommits(
      projectPath,
      task.attempt_base_commit,
      task.latest_commit
    );
    filesChanged = getFilesChangedBetween(
      projectPath,
      task.attempt_base_commit,
      task.latest_commit
    );
  } else if (currentCommits.length > 0) {
    // Fallback: diff from parent of first commit to latest
    const firstCommit = currentCommits[0];
    const lastCommit = currentCommits[currentCommits.length - 1];
    const baseCommit = getCommitParent(projectPath, firstCommit.commit_hash);

    if (baseCommit) {
      currentDiff = getDiffBetweenCommits(projectPath, baseCommit, lastCommit.commit_hash);
      filesChanged = getFilesChangedBetween(projectPath, baseCommit, lastCommit.commit_hash);
    }
  }

  return {
    task,
    commits: currentCommits,
    rejectionHistory,
    currentDiff,
    filesChanged,
  };
}
```

### Step 3: Update reviewer prompt template

```typescript
function generateReviewerPrompt(context: ReviewContext, spec: string): string {
  const { task, commits, rejectionHistory, currentDiff, filesChanged } = context;

  let prompt = `# STEROIDS REVIEWER TASK

You are reviewing task: ${task.title}
Task ID: ${task.id}
Current Attempt: #${task.current_attempt || 1}

## Original Specification
${spec}

`;

  // Add rejection history if any
  if (rejectionHistory.length > 0) {
    prompt += `## Previous Rejections\n\n`;
    for (const rejection of rejectionHistory) {
      prompt += `### Attempt #${rejection.attempt} (REJECTED)\n`;
      prompt += `Commits:\n`;
      for (const commit of rejection.commits) {
        prompt += `- \`${commit.commit_hash.slice(0, 8)}\` ${commit.commit_message}\n`;
      }
      prompt += `\nRejection Reason: ${rejection.reason}\n\n`;
    }
  }

  // Add current attempt info
  prompt += `## Current Attempt (#${task.current_attempt || 1})\n\n`;

  if (commits.length === 0) {
    prompt += `**No commits found for this attempt.**\n\n`;
    prompt += `The coder may have claimed work already exists. Verify their claims.\n\n`;
  } else {
    prompt += `### Commits (${commits.length})\n`;
    for (const commit of commits) {
      prompt += `- \`${commit.commit_hash.slice(0, 8)}\` ${commit.commit_message}\n`;
      if (commit.files_changed && commit.files_changed.length > 0) {
        prompt += `  Files: ${commit.files_changed.join(', ')}\n`;
      }
    }
    prompt += `\n`;
  }

  // Add files changed summary
  if (filesChanged.length > 0) {
    prompt += `### Files Changed\n`;
    for (const file of filesChanged) {
      prompt += `- ${file}\n`;
    }
    prompt += `\n`;
  }

  // Add diff
  prompt += `## Diff to Review\n\n`;
  if (currentDiff) {
    prompt += '```diff\n' + currentDiff + '\n```\n\n';
  } else {
    prompt += `No diff available. Check if coder referenced existing commits.\n\n`;
  }

  // Add review instructions
  prompt += `## Your Decision

**IMPORTANT:** Only review commits listed above. Ignore any commits from other tasks.

If the coder claims work exists in earlier commits:
1. Verify by running \`git show <hash>\` on the referenced commits
2. If work truly exists and matches spec: APPROVE
3. If gaps remain: REJECT with specific feedback

`;

  return prompt;
}
```

### Step 4: Remove findTaskCommit fallback

The old `findTaskCommit()` function searched commit messages for task title words. This can be kept as a last-resort fallback but should not be the primary method:

```typescript
// In reviewer.ts

async function invokeReviewer(task: Task, projectPath: string): Promise<ReviewResult> {
  const { db, close } = openDatabase(projectPath);

  try {
    // Build context from commit registry (NEW)
    const context = buildReviewContext(db, task, projectPath);

    // Generate prompt
    const spec = await loadTaskSpec(task);
    const prompt = generateReviewerPrompt(context, spec);

    // Invoke reviewer model
    // ...
  } finally {
    close();
  }
}
```

## Testing

```bash
# Create a task
steroids tasks add "Test task" --section "..." --source "..."

# Simulate coder work
# ... coder makes commits ...

# Check review context includes correct commits
steroids tasks list --status review
steroids logs show <task-id> --full  # Should show commit list in reviewer prompt
```

## Edge Cases

- **No commits in registry**: Fallback message instructs reviewer to verify coder's claims
- **Empty diff but commits exist**: Could mean coder reverted changes - reviewer should investigate
- **Many rejection attempts**: All history is shown to help reviewer understand patterns
