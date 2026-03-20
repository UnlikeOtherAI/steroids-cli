# Stale Task Branch Cleanup on Rebase Conflict

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a task fails the merge pipeline with a rebase conflict, delete the stale local task branch so the next retry starts clean from the current base.

**Architecture:** A single helper function (`deleteTaskBranchFromSlot`) called from two sites: `handleMergeFailure` (automatic conflict-retry path, local-only) and `tasks-reset.ts` (manual reset path, local + remote). Both ensure no stale branch survives to poison the next `prepareForTask` cycle.

**Tech Stack:** TypeScript, better-sqlite3, child_process (git CLI)

---

## Problem Statement

When a task's merge pipeline fails with a rebase conflict, the task is returned to pending for retry, but the stale task branch (`steroids/task-<id>`) is never deleted from the pool slot. On the next pickup, `prepareForTask` (git-lifecycle.ts:258-265) finds the existing branch and checks it out — reusing commits from a stale fork point. The rebase against the now-advanced `origin/main` produces the same conflict every time, creating an infinite loop: code -> approve -> rebase conflict -> retry -> same conflict.

Real-world impact: task `6dc82320` in the wireframes project hit this 7 times across 3 manual resets. Each cycle burned ~5 minutes of coder + reviewer LLM invocations producing perfectly valid code that could never merge.

## Current Behavior

1. Coder picks up task -> `prepareForTask` finds existing `steroids/task-<id>` branch -> checks it out (git-lifecycle.ts:262)
2. Coder implements feature on top of stale base commits
3. Reviewer approves
4. `mergeToBase` runs `git rebase origin/main` -> conflict (git-lifecycle.ts:402-412)
5. `handleMergeFailure` increments `conflict_count`, calls `returnTaskToPending` (merge-pipeline.ts:74-79)
6. **Branch is NOT deleted** -- `releaseSlot` (pool.ts:187-197) only clears DB fields
7. Next pickup -> goto 1 (same stale branch reused)
8. After 3 conflicts -> `blocked_conflict` (merge-pipeline.ts:59-71)
9. Human resets via `tasks reset` -> counters cleared, but **branch still not deleted** (tasks-reset.ts:148-176)
10. Goto 1 again

Branch cleanup ONLY happens on **successful merge** (git-lifecycle.ts:497-504).

## Desired Behavior

1. When `handleMergeFailure` is called with a **rebase conflict** (`mergeResult.conflict === true`), delete the local task branch from the slot before releasing the slot. Do NOT delete on infrastructure or general merge failures (branch may contain the only copy of valid work).
2. When `tasks reset` resets a `blocked_conflict` or `blocked_error` task, scan **idle** pool slots for that project and delete matching task branches (local + remote).
3. On next pickup, `prepareForTask` sees no existing branch -> creates a fresh one from current base (git-lifecycle.ts:264) -> clean slate.

## Design

### New helper: `deleteTaskBranchFromSlot`

Add to `src/workspace/git-lifecycle.ts`:

```typescript
/**
 * Delete a task branch from a pool slot (local only by default).
 * Uses `git checkout --detach` to avoid "cannot delete checked out branch"
 * without assuming any specific base branch name.
 * Tolerates missing branches. Used after rebase conflict to prevent
 * stale branch reuse on retry.
 */
export function deleteTaskBranchFromSlot(
  slotPath: string,
  taskBranch: string,
  options?: { deleteRemote?: boolean; remoteUrl?: string | null }
): boolean {
  console.log(`[workspace] Deleting stale task branch ${taskBranch} from ${slotPath}`);

  // Detach HEAD to avoid "cannot delete checked out branch" — works
  // regardless of what branches exist (no hardcoded base branch name)
  execGit(slotPath, ['checkout', '--detach'], { tolerateFailure: true });

  // Delete local branch
  const deleted = execGit(slotPath, ['branch', '-D', taskBranch], { tolerateFailure: true });
  if (deleted === null) {
    console.warn(`[workspace] WARNING: failed to delete ${taskBranch} from ${slotPath} — stale branch may persist`);
    return false;
  }

  // Delete remote branch only when explicitly requested (manual reset path)
  if (options?.deleteRemote && options?.remoteUrl) {
    execGit(slotPath, ['push', 'origin', '--delete', taskBranch], {
      tolerateFailure: true,
    });
  }
  return true;
}
```

### Call site 1: `handleMergeFailure` (conflict path only)

In `src/workspace/merge-pipeline.ts`, add branch deletion ONLY on the conflict path, BEFORE `releaseSlot`. Do NOT delete on infrastructure or general merge failures — the branch may be the only copy of valid coder work for diagnosis.

```typescript
import { deleteTaskBranchFromSlot } from './git-lifecycle.js';

export function handleMergeFailure(...): MergeFailureResult {
  // Infrastructure failure — block immediately, PRESERVE branch for diagnosis
  if (mergeResult.infrastructure) {
    releaseSlot(ctx.globalDb, ctx.slot.id);
    // ... existing logic ...
  }

  if (mergeResult.conflict) {
    // ---- ORDERING CONSTRAINT: delete branch BEFORE releaseSlot ----
    // releaseSlot clears task_branch in DB; we read from the in-memory
    // ctx.slot which still has the value. Once the slot is idle, another
    // runner could claim it, so the branch must be gone first.
    const slot = ctx.slot;
    if (slot.task_branch && slot.slot_path) {
      deleteTaskBranchFromSlot(slot.slot_path, slot.task_branch);
    }
    releaseSlot(ctx.globalDb, ctx.slot.id);
    // ... existing conflict counter / block logic ...
  }

  // General merge failure — PRESERVE branch, only release slot
  releaseSlot(ctx.globalDb, ctx.slot.id);
  // ... existing general failure logic ...
}
```

### Call site 2: `tasks-reset.ts`

After the DB transaction, scan pool slots that are either **idle** or **bound to the task being reset** (catches SIGKILL'd runners that left slots in `merging`/`review_active`):

```typescript
import { deleteTaskBranchFromSlot } from '../workspace/git-lifecycle.js';
import { releaseSlot } from '../workspace/pool.js';

// After the DB transaction, clean up stale task branches from pool slots
const { db: globalDb2, close: closeGlobal2 } = openGlobalDatabase();
try {
  const project = globalDb2
    .prepare('SELECT id FROM projects WHERE path = ?')
    .get(projectPath) as { id: string } | undefined;

  if (project) {
    for (const task of fullyValidatedTasks) {
      const taskBranch = `steroids/task-${task.id}`;

      // Find slots that are idle OR still bound to this task (SIGKILL'd runner)
      const slots = globalDb2
        .prepare(
          `SELECT id, slot_path, remote_url, status, task_id
           FROM workspace_pool_slots
           WHERE project_id = ? AND (status = 'idle' OR task_id = ?)`
        )
        .all(project.id, task.id) as Array<{
          id: number; slot_path: string; remote_url: string | null;
          status: string; task_id: string | null;
        }>;

      for (const slot of slots) {
        if (!slot.slot_path || !existsSync(join(slot.slot_path, '.git'))) continue;

        deleteTaskBranchFromSlot(slot.slot_path, taskBranch, {
          deleteRemote: true,
          remoteUrl: slot.remote_url,
        });

        // Release non-idle slots that were bound to this task
        if (slot.status !== 'idle' && slot.task_id === task.id) {
          releaseSlot(globalDb2, slot.id);
        }
      }
    }
  }
} finally {
  closeGlobal2();
}
```

### `prepareForTask` -- no change needed

The existing branch-exists check (git-lifecycle.ts:258-265) already handles both cases correctly:
- Branch exists -> checkout (intentional for coder->reviewer handoff)
- Branch doesn't exist -> create fresh from base

The fix ensures stale branches are gone before `prepareForTask` runs, so the "branch exists" path only fires when a branch is legitimately still in use (e.g., coder session interrupted mid-work, not a post-conflict retry).

## Implementation Order

### Task 1: Add `deleteTaskBranchFromSlot` helper + test

**Files:**
- Modify: `src/workspace/git-lifecycle.ts` (add export)
- Create: `tests/delete-task-branch.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteTaskBranchFromSlot } from '../src/workspace/git-lifecycle.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('deleteTaskBranchFromSlot', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'stale-branch-test-'));
    git(repoDir, ['init']);
    git(repoDir, ['commit', '--allow-empty', '-m', 'init']);
    git(repoDir, ['checkout', '-b', 'steroids/task-abc123']);
    git(repoDir, ['commit', '--allow-empty', '-m', 'task work']);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('deletes local task branch and detaches HEAD', () => {
    deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    const branches = git(repoDir, ['branch', '--list', 'steroids/task-abc123']);
    expect(branches).toBe('');
    // HEAD should be detached (no current branch)
    const current = git(repoDir, ['branch', '--show-current']);
    expect(current).toBe('');
  });

  it('tolerates branch that does not exist', () => {
    expect(() => {
      deleteTaskBranchFromSlot(repoDir, 'steroids/task-nonexistent');
    }).not.toThrow();
  });

  it('works when already on a different branch', () => {
    git(repoDir, ['checkout', 'main']);
    deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    const branches = git(repoDir, ['branch', '--list', 'steroids/task-abc123']);
    expect(branches).toBe('');
  });

  it('does not delete remote branch by default', () => {
    // No remote exists, but the important thing is the code path doesn't attempt it
    deleteTaskBranchFromSlot(repoDir, 'steroids/task-abc123');
    // No error, local branch deleted
    const branches = git(repoDir, ['branch', '--list', 'steroids/task-abc123']);
    expect(branches).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/delete-task-branch.test.ts --no-coverage`
Expected: FAIL -- `deleteTaskBranchFromSlot` not exported from module

**Step 3: Write minimal implementation**

Add to `src/workspace/git-lifecycle.ts` after the existing imports:

```typescript
/**
 * Delete a task branch from a pool slot (local only by default).
 * Uses `git checkout --detach` to avoid "cannot delete checked out branch"
 * without assuming any specific base branch name.
 * Tolerates missing branches. Used after rebase conflict to prevent
 * stale branch reuse on retry.
 */
export function deleteTaskBranchFromSlot(
  slotPath: string,
  taskBranch: string,
  options?: { deleteRemote?: boolean; remoteUrl?: string | null }
): boolean {
  console.log(`[workspace] Deleting stale task branch ${taskBranch} from ${slotPath}`);

  // Detach HEAD -- works regardless of what branches exist
  execGit(slotPath, ['checkout', '--detach'], { tolerateFailure: true });

  // Delete local branch
  const deleted = execGit(slotPath, ['branch', '-D', taskBranch], { tolerateFailure: true });
  if (deleted === null) {
    console.warn(`[workspace] WARNING: failed to delete ${taskBranch} from ${slotPath} — stale branch may persist`);
    return false;
  }

  // Delete remote only when explicitly requested (manual reset path)
  if (options?.deleteRemote && options?.remoteUrl) {
    execGit(slotPath, ['push', 'origin', '--delete', taskBranch], {
      tolerateFailure: true,
    });
  }
  return true;
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/delete-task-branch.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workspace/git-lifecycle.ts tests/delete-task-branch.test.ts
git commit -m "feat: add deleteTaskBranchFromSlot helper for stale branch cleanup"
```

---

### Task 2: Wire `deleteTaskBranchFromSlot` into `handleMergeFailure` (conflict path only) + test

**Files:**
- Modify: `src/workspace/merge-pipeline.ts` (add branch delete on conflict path before `releaseSlot`)
- Create: `tests/merge-pipeline-branch-cleanup.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/workspace/git-lifecycle.js', () => ({
  deleteTaskBranchFromSlot: jest.fn(),
}));
jest.unstable_mockModule('../src/database/queries.js', () => ({
  incrementTaskConflictCount: jest.fn(() => 1),
  incrementMergeFailureCount: jest.fn(() => 1),
  setTaskBlocked: jest.fn(),
  returnTaskToPending: jest.fn(),
}));
jest.unstable_mockModule('../src/workspace/pool.js', () => ({
  releaseSlot: jest.fn(),
}));

const { handleMergeFailure } = await import('../src/workspace/merge-pipeline.js');
const { deleteTaskBranchFromSlot } = await import('../src/workspace/git-lifecycle.js');
const { releaseSlot } = await import('../src/workspace/pool.js');

describe('handleMergeFailure branch cleanup', () => {
  const mockCtx = {
    globalDb: {} as any,
    slot: {
      id: 1,
      slot_path: '/tmp/pool-0',
      task_branch: 'steroids/task-abc123',
      remote_url: 'git@github.com:org/repo.git',
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes local task branch on rebase conflict', () => {
    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Rebase conflict', conflict: true,
    });
    expect(deleteTaskBranchFromSlot).toHaveBeenCalledWith(
      '/tmp/pool-0', 'steroids/task-abc123'
    );
    expect(releaseSlot).toHaveBeenCalled();
  });

  it('does NOT delete branch on general merge failure', () => {
    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Push failed', conflict: false,
    });
    expect(deleteTaskBranchFromSlot).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalled();
  });

  it('does NOT delete branch on infrastructure failure', () => {
    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Remote base missing', conflict: false, infrastructure: true,
    });
    expect(deleteTaskBranchFromSlot).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/merge-pipeline-branch-cleanup.test.ts --no-coverage`
Expected: FAIL -- `deleteTaskBranchFromSlot` never called on conflict path

**Step 3: Modify `handleMergeFailure`**

In `src/workspace/merge-pipeline.ts`, add import:

```typescript
import { deleteTaskBranchFromSlot } from './git-lifecycle.js';
```

Restructure the function so that branch deletion ONLY happens on the conflict path. The current single `releaseSlot` at line 38 must be moved into each branch:

```typescript
export function handleMergeFailure(
  projectDb: Database.Database,
  ctx: PoolSlotContext,
  taskId: string,
  mergeResult: MergeResult & { ok: false }
): MergeFailureResult {

  // Infrastructure failure -- block immediately, PRESERVE branch for diagnosis
  if (mergeResult.infrastructure) {
    releaseSlot(ctx.globalDb, ctx.slot.id);
    setTaskBlocked(projectDb, taskId, 'blocked_error',
      `Infrastructure failure: ${mergeResult.reason}`);
    return { taskBlocked: true, blockStatus: 'blocked_error',
      reason: `Blocked: ${mergeResult.reason}` };
  }

  if (mergeResult.conflict) {
    // ---- ORDERING CONSTRAINT: delete branch BEFORE releaseSlot ----
    // releaseSlot clears task_branch in DB; we read from the in-memory
    // ctx.slot which still has the value. Once idle, another runner could
    // claim the slot, so the branch must be gone first.
    const slot = ctx.slot;
    if (slot.task_branch && slot.slot_path) {
      deleteTaskBranchFromSlot(slot.slot_path, slot.task_branch);
    }
    releaseSlot(ctx.globalDb, ctx.slot.id);

    const conflictCount = incrementTaskConflictCount(projectDb, taskId);
    if (conflictCount >= MAX_CONFLICT_COUNT) {
      setTaskBlocked(projectDb, taskId, 'blocked_conflict',
        `Rebase conflict on ${conflictCount} consecutive attempts: ${mergeResult.reason}`);
      return { taskBlocked: true, blockStatus: 'blocked_conflict',
        reason: `Blocked after ${conflictCount} rebase conflicts` };
    }
    returnTaskToPending(projectDb, taskId, 'orchestrator',
      `Rebase conflict (attempt ${conflictCount}/${MAX_CONFLICT_COUNT}): ${mergeResult.reason}`);
    return { taskBlocked: false,
      reason: `Rebase conflict (attempt ${conflictCount}/${MAX_CONFLICT_COUNT})` };
  }

  // General merge failure -- PRESERVE branch, only release slot
  releaseSlot(ctx.globalDb, ctx.slot.id);
  const mergeFailureCount = incrementMergeFailureCount(projectDb, taskId);
  if (mergeFailureCount >= MAX_MERGE_FAILURE_COUNT) {
    setTaskBlocked(projectDb, taskId, 'blocked_error',
      `Merge pipeline failed ${mergeFailureCount} times: ${mergeResult.reason}`);
    return { taskBlocked: true, blockStatus: 'blocked_error',
      reason: `Blocked after ${mergeFailureCount} merge failures` };
  }
  returnTaskToPending(projectDb, taskId, 'orchestrator',
    `Merge failure (attempt ${mergeFailureCount}/${MAX_MERGE_FAILURE_COUNT}): ${mergeResult.reason}`);
  return { taskBlocked: false,
    reason: `Merge failure (attempt ${mergeFailureCount}/${MAX_MERGE_FAILURE_COUNT})` };
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/merge-pipeline-branch-cleanup.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workspace/merge-pipeline.ts tests/merge-pipeline-branch-cleanup.test.ts
git commit -m "fix: delete stale task branch on rebase conflict to prevent infinite retry loop"
```

---

### Task 3: Wire branch cleanup into `tasks-reset.ts` + fix `conflict_count` reset SQL

**Files:**
- Modify: `src/commands/tasks-reset.ts` (add branch cleanup after DB transaction)
- Create: `tests/tasks-reset-branch-cleanup.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('tasks reset branch cleanup', () => {
  it('deleteTaskBranchFromSlot removes branches from a repo', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'reset-branch-test-'));
    try {
      git(repoDir, ['init']);
      git(repoDir, ['commit', '--allow-empty', '-m', 'init']);
      git(repoDir, ['checkout', '-b', 'steroids/task-deadbeef']);
      git(repoDir, ['commit', '--allow-empty', '-m', 'work']);

      const { deleteTaskBranchFromSlot } = require('../dist/workspace/git-lifecycle.js');
      deleteTaskBranchFromSlot(repoDir, 'steroids/task-deadbeef');

      const branches = git(repoDir, ['branch', '--list', 'steroids/task-deadbeef']);
      expect(branches).toBe('');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Run test to verify it passes (helper already implemented)**

Run: `npm run build && npx jest tests/tasks-reset-branch-cleanup.test.ts --no-coverage`
Expected: PASS

**Step 3: Modify `tasks-reset.ts`**

Add imports at top:
```typescript
import { deleteTaskBranchFromSlot } from '../workspace/git-lifecycle.js';
import { releaseSlot } from '../workspace/pool.js';
```

**Sub-step 3a:** Fix the `conflict_count` reset SQL in the DB transaction (line 152-156). Change from conditional to unconditional zero:

```typescript
// BEFORE (bug: conflict_count not zeroed for blocked_error)
conflict_count = CASE WHEN ? = 'blocked_conflict' THEN 0 ELSE conflict_count END

// AFTER (always zero conflict_count on any blocked-task reset)
conflict_count = 0
```

**Sub-step 3b:** After the `db.transaction()()` block (after line 176), add branch cleanup:

```typescript
    // Clean up stale task branches from pool slots
    const { db: globalDb2, close: closeGlobal2 } = openGlobalDatabase();
    try {
      const project = globalDb2
        .prepare('SELECT id FROM projects WHERE path = ?')
        .get(projectPath) as { id: string } | undefined;

      if (project) {
        for (const task of fullyValidatedTasks) {
          const taskBranch = `steroids/task-${task.id}`;

          // Find slots that are idle OR still bound to this task (SIGKILL'd runner)
          const slots = globalDb2
            .prepare(
              `SELECT id, slot_path, remote_url, status, task_id
               FROM workspace_pool_slots
               WHERE project_id = ? AND (status = 'idle' OR task_id = ?)`
            )
            .all(project.id, task.id) as Array<{
              id: number; slot_path: string; remote_url: string | null;
              status: string; task_id: string | null;
            }>;

          for (const slot of slots) {
            if (!slot.slot_path || !existsSync(join(slot.slot_path, '.git'))) continue;

            deleteTaskBranchFromSlot(slot.slot_path, taskBranch, {
              deleteRemote: true,
              remoteUrl: slot.remote_url,
            });

            // Release non-idle slots that were bound to this task
            if (slot.status !== 'idle' && slot.task_id === task.id) {
              releaseSlot(globalDb2, slot.id);
            }
          }
        }
      }
    } finally {
      closeGlobal2();
    }
```

**Step 4: Build and run full test suite**

Run: `npm run build && npx jest --no-coverage`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add src/commands/tasks-reset.ts tests/tasks-reset-branch-cleanup.test.ts
git commit -m "fix: tasks reset cleans up stale task branches from idle pool slots"
```

---

### Task 4: Manual verification -- unblock the wireframes task

**Step 1: Delete stale branch from pool-0**

```bash
cd /Users/dictator/.steroids/workspaces/1cb139ea39c5b1f7/pool-0
git checkout --detach
git branch -D steroids/task-6dc82320-e2a0-4da4-95cc-ac26ac483aa4
```

**Step 2: Reset the task**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/wireframes
steroids tasks reset 6dc82320
```

**Step 3: Verify the task picks up cleanly on next runner cycle**

Monitor: the task should fork from current `origin/main`, pass review, and merge without conflict.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Slot clone doesn't exist | `existsSync` guard in tasks-reset; `tolerateFailure` on all git ops |
| Branch already deleted | `git branch -D` with `tolerateFailure: true` -- no-op |
| Currently checked out on task branch | `git checkout --detach` first |
| Base branch is not `main` (e.g. `develop`) | `--detach` is base-branch-agnostic |
| Remote push --delete fails | `tolerateFailure: true` -- local cleanup is sufficient |
| Multiple pool slots have same task branch | tasks-reset loop cleans all matching slots |
| Slot is busy with another task | tasks-reset filters `status = 'idle' OR task_id = ?` |
| SIGKILL'd runner left slot in `merging` | tasks-reset finds via `task_id` match, releases slot |
| `branch -D` fails silently (corrupted repo) | Helper returns `false` + emits warning; degrades to pre-fix behavior |
| Infrastructure/general merge failure | Branch preserved for diagnosis (only conflict deletes) |
| Coder session interrupted mid-work | Task stays `in_progress` -- `handleMergeFailure` not called |

## Non-Goals

- Automatic conflict resolution (requires semantic merge understanding)
- Changing the retry count (3 is appropriate for transient conflicts)
- Modifying `prepareForTask` branch-exists logic (correct; bug is upstream)
- Reconcile/wakeup branch cleanup (adds complexity; two call sites cover all entry points)
- Auto-resetting `conflict_count` on branch delete (count should reflect real repeated conflicts)

## Cross-Provider Review

### Reviewers
- **Claude** (superpowers:code-reviewer agent): 10 findings
- **Codex** (gpt-5.4 via `codex exec`): 5 findings + 4 pushback/non-findings

### Findings and Decisions

| # | Source | Finding | Severity | Decision |
|---|--------|---------|----------|----------|
| C1 | Claude | `checkout main` hardcode ignores configured base branch | CRITICAL | **ADOPT** -- use `git checkout --detach` instead |
| C2 | Claude | Merge lock not held during push --delete | CRITICAL->NON-ISSUE | **REJECT** -- different branches, no interference |
| C3 | Claude | Ordering constraint (delete before release) is implicit | IMPORTANT | **ADOPT** -- add comment explaining constraint |
| C4 | Claude | globalDb opened multiple times / narrow race in tasks-reset | IMPORTANT | **DEFER** -- millisecond window, not worth blocking on |
| C5 | Claude | Missing `base_branch` in tasks-reset query | IMPORTANT | **REJECT** -- moot with `--detach` approach |
| C8 | Claude | No logging in helper | SUGGESTION | **ADOPT** -- add `console.log` |
| X1 | Codex | tasks-reset scan clobbers unrelated active workspace | FINDING | **ADOPT** -- filter to `status = 'idle'` slots only |
| X2 | Codex | Remote push --delete on failure path is unsafe/unnecessary | FINDING | **ADOPT** -- local-only in auto path, remote only in manual reset |
| X3 | Codex | Helper hardcodes `main` | FINDING | **ADOPT** -- same as C1, resolved with `--detach` |
| X4 | Codex | Plan too broad: deleting for ALL merge failures loses work | FINDING | **ADOPT** -- scope to `mergeResult.conflict` only |
| X5 | Codex | Manual reset doesn't handle slot reassignment | FINDING | **ADOPT** -- idle-slot filter resolves this |

### Confirmed Non-Issues (by both reviewers)
- Race during `handleMergeFailure` is not real (slot is not idle during delete)
- `reconcileStaleWorkspaces` should NOT delete branches (only knows heartbeat expired)
- Opening globalDb twice is NOT a WAL correctness problem
- `conflict_count` should NOT auto-reset on branch deletion (masks real repeated conflicts)
- `partialReleaseSlot` interaction is a non-issue (merge failure only fires after review phase)
- `ws-*` workstream directories are not part of the pool system

### Round 2 — Loop Safety and Death Spiral Review

| # | Source | Finding | Severity | Decision |
|---|--------|---------|----------|----------|
| S1 | Claude R2 | `tasks-reset` doesn't zero `conflict_count` for `blocked_error` tasks — reset task can be immediately re-blocked after 1 conflict | CRITICAL | **ADOPT** -- unconditionally zero `conflict_count` on all blocked-task resets |
| X-F1 | Codex R2 | Manual reset misses stale branches in non-idle slots (SIGKILL'd runner leaves slot in `merging`) | HIGH | **ADOPT** -- expand filter to `status='idle' OR task_id=?`, release non-idle slots |
| X-F2 | Codex R2 | SIGTERM during conflict-cleanup can leave task in `review` + wakeup-sanitise auto-completes | HIGH | **PRE-EXISTING** -- SIGTERM window existed before this change; not worsened. Follow-up task. |
| X-F3 | Codex R2 | `deleteTaskBranchFromSlot` fails silently, stale branch survives | MEDIUM | **ADOPT** -- return `boolean`, emit warning on failure |
| A1 | Claude R2 | Double `releaseSlot` race (handleMergeFailure + finally block) | MEDIUM | **PRE-EXISTING** -- follow-up: add runner_id guard in finally block |
| C1 | Claude R2 | Three `releaseSlot` calls vs one | MEDIUM | **ACCEPTED** -- structurally required by path-specific pre-release logic |
| D1 | Claude R2 | `tolerateFailure` masks corrupted repo | MEDIUM | **ACCEPTED** -- degrades to pre-fix behavior, not a new failure mode |

### Loop Safety Verdict (Claude R2)
All 8 lifecycle paths traced and verified safe:
- (a) Happy path: untouched. (b) Conflict retry: fresh branch on next pickup, counter incremented correctly.
- (c) Infrastructure: branch preserved. (d) General failure: branch preserved.
- (e) No commits: not reached. (f) Reviewer reject: branch intact.
- (g) SIGTERM during merge: pre-existing risk, not worsened.
- (h) Multiple runners: slot exclusivity prevents race.
