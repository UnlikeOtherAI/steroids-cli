# Merge Queue: Task Branch Merge Pipeline

## Problem Statement

The current merge system has two broken paths that both fail for cross-filesystem setups:

1. **Pool mode (`mergeToBase`)**: Runs inside the reviewer phase — the reviewer both approves AND merges in one step. If the durability push in `cleanupPoolSlot` fails first, the task gets skipped before review ever runs. The push failure overwrites the task's review status with `pending`/`skipped`, killing tasks whose branches are already on the remote.

2. **Legacy workstream mode (`autoMergeOnCompletion`)**: Creates an integration workspace, then tries to fetch workstream branches (`steroids/ws-*`) from origin. But in pool mode, workstream branches are never pushed — only task branches are. Result: 0 commits applied, all workstreams skipped, work never reaches the target branch.

Both paths also merge directly to the target branch without a separate review gate, meaning a bad merge/rebase can land on main without anyone checking it.

## Current Behavior

### Pool mode (projects with a remote)
```
coder (pool slot) -> orchestrator -> reviewer (pool slot) -> mergeToBase -> push to main
                                                              ^-- reviewer and merge are coupled
```
- `cleanupPoolSlot` pushes task branch with `--force-with-lease` as a side effect of slot release
- If push fails, task status is overridden to `pending`/`skipped` regardless of coder success
- `mergeToBase` runs inside reviewer phase: rebase + ff-only merge + push main — all atomic
- `autoMergeOnCompletion` runs after loop ends, tries legacy workstream merge, always fails (branches missing)

### Legacy mode (local-only projects, no remote)
```
coder (workstream clone) -> push workstream branch -> reviewer -> autoMergeOnCompletion -> cherry-pick -> push main
```
- Workstream branches pushed to origin by coder decision phase
- Integration workspace created, cherry-picks workstream commits
- Only path that works for local-only projects (no remote URL)

## Desired Behavior

Decouple review from merge. Introduce a merge queue that handles rebases and conflicts independently from the coder/reviewer cycle.

### New pipeline
```
coder -> push task branch -> reviewer -> approve -> MERGE QUEUE -> target branch
                                 |                      |
                                 |                 [if conflict]
                                 |                      |
                                 |              rebase coder -> rebase review --+
                                 |                                              |
                                 +--- reject -----> back to coder               |
                                                                     [if approved, retry merge]
```

### Branch terminology

| Term | Branch name | Purpose |
|------|------------|---------|
| **Target branch** | `config.git.branch` (default: `main`) | Production branch with all approved code. Configured per-project (`git.branch` in `schema.ts`) or globally in `~/.steroids/config.json`. |
| **Task branch** | `steroids/task-<taskId>` | Per-task working branch on the remote. Pushed for durability after coder completes. Reviewer reads from it. Merge queue merges it into target. Deleted after successful merge. |
| **Remote** | `config.git.remote` (default: `origin`) | The remote used for all push/fetch operations. |

## Design: Sequential Pipeline

The merge queue replaces coupled reviewer-merge logic with a sequential pipeline of named steps. Each step has a clear contract: what it checks, what it returns, and what happens on failure. The main flow reads as a high-level narrative.

### Pipeline overview

```typescript
// merge-queue.ts — desired shape
async function processMergeQueue(db: Database, config: SteroidsConfig): Promise<void> {
  const task = selectMergePendingTask(db);
  if (!task) return;

  if (!acquireMergeLock(db, config)) return;  // another merge in progress

  try {
    const prepared = fetchAndPrepare(db, task, config);
    if (!prepared.ok) { handlePrepFailure(db, task, prepared); return; }

    const mergeResult = attemptFastForwardMerge(prepared.slot, task, config);
    if (mergeResult.merged) {
      pushTargetBranch(prepared.slot, config);
      cleanupTaskBranch(prepared.slot, task, config);
      markCompleted(db, task);
      return;
    }

    // ff-only failed — diverged from target
    transitionToRebasePending(db, task, mergeResult.reason);
  } finally {
    releaseMergeLock(db, config);
  }
}
```

Each function below is a named step with a documented contract.

---

### Phase 1: Push restructuring — `pushTaskBranchForDurability`

After the orchestrator decides the coder's work is ready for review:

```typescript
function pushTaskBranchForDurability(
  db: Database, task: Task, slotPath: string, config: SteroidsConfig
): { ok: boolean; error?: string }
// Contract:
//   - Pushes steroids/task-<taskId> to config.git.remote (retry with backoff, 3 attempts)
//   - Records the approved SHA at push time: task.approved_sha = HEAD of task branch
//   - Success: transitions task to 'review', returns { ok: true }
//   - Failure: transitions to 'blocked_error' with infrastructure error, returns { ok: false }
//   - NEVER transitions to 'pending' or 'skipped' on push failure
```

This replaces the current `cleanupPoolSlot` durability push. The push is a first-class pipeline step, not a side effect of cleanup. `cleanupPoolSlot` becomes slot release only — no push, no status overrides.

---

### Phase 2: Reviewer — `runReviewerPhase` (modified)

No changes to the reviewer itself. Reviewer fetches the task branch from the remote, reviews the code. Returns approve or reject.

```typescript
function transitionAfterReviewerApproval(
  db: Database, task: Task
): void
// Contract:
//   - Approve: task transitions to 'merge_pending' (NOT direct merge)
//   - Records task.approved_sha = current HEAD of steroids/task-<taskId>
//   - Reject: task returns to 'pending' (existing behavior)
```

The reviewer **never merges**. `mergeToBase` is removed from the reviewer phase.

**Implementation note:** Phases 2 and 3 must ship atomically. If `merge_pending` exists without a merge gate processor, approved tasks will strand.

---

### Phase 3: Merge gate — named steps

The merge gate operates on tasks in `merge_pending` status. Each step is a named function.

#### `selectMergePendingTask`

```typescript
function selectMergePendingTask(db: Database): Task | null
// Contract:
//   - Returns the oldest task with status 'merge_pending'
//   - Returns null if no tasks are waiting
//   - Task selector gains a new action type: 'merge'
```

#### `acquireMergeLock` / `releaseMergeLock`

```typescript
function acquireMergeLock(db: Database, config: SteroidsConfig): boolean
// Contract:
//   - One merge attempt at a time per project (keyed by project path)
//   - Lock scope: covers ONLY the ff-only attempt + target branch push (seconds, not minutes)
//   - Does NOT hold lock during rebase cycle (that would block all merges)
//   - Lock has heartbeat + timeout for crash recovery (reuse workspace_merge_locks pattern)
//   - Returns true if acquired, false if another merge is in progress
```

#### `fetchAndPrepare`

```typescript
function fetchAndPrepare(
  db: Database, task: Task, config: SteroidsConfig
): { ok: boolean; slot: PoolSlotContext; error?: string }
// Contract:
//   - Fetches latest target branch from remote
//   - Fetches task branch from remote
//   - Verifies task branch HEAD matches task.approved_sha (SHA tracking guard)
//   - If SHA mismatch: returns { ok: false } — task branch was modified after approval
//   - Prepares pool slot for merge operation
```

#### `attemptFastForwardMerge`

```typescript
function attemptFastForwardMerge(
  slot: PoolSlotContext, task: Task, config: SteroidsConfig
): { merged: boolean; reason?: string }
// Contract:
//   - Runs: git merge --ff-only steroids/task-<taskId> into target branch (in the pool slot)
//   - If succeeds: returns { merged: true }
//   - If fails (not fast-forwardable): returns { merged: false, reason: 'diverged' }
```

#### `pushTargetBranch`

```typescript
function pushTargetBranch(
  slot: PoolSlotContext, config: SteroidsConfig
): { ok: boolean; error?: string }
// Contract:
//   - Pushes target branch to remote with pushWithRetries
//   - This is the real race point — another merge could have pushed between our ff-only and our push
//   - If push fails due to non-ff rejection: the task needs re-merge (back to merge_pending)
//   - If push fails due to infrastructure: task -> blocked_error
```

#### `cleanupTaskBranch`

```typescript
function cleanupTaskBranch(
  slot: PoolSlotContext, task: Task, config: SteroidsConfig
): void
// Contract:
//   - Deletes steroids/task-<taskId> from local and remote
//   - Failure is non-fatal (branch cleanup is best-effort)
```

#### `markCompleted`

```typescript
function markCompleted(db: Database, task: Task): void
// Contract:
//   - Task status -> 'completed'
//   - Clears task branch reference
```

---

### Phase 4: Rebase cycle — named steps

When ff-only fails, the task branch has diverged from the target branch (other tasks merged while this one was in review).

#### `transitionToRebasePending`

```typescript
function transitionToRebasePending(
  db: Database, task: Task, reason: string
): void
// Contract:
//   - Task status -> 'rebase_pending'
//   - Records divergence reason for audit trail
//   - Does NOT increment rebase cycle count (only review rejections count)
```

#### `selectRebasePendingTask`

```typescript
function selectRebasePendingTask(db: Database): Task | null
// Contract:
//   - Returns the oldest task with status 'rebase_pending'
//   - Task selector gains a new action type: 'rebase'
```

#### `runRebaseCoder`

```typescript
function runRebaseCoder(
  db: Database, task: Task, config: SteroidsConfig
): { ok: boolean; error?: string }
// Contract:
//   - Spawns a rebase coder instance (LLM invocation with rebase-specific prompt)
//   - Checks out the task branch
//   - Runs: git rebase <remote>/<target_branch>
//   - Resolves any conflicts
//   - Ensures code still works after rebase (runs build/test if configured)
//   - Force-pushes the updated task branch (--force-with-lease)
//   - Success: task -> 'rebase_review'
//   - Failure: task -> 'blocked_error'
```

#### `runRebaseReview`

```typescript
function runRebaseReview(
  db: Database, task: Task, config: SteroidsConfig
): { decision: 'approve' | 'reject' }
// Contract:
//   - Runs existing reviewer on the rebased task branch
//   - Reviewer sees: original approved code + rebase changes, reviews only the delta
//   - Task selector gains a new action type: 'rebase_review'
//   - Approve: task -> 'merge_pending' (retry merge)
//   - Reject: increment rebase_review_rejection_count
```

#### `handleRebaseReviewRejection`

```typescript
function handleRebaseReviewRejection(
  db: Database, task: Task
): void
// Contract:
//   - Only REVIEW REJECTIONS count toward the 2-cycle cap (not ff-only race losses)
//   - If rebase_review_rejection_count < 2: task -> 'rebase_pending' (retry rebase)
//   - If rebase_review_rejection_count >= 2: task -> 'disputed' (human intervention)
```

#### Rebase cycle state machine

```
merge_pending -> [ff-only attempt] -> completed
                       |
                  [not ff-able]
                       |
                 rebase_pending -> rebase coder -> rebase_review -> [approve] -> merge_pending (retry)
                       ^                                    |
                       |                              [reject, count < 2]
                       +------------------------------------+
                                                            |
                                                      [reject, count >= 2]
                                                            |
                                                        disputed
```

---

### New task statuses

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `merge_pending` | Reviewer approved, waiting for merge queue | No |
| `rebase_pending` | Needs rebase before merge can succeed | No |
| `rebase_review` | Rebase complete, waiting for verification review | No |

### Status propagation table

Every hardcoded status set in the codebase must be updated to account for these new statuses:

| Call site | Current terminal set | Required change |
|-----------|---------------------|-----------------|
| `findNextTask` — pending work query | `completed, failed, skipped, disputed` | Add: `merge_pending, rebase_pending, rebase_review` as **non-terminal active** (not pending, not terminal) |
| `hasDependenciesMet` — blocking query | `completed` | No change — only `completed` unblocks dependents |
| `buildParallelRunPlan` — pending work count | `completed, failed, skipped, disputed` | Must match `findNextTask` |
| `selectNextTaskWithLock` — action routing | `pending -> start, in_progress -> resume, review -> review` | Add: `merge_pending -> merge, rebase_pending -> rebase, rebase_review -> rebase_review` |
| Section "done" checks | All tasks in `completed, failed, skipped, disputed` | Add `merge_pending, rebase_pending, rebase_review` to **NOT done** set |
| `orchestrator-loop` exit condition | No pending/active tasks | Must recognize merge/rebase statuses as active work |

### Task selector action types

The task selector returns an action type that the orchestrator uses to route dispatch:

| Status | Action | Handler |
|--------|--------|---------|
| `pending` | `start` | `runCoderPhase` |
| `in_progress` | `resume` | `runCoderPhase` |
| `review` | `review` | `runReviewerPhase` |
| `merge_pending` | `merge` | `processMergeQueue` |
| `rebase_pending` | `rebase` | `runRebaseCoder` |
| `rebase_review` | `rebase_review` | `runRebaseReview` |

### Merge lock

- One merge attempt at a time per project (keyed by project path)
- Lock acquired before ff-only attempt, released after push or on failure
- Lock covers only the fast-forward + push window (seconds) — does NOT hold during rebase cycles
- Tasks waiting for the lock stay in `merge_pending`/`rebase_pending` — the task selector picks them up when the lock is free
- Lock has a heartbeat + timeout for crash recovery (reuse existing `workspace_merge_locks` pattern)

### SHA tracking

To prevent merging a task branch that was modified after reviewer approval:

1. When reviewer approves: record `task.approved_sha = HEAD` of `steroids/task-<taskId>`
2. Before merge: `fetchAndPrepare` verifies `task branch HEAD === task.approved_sha`
3. After rebase: rebase coder updates `task.approved_sha` to new HEAD after force-push
4. If SHA mismatch detected: task returns to `review` status for re-review

This guards against external modifications to the task branch between approval and merge.

---

## What gets removed

| Component | Status |
|-----------|--------|
| `mergeToBase` in reviewer phase (`loop-phases-reviewer.ts:372`) | Remove — reviewer no longer merges |
| `cleanupPoolSlot` push logic (`orchestrator-loop.ts:48-73`) | Remove — push moves to coder-to-review transition |
| `autoMergeOnCompletion` (`daemon.ts:298-381`) | Remove — replaced by merge queue |
| `runParallelMerge` / integration workspace (`merge.ts`) | Remove — no more workstream-based merge |
| `createIntegrationWorkspace` (`clone.ts:449-499`) | Remove — no integration workspace needed |
| Workstream branch push in coder decision (`loop-phases-coder-decision.ts:230-246`) | Remove — task branches only |
| `merge-git.ts`, `merge-process.ts`, `merge-sealing.ts`, `merge-workspace.ts`, `merge-commit-checks.ts`, `merge-validation.ts`, `merge-progress.ts`, `merge-errors.ts`, `merge-lock.ts` (parallel merge module) | Remove or repurpose — the cherry-pick pipeline is replaced by ff-only + rebase |

## What stays

| Component | Why |
|-----------|-----|
| Pool slot lifecycle (`pool.ts`, `git-lifecycle.ts`) | Coder still works in pool slots |
| `pushWithRetries` (`git-helpers.ts`) | Still used for task branch and target branch pushes |
| `prepareForTask` (`git-lifecycle.ts`) | Still sets up pool slot for coder work |
| Task selector (`task-selector.ts`) | Extended to handle new statuses and action types |
| Reviewer phase (`loop-phases-reviewer.ts`) | Still reviews, just doesn't merge |
| Workspace merge lock pattern | Reused for merge queue serialization |

---

## Implementation Order

### Phase 1: Push restructuring
1. Move task branch push from `cleanupPoolSlot` to coder-to-review transition (`pushTaskBranchForDurability`)
2. `cleanupPoolSlot` becomes slot release only — no push, no status overrides
3. Push failure = `blocked_error` (infrastructure), not `pending`/`skipped`

### Phase 2+3: Decouple review + merge gate (atomic)
These ship together so `merge_pending` tasks always have a processor.

4. Add `merge_pending`, `rebase_pending`, `rebase_review` statuses to `TaskStatus` enum
5. Add `approved_sha` column to tasks table (migration)
6. Update status propagation: all call sites in the propagation table above
7. Reviewer approval transitions to `merge_pending` (records `approved_sha`) instead of calling `mergeToBase`
8. Remove `mergeToBase` call from reviewer phase
9. New merge gate module: `selectMergePendingTask` -> `acquireMergeLock` -> `fetchAndPrepare` (with SHA verification) -> `attemptFastForwardMerge` -> `pushTargetBranch` -> `cleanupTaskBranch` -> `markCompleted`
10. Merge lock per project (one merge at a time)
11. Failure path: `transitionToRebasePending`
12. Task selector extended with new action types (`merge`, `rebase`, `rebase_review`)

### Phase 4: Rebase cycle
13. `runRebaseCoder` — rebase-specific prompt (rebase onto target, resolve conflicts, verify build)
14. `runRebaseReview` — lighter review focused on conflict resolution quality
15. `handleRebaseReviewRejection` — cycle tracking: only review rejections count, max 2 before `disputed`
16. Rebase cycle state machine wired into task selector

### Phase 5: Cleanup
17. Remove `autoMergeOnCompletion` from daemon
18. Remove `runParallelMerge`, integration workspace, cherry-pick pipeline
19. Remove workstream branch push from coder decision phase
20. Remove dead code from merge modules

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Push succeeds but task branch already on remote (no-op coder) | `git push` returns "Everything up-to-date" — not an error, proceed to review |
| Two tasks approved simultaneously, both try merge | Merge lock serializes — first wins ff-only, second gets `rebase_pending` |
| Rebase coder introduces new bugs | Rebase review catches it, rejects, rebase review rejection count increments |
| Target branch force-pushed externally | ff-only will fail, rebase coder handles divergence, review verifies |
| Task branch deleted from remote while in review | Reviewer fetch fails — transition to `blocked_error`, not silent skip |
| Task branch modified after approval (SHA mismatch) | `fetchAndPrepare` detects mismatch, task returns to `review` for re-review |
| ff-only succeeds but target push fails (race) | Another merge pushed between ff-only and push. Task returns to `merge_pending` for retry. Does NOT count toward rebase cycle cap. |
| Multiple tasks hit rebase cap simultaneously | Each escalates to `disputed` independently |
| Local-only project (no remote) | No task branch push, no merge queue. Work stays local. Existing local behavior preserved — out of scope. |
| Rebase succeeds but ff-only still fails (concurrent merge) | Normal — another task merged between rebase and merge attempt. Re-enter rebase cycle. Does NOT count toward cycle cap (only review rejections count). |
| Crash during merge (lock held) | Lock heartbeat expires, next merge attempt acquires lock normally |

## Non-Goals

- PR-based merge flow (GitHub PRs) — future work
- Branch protection rules enforcement — relies on git server-side config
- Multi-remote support — single remote per project (`config.git.remote`)
- Changing the coder or reviewer prompt formats — only the merge/rebase pipeline changes
- Local-only project merge improvements — out of scope
- Drain mode (stop all runners for rebase) — deferred from v1; simple `disputed` escalation is sufficient. Can revisit if rebase failures cluster in practice.

## Cross-Provider Review

**Reviewers:** Claude (`superpowers:code-reviewer`) and Codex
**Date:** 2026-03-23

### Finding 1: Remove drain mode from v1 (Claude Critical, Codex Critical)
**Assessment:** Both reviewers flagged drain mode as over-engineered with deadlock risk. The "stop all runners, process rebase queue exclusively, resume" state machine adds significant complexity for a scenario (clustered rebase failures) that may not occur in practice.
**Decision:** ADOPT. Removed drain mode entirely. Tasks escalate to `disputed` after 2 failed rebase review cycles. Drain mode can be revisited as a future enhancement if rebase failures cluster.

### Finding 2: Add SHA tracking for approved commits (Claude Important, Codex Important)
**Assessment:** Without SHA tracking, a task branch could be modified between reviewer approval and merge gate processing. Both reviewers flagged this gap.
**Decision:** ADOPT. Added `approved_sha` column, recorded at approval time, verified in `fetchAndPrepare`, updated after rebase force-push.

### Finding 3: Fix merge gate race — push is the real race point (Claude Important)
**Assessment:** The original design treated ff-only as the serialization point. In reality, `git merge --ff-only` is local. The race is between the local merge succeeding and `git push` of the target branch — another merge could push between those two operations.
**Decision:** ADOPT. `pushTargetBranch` now handles non-ff push rejection by returning task to `merge_pending` for retry.

### Finding 4: Only count rebase REVIEW REJECTIONS toward cycle cap (Codex Important)
**Assessment:** The original design counted any rebase cycle toward the 2-cycle cap. But ff-only race losses (another task merged concurrently) are normal and shouldn't penalize the task.
**Decision:** ADOPT. Renamed counter to `rebase_review_rejection_count`. Only review rejections increment it. ff-only race losses and push failures do not.

### Finding 5: Add status propagation table (Claude Critical, Codex Important)
**Assessment:** New statuses must propagate through every hardcoded status set. Both reviewers flagged missing propagation analysis.
**Decision:** ADOPT. Added full propagation table mapping each call site to required changes.

### Finding 6: Merge lock scope — seconds, not entire rebase cycle (Claude Important)
**Assessment:** Holding the merge lock during the entire rebase cycle (which involves LLM invocations) would block all merges for minutes. The lock should only cover the fast-forward + push window.
**Decision:** ADOPT. Lock scope explicitly documented as ff-only + push only.

### Finding 7: Implement Phases 2+3 atomically (Codex Important)
**Assessment:** If `merge_pending` status exists but no merge gate processor handles it, approved tasks will strand indefinitely.
**Decision:** ADOPT. Phases 2 and 3 merged into a single atomic implementation step.

### Finding 8: Specify task selector action types (Claude Suggestion, Codex Suggestion)
**Assessment:** The task selector currently returns `start`, `resume`, `review`. New statuses need new action types so the orchestrator knows which handler to invoke.
**Decision:** ADOPT. Added action type table: `merge_pending -> merge`, `rebase_pending -> rebase`, `rebase_review -> rebase_review`.

### Finding 9: Migration plan for in-flight tasks (Codex Suggestion)
**Assessment:** Tasks currently in `review` status that have already been approved but not yet merged (via the old `mergeToBase` path) need handling during the migration.
**Decision:** ADOPT. Migration will: (a) add new columns (`approved_sha`, `rebase_review_rejection_count`), (b) tasks already in terminal states are unaffected, (c) tasks in `review` continue through the old path until the reviewer phase change deploys — the atomic Phase 2+3 deployment handles this naturally.
