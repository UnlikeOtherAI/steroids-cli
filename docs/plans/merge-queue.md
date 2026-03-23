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
                                 |                 [if diverged]
                                 |                      |
                                 |              deterministic rebase (no LLM)
                                 |                      |
                                 |               [if conflicts]
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

    const mergeResult = attemptRebaseAndFastForward(prepared.slot, task, config);
    if (mergeResult.merged) {
      const pushResult = pushTargetBranch(prepared.slot, config);
      if (!pushResult.ok) { handlePushFailure(db, task, pushResult); return; }
      cleanupTaskBranch(prepared.slot, task, config);
      markCompleted(db, task);
      return;
    }

    if (mergeResult.reason === 'conflicts') {
      // Deterministic rebase failed with conflicts — needs LLM
      transitionToRebasePending(db, task, mergeResult.reason);
      return;
    }

    // Should not reach here — all merge outcomes handled above
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
//   - Does NOT record approved_sha — that is the reviewer's responsibility
//   - Success: transitions task to 'review', returns { ok: true }
//   - Failure: transitions to 'blocked_error' with infrastructure error, returns { ok: false }
//   - NEVER transitions to 'pending' or 'skipped' on push failure
```

**Insertion point:** Called from within `submitForReviewWithDurableRef` (in `loop-phases-coder-decision.ts`), BEFORE the status transitions to `review`. If push fails, the task stays in its current status and transitions to `blocked_error` — it never enters `review` without a durable push.

This replaces the current `cleanupPoolSlot` durability push. The push is a first-class pipeline step, not a side effect of cleanup. `cleanupPoolSlot` becomes slot release only — no push, no status overrides.

---

### Phase 2: Reviewer — `runReviewerPhase` (modified)

No changes to the reviewer itself. Reviewer fetches the task branch from the remote, reviews the code. Returns approve or reject.

```typescript
function transitionAfterReviewerApproval(
  db: Database, task: Task, slotPath: string, config: SteroidsConfig
): void
// Contract:
//   - Approve: task transitions to 'merge_pending' (NOT direct merge)
//   - SOLE authority for setting approved_sha: fetches current HEAD of remote
//     steroids/task-<taskId> and records it as task.approved_sha
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
//   - Lock scope: covers ONLY the rebase + ff-only + target branch push (seconds, not minutes)
//   - Does NOT hold lock during LLM rebase cycle
//   - Uses the existing epoch-based locking pattern (workspace_merge_locks + epoch column)
//     to handle crash recovery — a new contender invalidates the stale holder's epoch
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

#### `attemptRebaseAndFastForward`

```typescript
function attemptRebaseAndFastForward(
  slot: PoolSlotContext, task: Task, config: SteroidsConfig
): { merged: boolean; reason?: 'conflicts' }
// Contract:
//   - First: attempts git merge --ff-only (cheapest path)
//   - If ff-only succeeds: returns { merged: true }
//   - If ff-only fails (diverged): attempts deterministic git rebase (no LLM)
//   - If rebase succeeds (no conflicts): runs ff-only again, returns { merged: true }
//   - If rebase fails (conflicts): aborts rebase, returns { merged: false, reason: 'conflicts' }
//
// This preserves the current mergeToBase performance characteristic: most merges
// after concurrent work are simple rebases with no conflicts, handled in milliseconds
// without LLM involvement. Only true conflicts escalate to the rebase coder.
```

#### `pushTargetBranch`

```typescript
function pushTargetBranch(
  slot: PoolSlotContext, config: SteroidsConfig
): { ok: boolean; error?: string; raceLoss?: boolean }
// Contract:
//   - Pushes target branch to remote with pushWithRetries
//   - This is the real race point — another merge could have pushed between our ff-only and our push
//   - If push fails due to non-ff rejection: returns { ok: false, raceLoss: true }
//     -> task returns to merge_pending for retry, does NOT count toward any cap
//   - If push fails due to infrastructure: returns { ok: false }
//     -> task -> blocked_error
```

#### `cleanupTaskBranch`

```typescript
function cleanupTaskBranch(
  slot: PoolSlotContext, task: Task, config: SteroidsConfig
): void
// Contract:
//   - Deletes steroids/task-<taskId> from local and remote
//   - Failure is non-fatal (branch cleanup is best-effort)
//   - Orphan branches are caught by existing `steroids gc` and wakeup cleanup
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

When deterministic rebase fails with conflicts, the task needs LLM-powered conflict resolution.

#### `transitionToRebasePending`

```typescript
function transitionToRebasePending(
  db: Database, task: Task, reason: string
): void
// Contract:
//   - Task status -> 'rebase_pending'
//   - Increments total_rebase_cycles counter
//   - If total_rebase_cycles >= maxTotalRebaseCycles (default 10): task -> 'disputed'
//   - Records divergence reason for audit trail
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
//   - Success: task -> 'rebase_review', updates task.approved_sha to new HEAD
//   - Failure (LLM cannot resolve conflicts): task -> 'disputed' (not blocked_error)
//   - Failure (infrastructure — git/network): task -> 'blocked_error'
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
//   - Approve: re-records task.approved_sha = current remote HEAD, task -> 'merge_pending'
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
merge_pending -> [ff-only] -> [deterministic rebase] -> [ff-only] -> completed
                                      |
                                 [conflicts]
                                      |
                rebase_pending -> rebase coder -> rebase_review -> [approve] -> merge_pending (retry)
                      ^                |                   |
                      |           [LLM fail]         [reject, count < 2]
                      |                |                   |
                      |            disputed                |
                      +------------------------------------+
                                                           |
                                                     [reject, count >= 2]
                                                           |
                                                       disputed
```

**Caps:** Two independent caps prevent unbounded cycles:
- `rebase_review_rejection_count` (default 2): LLM-produced rebases that fail review. Escalates to `disputed`.
- `total_rebase_cycles` (default 10): Total times through the rebase loop (including race losses). Prevents unbounded LLM spend in high-contention scenarios.

---

### New task statuses

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `merge_pending` | Reviewer approved, waiting for merge queue | No |
| `rebase_pending` | Needs rebase before merge can succeed | No |
| `rebase_review` | Rebase complete, waiting for verification review | No |

### Status propagation table

Every hardcoded status set in the codebase must be updated. The implementation should introduce a shared `MERGE_PIPELINE_ACTIVE_STATUSES` constant (`['merge_pending', 'rebase_pending', 'rebase_review']`) used by all sites below, rather than adding three items to each independent list.

| Call site | File | Current set | Required change |
|-----------|------|-------------|-----------------|
| `hasPendingOrInProgressWork` | `task-selector.ts:62` | `IN ('pending', 'in_progress', 'review')` | Add `merge_pending, rebase_pending, rebase_review` — without this, runner loop exits with "ALL TASKS COMPLETE" while tasks sit in merge pipeline |
| `selectNextTaskWithWait` exit | `task-selector.ts:504` | `pending === 0 && in_progress === 0 && review === 0` | Include merge pipeline statuses in active count |
| `selectTaskBatch` active count | `task-selector.ts:160` | `IN ('in_progress', 'review')` | Add merge pipeline statuses to prevent duplicate dispatch |
| `findNextTask` pending work | `queries.ts` | `NOT IN (completed, failed, skipped, disputed)` | Add merge pipeline statuses as non-terminal active |
| `hasDependenciesMet` | `queries.ts` | `completed` only | No change — only `completed` unblocks dependents |
| `buildParallelRunPlan` | `runners-parallel.ts:125` | `NOT IN (completed, disputed, skipped, failed, partial, blocked_error, blocked_conflict)` | Uses exclusion — new statuses correctly included. Must use shared constant. |
| `selectNextTaskWithLock` routing | `task-selector.ts` | `pending->start, in_progress->resume, review->review` | Add: `merge_pending->merge, rebase_pending->rebase, rebase_review->rebase_review` |
| `getTaskCounts` | `task-selector.ts:246` | Counts `pending, in_progress, review, completed, disputed, failed` | Add buckets for merge pipeline statuses |
| `wakeup-checks.ts` pending work | `wakeup-checks.ts:57` | `IN ('pending', 'in_progress', 'review')` | Add merge pipeline statuses — without this, wakeup won't spawn runners for merge/rebase work |
| `getSectionCounts` | `section-pr.ts:37` | `IN ('pending','in_progress','review','partial')` | Add merge pipeline statuses — without this, PRs created before code reaches target |
| Section "done" check | `tasks.ts:1111` | `['pending', 'in_progress', 'review', 'partial']` | Add merge pipeline statuses to NOT-done set |
| `followUpEligibilityFilter` | `queries.ts:1366` | `IN ('pending', 'in_progress', 'review')` | Add merge pipeline statuses — without this, follow-ups start before primary work merges |
| `STATUS_MARKERS` | `queries.ts:23` | Maps each status to display marker | Add entries for `merge_pending`, `rebase_pending`, `rebase_review` |
| `SelectedTask.action` type | `task-selector.ts:25` | `'review' \| 'resume' \| 'start'` | Extend union: `\| 'merge' \| 'rebase' \| 'rebase_review'` |
| `orchestrator-loop` dispatch | `orchestrator-loop.ts:338` | `if start / else if resume / else if review` | Add: `else if merge / else if rebase / else if rebase_review` |
| Foreground `loop` dispatch | `loop.ts:372` | `if start / else if resume / else if review` | Filter out merge/rebase statuses — foreground loop does NOT handle merge pipeline (daemon only) |
| `TERMINAL_STATUSES` (disputes) | `disputes/behavior.ts:247` | `['completed', 'disputed', 'failed']` | Pre-existing gap (missing `skipped`). New statuses are non-terminal — no change needed here. |

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

**Foreground `loop` command:** Does NOT support merge/rebase actions. The task selector in foreground mode filters out `merge_pending`, `rebase_pending`, `rebase_review` statuses. Merge pipeline runs only in daemon mode.

### Runtime environment for merge/rebase handlers

| Action | Pool slot | Merge lock | Heartbeat | Expected duration |
|--------|-----------|------------|-----------|-------------------|
| `merge` | Claims a pool slot for git operations | Acquires merge lock (epoch-based) | Pool slot heartbeat + task lock heartbeat | Seconds (rebase + ff-only + push) |
| `rebase` | Claims a pool slot for LLM coder work | No merge lock (lock is per-merge-attempt only) | Pool slot heartbeat + task lock heartbeat | 5-30 minutes (LLM invocation) |
| `rebase_review` | Claims a pool slot for reviewer work | No merge lock | Pool slot heartbeat + task lock heartbeat | 5-15 minutes (LLM invocation) |

**Lock nesting order:** task lock (outer) -> merge lock (inner). The merge lock is never held while waiting for the task lock. The merge lock uses non-blocking acquisition (`acquireMergeLock` returns false immediately if contended).

### Merge lock

- One merge attempt at a time per project (keyed by project path)
- Lock acquired before rebase + ff-only attempt, released after push or on failure
- Lock covers the deterministic rebase + ff-only + push window (seconds) — does NOT hold during LLM rebase cycles
- Uses epoch-based locking (existing `workspace_merge_locks` + `epoch` column pattern from `012_add_merge_lock_epoch.sql`) — a new contender invalidates stale holders
- Tasks waiting for the lock stay in `merge_pending` — the task selector picks them up when the lock is free

### SHA tracking

`approved_sha` has a single owner: the reviewer (or rebase reviewer) at approval time.

1. `pushTaskBranchForDurability`: pushes branch only, does NOT set `approved_sha`
2. `transitionAfterReviewerApproval`: SOLE authority — fetches remote HEAD of `steroids/task-<taskId>`, records as `task.approved_sha`, transitions to `merge_pending`
3. `fetchAndPrepare`: verifies `task branch HEAD === task.approved_sha` before merge
4. `runRebaseCoder`: updates `task.approved_sha` to new HEAD after force-push
5. `runRebaseReview` (approve): re-records `task.approved_sha` from remote HEAD at approval time — guards against modification between rebase coder and merge gate
6. If SHA mismatch detected in `fetchAndPrepare`: task returns to `review` status for re-review

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
| Workspace merge lock pattern + epoch | Reused for merge queue serialization |

---

## Implementation Order

### Phase 1: Push restructuring
1. Move task branch push from `cleanupPoolSlot` to `submitForReviewWithDurableRef` in coder decision (`pushTaskBranchForDurability`)
2. `cleanupPoolSlot` becomes slot release only — no push, no status overrides
3. Push failure = `blocked_error` (infrastructure), not `pending`/`skipped`

### Phase 2+3: Decouple review + merge gate (atomic)
These ship together so `merge_pending` tasks always have a processor.

4. Add `merge_pending`, `rebase_pending`, `rebase_review` statuses to `TaskStatus` enum
5. Add `approved_sha`, `rebase_review_rejection_count`, `total_rebase_cycles` columns to tasks table (migration)
6. Add `MERGE_PIPELINE_ACTIVE_STATUSES` constant, update ALL call sites in the propagation table
7. Extend `SelectedTask.action` union type; add dispatch handlers in orchestrator-loop
8. Filter merge/rebase statuses from foreground `loop` task selector
9. Reviewer approval transitions to `merge_pending` (records `approved_sha`) instead of calling `mergeToBase`
10. Remove `mergeToBase` call from reviewer phase
11. New merge gate module: `selectMergePendingTask` -> `acquireMergeLock` (epoch-based) -> `fetchAndPrepare` (SHA verify) -> `attemptRebaseAndFastForward` (deterministic rebase + ff-only) -> `pushTargetBranch` -> `cleanupTaskBranch` -> `markCompleted`
12. Failure path: `transitionToRebasePending` (with `total_rebase_cycles` cap)

### Phase 4: Rebase cycle
13. `runRebaseCoder` — rebase-specific prompt (rebase onto target, resolve conflicts, verify build). Failure = `disputed` (task-level), not `blocked_error` (infrastructure)
14. `runRebaseReview` — lighter review focused on conflict resolution quality. Re-records `approved_sha` on approval.
15. `handleRebaseReviewRejection` — cycle tracking: only review rejections count toward 2-cap, total cycles count toward 10-cap
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
| Two tasks approved simultaneously, both try merge | Merge lock serializes — first wins ff-only, second gets deterministic rebase attempt. If no conflicts, merges without LLM. |
| Rebase coder introduces new bugs | Rebase review catches it, rejects, rebase review rejection count increments |
| Target branch force-pushed externally | ff-only will fail, deterministic rebase attempted first, conflicts escalate to LLM rebase coder |
| Task branch deleted from remote while in review | Reviewer fetch fails — transition to `blocked_error`, not silent skip |
| Task branch modified after approval (SHA mismatch) | `fetchAndPrepare` detects mismatch, task returns to `review` for re-review |
| ff-only succeeds but target push fails (race) | Another merge pushed between ff-only and push. Task returns to `merge_pending` for retry. Does NOT count toward any cap. |
| Multiple tasks hit rebase cap simultaneously | Each escalates to `disputed` independently |
| Local-only project (no remote) | No task branch push, no merge queue. Work stays local. Existing local behavior preserved — out of scope. |
| Rebase succeeds but ff-only still fails (concurrent merge) | Normal — re-enter merge gate. Deterministic rebase handles most cases without LLM. `total_rebase_cycles` cap (10) prevents unbounded looping. |
| Crash during merge (lock held) | Epoch-based lock — new contender invalidates stale holder's epoch, acquires lock normally |
| High-contention project (many concurrent merges) | `total_rebase_cycles` cap (10) prevents any single task from unbounded bounce. Most concurrent merges resolve via deterministic rebase (no LLM). |
| `blocked_error` dependency interaction | `blocked_error` is in `SECTION_DEP_TERMINAL` but NOT in `TASK_DEP_TERMINAL`. Section-level deps may treat it as done; task-level deps correctly block. This is pre-existing behavior, not introduced by merge queue. |
| Foreground `loop` encounters merge_pending task | Filtered out — foreground loop only handles `start`, `resume`, `review`. Merge pipeline runs in daemon mode only. |

## Non-Goals

- PR-based merge flow (GitHub PRs) — future work
- Branch protection rules enforcement — relies on git server-side config
- Multi-remote support — single remote per project (`config.git.remote`)
- Changing the coder or reviewer prompt formats — only the merge/rebase pipeline changes
- Local-only project merge improvements — out of scope
- Drain mode (stop all runners for rebase) — deferred from v1; simple `disputed` escalation is sufficient
- `blocked_error` lifecycle redesign — pre-existing concern, handled by wakeup sanitizer retries
- Branch GC mechanism — orphan branches handled by existing `steroids gc` and wakeup cleanup

## Cross-Provider Review — Round 1

**Reviewers:** Claude (`superpowers:code-reviewer`) and Codex
**Date:** 2026-03-23

### Finding 1: Remove drain mode from v1 (Claude Critical, Codex Critical)
**Assessment:** Both reviewers flagged drain mode as over-engineered with deadlock risk.
**Decision:** ADOPT. Removed drain mode entirely. Tasks escalate to `disputed` after 2 failed rebase review cycles.

### Finding 2: Add SHA tracking for approved commits (Claude Important, Codex Important)
**Assessment:** Without SHA tracking, a task branch could be modified between reviewer approval and merge gate processing.
**Decision:** ADOPT. Added `approved_sha` column, recorded at approval time, verified in `fetchAndPrepare`, updated after rebase force-push.

### Finding 3: Fix merge gate race — push is the real race point (Claude Important)
**Assessment:** `git merge --ff-only` is local. The race is between the local merge succeeding and `git push` of the target branch.
**Decision:** ADOPT. `pushTargetBranch` handles non-ff push rejection by returning task to `merge_pending` for retry.

### Finding 4: Only count rebase REVIEW REJECTIONS toward cycle cap (Codex Important)
**Assessment:** ff-only race losses are normal and shouldn't penalize the task.
**Decision:** ADOPT. Renamed counter to `rebase_review_rejection_count`. Only review rejections increment it.

### Finding 5: Add status propagation table (Claude Critical, Codex Important)
**Assessment:** New statuses must propagate through every hardcoded status set.
**Decision:** ADOPT. Added propagation table mapping each call site to required changes.

### Finding 6: Merge lock scope — seconds, not entire rebase cycle (Claude Important)
**Assessment:** Holding the merge lock during LLM rebase would block all merges for minutes.
**Decision:** ADOPT. Lock scope covers rebase + ff-only + push only.

### Finding 7: Implement Phases 2+3 atomically (Codex Important)
**Assessment:** If `merge_pending` exists without a merge gate processor, approved tasks strand.
**Decision:** ADOPT. Phases 2 and 3 merged into single atomic step.

### Finding 8: Specify task selector action types (Claude Suggestion, Codex Suggestion)
**Assessment:** New statuses need new action types for dispatch routing.
**Decision:** ADOPT. Added action type table.

### Finding 9: Migration plan for in-flight tasks (Codex Suggestion)
**Assessment:** Tasks in `review` need handling during migration.
**Decision:** ADOPT. Atomic Phase 2+3 deployment handles this naturally.

## Cross-Provider Review — Round 2

**Reviewers:** Claude (`superpowers:code-reviewer`) and Gemini (`gemini -p`)
**Date:** 2026-03-23

### Finding R2-1: Status propagation table incomplete — 10+ missing call sites (Claude Critical)
**Assessment:** Valid. Claude traced through the actual codebase and found `hasPendingOrInProgressWork`, `selectNextTaskWithWait`, `selectTaskBatch`, `wakeup-checks.ts`, `getSectionCounts`, `tasks.ts` section done check, `getTaskCounts`, `followUpEligibilityFilter`, `STATUS_MARKERS`, `SelectedTask.action` type, foreground `loop` dispatch, and more. The original 6-row table was dangerously incomplete — `hasPendingOrInProgressWork` controls runner loop exit and would cause premature "ALL TASKS COMPLETE" declarations.
**Decision:** ADOPT. Expanded propagation table from 6 to 17 rows. Added recommendation for shared `MERGE_PIPELINE_ACTIVE_STATUSES` constant.

### Finding R2-2: `SelectedTask.action` type union breaks downstream (Claude Critical)
**Assessment:** Valid. The type is `'review' | 'resume' | 'start'` — adding new action types cascades through multiple dispatch sites. The foreground `loop.ts` has no handler for merge/rebase.
**Decision:** ADOPT. Specified type change, all dispatch sites, and that foreground loop filters out merge/rebase statuses.

### Finding R2-3: Unbounded ff-only race loss loop (Claude Critical)
**Assessment:** Valid. No cap on total rebase cycles means a task could bounce `merge_pending -> rebase_pending -> rebase_review -> merge_pending` indefinitely in a high-throughput project, consuming LLM invocations on every cycle.
**Decision:** ADOPT. Added `total_rebase_cycles` counter (default 10) alongside `rebase_review_rejection_count` (default 2). Total cycles covers all loop iterations; review rejections covers LLM quality failures.

### Finding R2-4: `pushTaskBranchForDurability` insertion point unspecified (Claude Important)
**Assessment:** Valid. The design said push moves to coder-to-review transition but didn't specify the exact code location.
**Decision:** ADOPT. Specified: called from `submitForReviewWithDurableRef`, BEFORE status transitions to `review`.

### Finding R2-5: Current `mergeToBase` does cheap deterministic rebase — new design skips this (Claude Important)
**Assessment:** Valid. The strongest finding. Currently `mergeToBase` does `git rebase` (no LLM) + ff-only inside the lock. The original design jumped straight to LLM-powered rebase on ff-only failure. In a project with 5+ parallel runners, every merge after the first in each batch would require an LLM rebase coder instead of a simple `git rebase`.
**Decision:** ADOPT. Renamed `attemptFastForwardMerge` to `attemptRebaseAndFastForward`. It now tries ff-only first, then deterministic `git rebase`, then ff-only again. Only true conflicts (rebase fails) escalate to LLM rebase coder. Preserves current performance.

### Finding R2-6: No runtime environment spec for merge/rebase handlers (Claude Important)
**Assessment:** Valid. Pool slot usage, lock nesting, heartbeat maintenance for new action types was unspecified.
**Decision:** ADOPT. Added runtime environment table and lock nesting order specification.

### Finding R2-7: SHA tracking TOCTOU gap in rebase review (Claude Important)
**Assessment:** Valid. `runRebaseReview` approval should re-record `approved_sha` at approval time, just as the initial reviewer does.
**Decision:** ADOPT. Added explicit SHA re-recording to `runRebaseReview` approval path.

### Finding R2-8: `approved_sha` set by two functions (Gemini Critical)
**Assessment:** Valid. Both `pushTaskBranchForDurability` and `transitionAfterReviewerApproval` claimed to set it.
**Decision:** ADOPT. Made `transitionAfterReviewerApproval` the sole authority. Removed SHA recording from `pushTaskBranchForDurability`.

### Finding R2-9: `runRebaseCoder` failure should go to `disputed`, not `blocked_error` (Gemini Important)
**Assessment:** Valid. An LLM failing to resolve conflicts is task-specific, not infrastructure. `blocked_error` is for git/network failures.
**Decision:** ADOPT. Rebase coder failure (LLM cannot resolve) -> `disputed`. Infrastructure failure (git/network) -> `blocked_error`.

### Finding R2-10: Merge lock should use epoch pattern (Gemini Important)
**Assessment:** Valid. The codebase already has the epoch-based locking pattern in `workspace_merge_locks` + `012_add_merge_lock_epoch.sql`.
**Decision:** ADOPT. Specified epoch-based locking explicitly in `acquireMergeLock` contract.

### Finding R2-11: `blocked_error` lifecycle undefined (Gemini Important)
**Assessment:** Pre-existing concern. `blocked_error` handling (wakeup sanitizer retries) already exists. Not introduced by this design.
**Decision:** DEFER. Added to Non-Goals.

### Finding R2-12: `cleanupTaskBranch` best-effort leads to branch bloat (Gemini Suggestion)
**Assessment:** Existing `steroids gc` and wakeup cleanup already handle orphan branches. Adding a dedicated GC mechanism is over-engineering for v1.
**Decision:** DEFER. Added to Non-Goals.

### Finding R2-13: Delta-only rebase review unproven (Gemini Suggestion)
**Assessment:** Prompt engineering concern, not architectural. If delta review proves unreliable, switching to full review is a prompt change, not a design change.
**Decision:** DEFER. Risk acknowledged but no design change needed — prompt iteration is independent of pipeline architecture.

### Finding R2-14: `blocked_error` in `SECTION_DEP_TERMINAL` may unblock dependents prematurely (Claude Important)
**Assessment:** Valid concern but pre-existing. `blocked_error` is in `SECTION_DEP_TERMINAL` but NOT in `TASK_DEP_TERMINAL`. The merge queue uses `blocked_error` the same way existing code does.
**Decision:** DEFER. Documented in edge cases table. Pre-existing behavior, not introduced by this design.
