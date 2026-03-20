# Pool Commit Durability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent approved tasks from losing commits when the reviewer claims a different pool slot than the coder used.

**Architecture:** Push the task branch to the remote after coder submission (before partial release) so commits are available via fetch from any slot. Add pool slot paths to the commit recovery fetch sources as defense in depth. Add a wakeup cleanup step that purges stale remote `steroids/task-*` branches after verifying their commits are merged.

**Tech Stack:** TypeScript, better-sqlite3, git CLI (via `execGit`/`execFileSync` — never `exec()`)

---

## Root Cause Summary

In pool mode, coder commits exist **only** in the pool slot's local `.git` — never pushed to remote. `partialReleaseSlot` sets status to `idle`, making the slot claimable by any concurrent runner. If another runner claims the slot for a different task (overwriting `task_id`), the reviewer gets a different slot that lacks the coder's commits, resulting in `all_submissions_unreachable`.

The commit recovery in `submission-resolution.ts` only queries `workstreams` (not `workspace_pool_slots`), so it can't find commits in other pool slots either.

**Full analysis:** See the root cause investigation in the conversation that produced this plan.

---

### Task 1: Push task branch to remote on partial release

**Files:**
- Modify: `src/runners/orchestrator-loop.ts:540-553` (finally block)

This is the primary fix. Before calling `partialReleaseSlot`, push the task branch to the remote so the commits are accessible from any slot via `git fetch`.

**Step 1: Write the push logic**

In `orchestrator-loop.ts`, add import for `pushWithRetries`:
```typescript
import { pushWithRetries } from '../workspace/git-helpers.js';
```

Modify the `awaiting_review` branch in the finally block (line 546-547):

```typescript
if (currentSlot?.status === 'awaiting_review') {
  // Push task branch to remote for commit durability.
  // Without this push, coder commits exist only in this pool slot's
  // local git repo. If a concurrent runner claims this slot for a
  // different task before the reviewer reclaims it, the reviewer gets
  // a different slot that lacks the commits.
  if (currentSlot.task_branch && currentSlot.remote_url) {
    try {
      pushWithRetries(
        currentSlot.slot_path, 'origin', currentSlot.task_branch,
        2, [2000, 8000], true // force-with-lease, 2 retries
      );
    } catch {
      // Best-effort — commit recovery handles push failures
    }
  }
  partialReleaseSlot(poolSlotCtx.globalDb, poolSlotCtx.slot.id);
}
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/runners/orchestrator-loop.ts
git commit -m "fix: push task branch to remote after coder submission for commit durability"
```

---

### Task 2: Add pool slot paths to recovery fetch sources

**Files:**
- Modify: `src/git/submission-resolution.ts:49-87` (add pool slot source function)

Currently `getParallelWorkstreamSources` only queries the `workstreams` table. Add pool slot paths from `workspace_pool_slots` so the recovery can fetch commits from sibling pool slots.

**Step 1: Write the failing test**

Create: `tests/submission-resolution-pool-recovery.test.ts`

```typescript
import { getPoolSlotSources } from '../src/git/submission-resolution.js';

// This test verifies pool slot paths are included in recovery sources.
// Full integration test would require DB + git repos; unit test verifies
// the query shape and filtering.
describe('getPoolSlotSources', () => {
  it('should be exported and callable', () => {
    expect(typeof getPoolSlotSources).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/submission-resolution-pool-recovery.test.ts -v`
Expected: FAIL — `getPoolSlotSources` not exported

**Step 3: Implement pool slot source lookup**

In `submission-resolution.ts`, add after `getParallelWorkstreamSources`:

```typescript
export function getPoolSlotSources(projectPath: string): WorkstreamSource[] {
  const normalizedProjectPath = getProjectRepoId(projectPath);
  const sources: WorkstreamSource[] = [];

  try {
    const globalDb = openGlobalDatabase();
    try {
      const { getProjectHash } = require('../parallel/clone.js');
      const projectId = getProjectHash(normalizedProjectPath);

      const rows = globalDb.db
        .prepare(
          `SELECT slot_path, task_branch
           FROM workspace_pool_slots
           WHERE project_id = ?
             AND slot_path IS NOT NULL
             AND task_branch IS NOT NULL`
        )
        .all(projectId) as Array<{ slot_path: string; task_branch: string }>;

      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.slot_path || !row.task_branch) continue;
        if (!existsSync(row.slot_path)) continue;
        const resolvedSlotPath = resolve(row.slot_path);
        if (resolvedSlotPath === normalizedProjectPath) continue;

        const key = `${row.slot_path}::${row.task_branch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({ clonePath: row.slot_path, branchName: row.task_branch });
      }
    } finally {
      globalDb.close();
    }
  } catch {
    // Pool slot lookup failure must not block resolution
  }

  return sources;
}
```

Update `resolveSubmissionCommitHistoryWithRecovery` — after the `getParallelWorkstreamSources` block (around line 231), before the workstream fetch loop:

```typescript
// Also include pool slot paths — the coder may have worked in a
// different slot than the one the reviewer is currently using.
try {
  const poolSources = getPoolSlotSources(projectPath);
  for (const ps of poolSources) {
    if (!sources.some(s => s.clonePath === ps.clonePath && s.branchName === ps.branchName)) {
      sources.push(ps);
    }
  }
} catch {
  // Pool slot source lookup failure is non-fatal
}
```

Note: `openGlobalDatabase` is already imported at line 7.

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/submission-resolution-pool-recovery.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/submission-resolution.ts tests/submission-resolution-pool-recovery.test.ts
git commit -m "fix: add pool slot paths to commit recovery fetch sources"
```

---

### Task 3: Stale remote task branch cleanup after merge

**Files:**
- Create: `src/workspace/remote-branch-cleanup.ts`
- Modify: `src/runners/wakeup-global-cleanup.ts` (call the cleanup)

After we start pushing task branches early, stale branches will accumulate on the remote for tasks that fail, are abandoned, or whose merge cleanup was interrupted. Add a wakeup step that purges them after verifying the commits are on the base branch.

**Step 1: Write the failing test**

Create: `tests/remote-branch-cleanup.test.ts`

```typescript
import { identifyStaleBranches } from '../src/workspace/remote-branch-cleanup.js';

describe('identifyStaleBranches', () => {
  it('should be exported and callable', () => {
    expect(typeof identifyStaleBranches).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/remote-branch-cleanup.test.ts -v`
Expected: FAIL

**Step 3: Implement remote branch cleanup**

Create `src/workspace/remote-branch-cleanup.ts`:

```typescript
/**
 * Purge stale steroids/task-* branches from the remote.
 *
 * Called during wakeup maintenance. For each remote task branch:
 * 1. Extract the task ID from the branch name
 * 2. Check if the task is terminal (completed, failed, skipped, disputed)
 * 3. For completed tasks: verify the branch tip is an ancestor of the
 *    remote base branch before deleting (the commits must have made it)
 * 4. For non-completed terminal tasks: delete unconditionally (abandoned work)
 * 5. For non-terminal tasks: leave alone (still active)
 */

import { existsSync } from 'node:fs';
import { openDatabase } from '../database/connection.js';
import { getTask } from '../database/queries.js';
import { execGit, isAncestor } from './git-helpers.js';
import type { WakeupLogger } from '../runners/wakeup-types.js';

const TASK_BRANCH_PREFIX = 'steroids/task-';

interface CleanupResult {
  deleted: number;
  skippedActive: number;
  skippedUnverified: number;
}

/**
 * List remote branches matching the steroids/task-* pattern.
 */
function listRemoteTaskBranches(slotPath: string): string[] {
  const output = execGit(slotPath, [
    'ls-remote', '--heads', 'origin', `refs/heads/${TASK_BRANCH_PREFIX}*`,
  ], { tolerateFailure: true, timeoutMs: 30_000 });

  if (!output) return [];

  return output
    .split('\n')
    .map(line => line.replace(/^[0-9a-f]+\s+refs\/heads\//, '').trim())
    .filter(name => name.startsWith(TASK_BRANCH_PREFIX));
}

/**
 * Extract task ID from a steroids/task-<uuid> branch name.
 */
function extractTaskId(branchName: string): string | null {
  if (!branchName.startsWith(TASK_BRANCH_PREFIX)) return null;
  const id = branchName.slice(TASK_BRANCH_PREFIX.length);
  return id.length > 0 ? id : null;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'skipped', 'disputed'];

/**
 * Identify stale remote task branches that can be safely deleted.
 */
export function identifyStaleBranches(
  slotPath: string,
  projectPath: string,
  baseBranch: string
): { toDelete: string[]; result: CleanupResult } {
  const remoteBranches = listRemoteTaskBranches(slotPath);
  const toDelete: string[] = [];
  const result: CleanupResult = { deleted: 0, skippedActive: 0, skippedUnverified: 0 };

  if (remoteBranches.length === 0) return { toDelete, result };

  let projectDb: ReturnType<typeof openDatabase> | null = null;
  try {
    projectDb = openDatabase(projectPath);
  } catch {
    return { toDelete, result };
  }

  try {
    for (const branch of remoteBranches) {
      const taskId = extractTaskId(branch);
      if (!taskId) continue;

      const task = getTask(projectDb.db, taskId);

      // Task not found in DB — stale branch from deleted/unknown task
      if (!task) {
        toDelete.push(branch);
        continue;
      }

      // Task still active — do not touch
      if (!TERMINAL_STATUSES.includes(task.status)) {
        result.skippedActive++;
        continue;
      }

      // Completed task: verify commits made it to base before deleting
      if (task.status === 'completed') {
        // Fetch to ensure we have latest remote state
        execGit(slotPath, ['fetch', 'origin', branch, baseBranch], {
          tolerateFailure: true,
          timeoutMs: 30_000,
        });

        const branchTip = execGit(slotPath, ['rev-parse', `origin/${branch}`], {
          tolerateFailure: true,
        });

        if (!branchTip) {
          result.skippedUnverified++;
          continue;
        }

        const merged = isAncestor(slotPath, branchTip, `origin/${baseBranch}`);
        if (!merged) {
          result.skippedUnverified++;
          continue;
        }
      }

      // Terminal + verified (or non-completed terminal) — safe to delete
      toDelete.push(branch);
    }
  } finally {
    projectDb?.close();
  }

  return { toDelete, result };
}

/**
 * Delete remote task branches and return count deleted.
 */
export function deleteRemoteTaskBranches(
  slotPath: string,
  branches: string[]
): number {
  let deleted = 0;
  for (const branch of branches) {
    const result = execGit(slotPath, ['push', 'origin', '--delete', branch], {
      tolerateFailure: true,
      timeoutMs: 30_000,
    });
    if (result !== null) deleted++;
  }
  return deleted;
}

/**
 * Full cleanup: identify + delete stale remote task branches for one project.
 */
export function cleanStaleRemoteTaskBranches(
  slotPath: string,
  projectPath: string,
  baseBranch: string,
  dryRun: boolean,
  log: WakeupLogger
): number {
  const { toDelete, result } = identifyStaleBranches(slotPath, projectPath, baseBranch);

  if (toDelete.length === 0) return 0;

  if (dryRun) {
    log(`Would delete ${toDelete.length} stale remote task branch(es)`);
    return toDelete.length;
  }

  const deleted = deleteRemoteTaskBranches(slotPath, toDelete);
  if (deleted > 0) {
    log(`Deleted ${deleted} stale remote task branch(es) (${result.skippedActive} active, ${result.skippedUnverified} unverified)`);
  }
  return deleted;
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/remote-branch-cleanup.test.ts -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workspace/remote-branch-cleanup.ts tests/remote-branch-cleanup.test.ts
git commit -m "feat: add stale remote task branch cleanup with merge verification"
```

---

### Task 4: Wire cleanup into wakeup maintenance

**Files:**
- Modify: `src/runners/wakeup-global-cleanup.ts` (add call after pruneCompletedWorkspaces)

**Step 1: Add the cleanup call**

In `performWakeupGlobalMaintenance`, after `pruneCompletedWorkspaces`:

```typescript
await cleanupRemoteTaskBranches(globalDb, dryRun, log);
```

Add the async helper above `performWakeupGlobalMaintenance`:

```typescript
async function cleanupRemoteTaskBranches(
  globalDb: any,
  dryRun: boolean,
  log: WakeupLogger
): Promise<void> {
  try {
    const { getRegisteredProjects } = await import('./projects.js');
    const { getProjectHash } = await import('../parallel/clone.js');
    const { cleanStaleRemoteTaskBranches } = await import('../workspace/remote-branch-cleanup.js');
    const { loadConfig } = await import('../config/loader.js');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const projects = getRegisteredProjects(false);
    for (const project of projects) {
      const projectId = getProjectHash(project.path);

      // Find an idle slot with a valid clone to use for git operations
      const slot = globalDb.prepare(
        `SELECT slot_path, remote_url FROM workspace_pool_slots
         WHERE project_id = ? AND status = 'idle' AND slot_path IS NOT NULL
         ORDER BY slot_index ASC LIMIT 1`
      ).get(projectId) as { slot_path: string; remote_url: string | null } | undefined;

      if (!slot?.slot_path || !slot.remote_url) continue;
      if (!existsSync(join(slot.slot_path, '.git'))) continue;

      const config = loadConfig(project.path);
      const baseBranch = config.git?.branch ?? 'main';

      cleanStaleRemoteTaskBranches(slot.slot_path, project.path, baseBranch, dryRun, log);
    }
  } catch {
    // Remote branch cleanup errors must not block other wakeup steps
  }
}
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/runners/wakeup-global-cleanup.ts
git commit -m "feat: wire stale remote task branch cleanup into wakeup maintenance"
```

---

### Task 5: Integration test for push-on-partial-release

**Files:**
- Create: `tests/pool-commit-durability.test.ts`

Verifies the critical invariant: after coder submission, the task branch exists on the remote and is fetchable from a different clone.

**Step 1: Write the test**

```typescript
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pushWithRetries } from '../src/workspace/git-helpers.js';

describe('pool commit durability: push on partial release', () => {
  let bareRepo: string;
  let slotClone: string;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pool-durability-'));
    bareRepo = join(base, 'remote.git');
    slotClone = join(base, 'slot');

    execFileSync('git', ['init', '--bare', bareRepo]);
    execFileSync('git', ['clone', bareRepo, slotClone]);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: slotClone });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: slotClone });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('pushes task branch to remote with force-with-lease', () => {
    const taskBranch = 'steroids/task-test-123';
    execFileSync('git', ['checkout', '-B', taskBranch], { cwd: slotClone });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'task work'], { cwd: slotClone });

    const result = pushWithRetries(slotClone, 'origin', taskBranch, 2, [100, 200], true);
    expect(result.success).toBe(true);

    const remoteRefs = execFileSync('git', ['ls-remote', '--heads', bareRepo], { encoding: 'utf-8' });
    expect(remoteRefs).toContain(`refs/heads/${taskBranch}`);
  });

  it('task branch commits are fetchable from a second clone', () => {
    const taskBranch = 'steroids/task-test-456';
    execFileSync('git', ['checkout', '-B', taskBranch], { cwd: slotClone });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'task work 2'], { cwd: slotClone });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: slotClone, encoding: 'utf-8' }).trim();

    pushWithRetries(slotClone, 'origin', taskBranch, 1, [100], true);

    const slot2 = join(base, 'slot2');
    execFileSync('git', ['clone', bareRepo, slot2]);
    execFileSync('git', ['fetch', 'origin', taskBranch], { cwd: slot2 });

    const type = execFileSync('git', ['cat-file', '-t', sha], { cwd: slot2, encoding: 'utf-8' }).trim();
    expect(type).toBe('commit');
  });
});
```

**Step 2: Run test**

Run: `npm run build && npx jest tests/pool-commit-durability.test.ts -v`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/pool-commit-durability.test.ts
git commit -m "test: integration test for pool commit durability push"
```

---

### Task 6: Integration test for stale remote branch cleanup

**Files:**
- Modify: `tests/remote-branch-cleanup.test.ts` (expand with integration tests)

**Step 1: Write the integration test**

```typescript
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identifyStaleBranches, deleteRemoteTaskBranches } from '../src/workspace/remote-branch-cleanup.js';

describe('stale remote branch cleanup', () => {
  let bareRepo: string;
  let slotClone: string;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'branch-cleanup-'));
    bareRepo = join(base, 'remote.git');
    slotClone = join(base, 'slot');

    execFileSync('git', ['init', '--bare', bareRepo]);
    execFileSync('git', ['clone', bareRepo, slotClone]);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: slotClone });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: slotClone });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('identifies remote steroids/task-* branches with unknown task IDs as stale', () => {
    execFileSync('git', ['checkout', '-B', 'steroids/task-abc123'], { cwd: slotClone });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: slotClone });
    execFileSync('git', ['push', 'origin', 'steroids/task-abc123'], { cwd: slotClone });
    execFileSync('git', ['checkout', 'main'], { cwd: slotClone });

    // Task not in DB (nonexistent path) -> should be in toDelete
    const { toDelete } = identifyStaleBranches(slotClone, '/nonexistent', 'main');
    expect(toDelete).toContain('steroids/task-abc123');
  });

  it('deletes remote branches and verifies they are gone', () => {
    execFileSync('git', ['checkout', '-B', 'steroids/task-del1'], { cwd: slotClone });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: slotClone });
    execFileSync('git', ['push', 'origin', 'steroids/task-del1'], { cwd: slotClone });
    execFileSync('git', ['checkout', 'main'], { cwd: slotClone });

    const deleted = deleteRemoteTaskBranches(slotClone, ['steroids/task-del1']);
    expect(deleted).toBe(1);

    const refs = execFileSync('git', ['ls-remote', '--heads', bareRepo], { encoding: 'utf-8' });
    expect(refs).not.toContain('steroids/task-del1');
  });
});
```

**Step 2: Run test**

Run: `npm run build && npx jest tests/remote-branch-cleanup.test.ts -v`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/remote-branch-cleanup.test.ts
git commit -m "test: integration tests for stale remote branch cleanup"
```

---

### Task 7: Final build + full test suite

**Step 1: Build**

Run: `npm run build`
Expected: Clean compile, no TS errors

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass (819+ existing + new tests)

**Step 3: Final commit if any remaining changes**

---

## Edge Cases Table

| Scenario | Handling |
|----------|----------|
| Push fails (network/auth) | Best-effort catch; existing `commit_recovery` provides fallback |
| Local-only project (no remote) | Pool mode requires remote (`orchestrator-loop.ts:451`); N/A |
| Task branch already on remote | `--force-with-lease` is idempotent |
| `mergeToBase` later pushes same branch | Uses `--force-with-lease`; compatible |
| Completed task but commits not on base | `identifyStaleBranches` skips (skippedUnverified) — won't delete |
| Task not in project DB | Treated as stale, deleted (orphan from deleted project data) |
| Multiple slots have task_branch set | `getPoolSlotSources` returns all; recovery tries each |
| Wakeup runs during active coder/reviewer | Cleanup only uses idle slots; active slots untouched |
| Rebase conflict deletes local branch | Remote branch survives; cleanup purges after task reaches terminal status |

## Non-Goals

- Hard slot reservation (too complex, changes pool semantics)
- Eliminating soft affinity (still useful as performance optimization)
- Reviewer missing-directory resilience (separate issue)
