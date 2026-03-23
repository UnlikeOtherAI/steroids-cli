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
| **Target branch** | `config.git?.branch` (default: `main`) | Production branch with all approved code. Configured per-project in `steroids.config.json` or globally in `~/.steroids/config.json`. Accessed as `config.git?.branch ?? 'main'`. |
| **Task branch** | `steroids/task-<taskId>` | Per-task working branch on the remote. Pushed for durability after coder completes. Reviewer reads from it. Merge queue merges it into target. Deleted after successful merge. |
| **Remote** | `config.git?.remote` (default: `origin`) | The remote used for all push/fetch operations. Accessed as `config.git?.remote ?? 'origin'`. |

## Design: Sequential Pipeline

The merge queue replaces coupled reviewer-merge logic with a sequential pipeline of named steps. Each step has a clear contract: what it checks, what it returns, and what happens on failure. The main flow reads as a high-level narrative.

### Single status, internal phases

The merge pipeline uses **one new task status** (`merge_pending`) visible to the rest of the system. The internal state machine is tracked via a `merge_phase` column, private to the merge queue module. Every other component — task selector, wakeup checks, section-done checks, monitor — sees a single status and treats it uniformly as "active, non-terminal work."

| `merge_phase` | Meaning | What runs |
|----------------|---------|-----------|
| `queued` | Awaiting merge attempt | `processMergeQueue` |
| `rebasing` | LLM rebase coder in progress | `runRebaseCoder` |
| `rebase_review` | Rebase review in progress | `runRebaseReview` |

This eliminates the need for 3 new statuses, 3 new action types, 3 new dispatch branches, and a `MERGE_PIPELINE_ACTIVE_STATUSES` constant across 17+ call sites. Instead: one status added to each status set, one new action type (`merge`), one dispatch branch.

### Pipeline overview

```typescript
// merge-queue.ts — desired shape
async function processMergeQueue(db: Database, task: Task, config: SteroidsConfig): Promise<void> {
  const phase = task.merge_phase ?? 'queued';

  switch (phase) {
    case 'queued':
      return handleMergeAttempt(db, task, config);
    case 'rebasing':
      return handleRebaseCoder(db, task, config);
    case 'rebase_review':
      return handleRebaseReview(db, task, config);
  }
}

async function handleMergeAttempt(db: Database, task: Task, config: SteroidsConfig): Promise<void> {
  if (!acquireMergeLock(db, config)) return;  // another merge in progress, retry next iteration

  try {
    const prepared = fetchAndPrepare(db, task, config);
    if (!prepared.ok) { handlePrepFailure(db, task, prepared); return; }
    if (prepared.alreadyMerged) { markCompleted(db, task); return; }  // crash recovery

    const mergeResult = attemptRebaseAndFastForward(prepared.slot, task, config);
    if (mergeResult.merged) {
      const pushResult = pushTargetBranch(prepared.slot, config);
      if (!pushResult.ok) { handlePushFailure(db, task, pushResult); return; }
      cleanupTaskBranch(prepared.slot, task, config);
      markCompleted(db, task);
      return;
    }

    // Deterministic rebase failed with conflicts — needs LLM
    transitionToRebasing(db, task);
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
//   - Approve: task transitions to 'merge_pending' with merge_phase = 'queued'
//   - SOLE authority for setting approved_sha: fetches current HEAD of remote
//     steroids/task-<taskId> and records it as task.approved_sha
//   - Reject: task returns to 'pending' (existing behavior)
```

The reviewer **never merges**. `mergeToBase` is removed from the reviewer phase.

**Implementation note:** Phases 2 and 3 must ship atomically. If `merge_pending` exists without a merge gate processor, approved tasks will strand.

---

### Phase 3: Merge gate — named steps

The merge gate operates on tasks in `merge_pending` status with `merge_phase = 'queued'`.

#### `acquireMergeLock` / `releaseMergeLock`

```typescript
function acquireMergeLock(db: Database, config: SteroidsConfig): boolean
// Contract:
//   - One merge attempt at a time per project (keyed by project path)
//   - Lock scope: covers ONLY the deterministic rebase + ff-only + target branch push (seconds)
//   - Does NOT hold lock during LLM rebase cycle
//   - Uses the existing heartbeat-based locking pattern (workspace_merge_locks table with
//     heartbeat_at column and TTL-based stale detection — NOT epoch-based despite prior doc references)
//   - Returns true if acquired, false if contended (handler returns immediately, task retried next iteration)
```

#### `fetchAndPrepare`

```typescript
function fetchAndPrepare(
  db: Database, task: Task, config: SteroidsConfig
): { ok: boolean; slot: PoolSlotContext; alreadyMerged?: boolean; error?: string }
// Contract:
//   - Fetches latest target branch from remote
//   - Fetches task branch from remote
//   - IDEMPOTENCY CHECK: if task.approved_sha is reachable from target branch HEAD
//     (git merge-base --is-ancestor), returns { ok: true, alreadyMerged: true }
//     -> caller skips to markCompleted. This handles crash-after-push recovery
//     (push succeeded but DB update failed on previous attempt).
//   - Verifies task branch HEAD matches task.approved_sha (SHA tracking guard)
//   - If SHA mismatch: returns { ok: false, error: 'sha_mismatch' }
//   - Prepares pool slot for merge: checks out target branch, task branch fetched
//     into local tracking ref. Slot is in a state where `git merge --ff-only task_branch`
//     or `git rebase` can run immediately.
```

#### `handlePrepFailure`

```typescript
function handlePrepFailure(db: Database, task: Task, result: { error?: string }): void
// Contract:
//   - 'sha_mismatch': task returns to 'review' for re-review, clears merge_phase,
//     rebase_attempts, approved_sha, push_race_losses (full merge state reset)
//   - 'fetch_failed' / infrastructure: task -> 'blocked_error'
//   - All other errors: task -> 'blocked_error' with error detail
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
// Preserves current mergeToBase performance: most concurrent merges are simple
// rebases with no conflicts, handled in milliseconds without LLM involvement.
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
//     -> task stays in merge_pending/queued for retry, does NOT count toward rebase cap
//     -> push_race_losses counter incremented; if >= soft cap (default 20), task -> disputed
//        (prevents infinite loop under extreme contention)
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
//   - Failure is non-fatal (orphan branches caught by existing `steroids gc`)
```

#### `markCompleted`

```typescript
function markCompleted(db: Database, task: Task): void
// Contract:
//   - Task status -> 'completed', clears merge_phase, rebase_attempts, approved_sha, push_race_losses
//   - Clears task branch reference
//   - Any external reset of a merge_pending task (FR, sanitizer) must also clear
//     merge_phase, rebase_attempts, approved_sha, and push_race_losses
```

---

### Phase 4: Rebase cycle — named steps

When deterministic rebase fails with conflicts, the task needs LLM-powered conflict resolution. The rebase cycle is internal to the merge queue — the task stays in `merge_pending` status throughout.

#### `transitionToRebasing`

```typescript
function transitionToRebasing(db: Database, task: Task): void
// Contract:
//   - Sets merge_phase = 'rebasing'
//   - Increments rebase_attempts counter
//   - If rebase_attempts >= maxRebaseAttempts (default 3): task -> 'disputed'
//   - Records divergence reason for audit trail
```

#### `handleRebaseCoder`

```typescript
function handleRebaseCoder(
  db: Database, task: Task, config: SteroidsConfig
): { ok: boolean; error?: string }
// Contract:
//   - Spawns a rebase coder instance (LLM invocation with rebase-specific prompt)
//   - Checks out the task branch
//   - Runs: git rebase <remote>/<target_branch>
//   - Resolves any conflicts
//   - Ensures code still works after rebase (runs build/test if configured)
//   - DIFF FENCE: after LLM rebase, validates that only conflict-affected files were
//     modified. Conflict file list is captured before LLM runs: start `git rebase`,
//     record files with conflict markers from `git diff --name-only --diff-filter=U`,
//     then abort and hand to LLM. After LLM completes, compare `git diff --name-only`
//     against the captured list. Rejects if LLM touched unrelated files.
//   - Force-pushes the updated task branch (--force-with-lease)
//   - Success: sets merge_phase = 'rebase_review'
//   - Failure (LLM cannot resolve conflicts): task -> 'disputed' (not blocked_error)
//   - Failure (diff fence violation): task -> 'disputed' with audit log entry
//   - Failure (infrastructure — git/network): task -> 'blocked_error'
//   - Does NOT set approved_sha — that is the rebase reviewer's responsibility
```

#### `handleRebaseReview`

```typescript
function handleRebaseReview(
  db: Database, task: Task, config: SteroidsConfig
): { decision: 'approve' | 'reject' }
// Contract:
//   - Runs existing reviewer on the rebased task branch
//   - Reviewer sees: original approved code + rebase changes, reviews only the delta
//   - Approve: re-records task.approved_sha = current remote HEAD,
//     sets merge_phase = 'queued' (retry merge)
//   - Reject: calls transitionToRebasing (which increments rebase_attempts and
//     checks cap — single increment point, no double-counting)
```

#### Rebase cycle state machine

```
merge_pending (queued) -> [ff-only] -> [deterministic rebase] -> [ff-only] -> completed
                                              |
                                         [conflicts]
                                              |
                   merge_pending (rebasing) -> rebase coder -> merge_pending (rebase_review)
                          ^                       |                     |
                          |                  [LLM fail]           [reject, count < 3]
                          |                       |                     |
                          |                   disputed                  |
                          +---------------------------------------------+
                                                                        |
                                                                  [reject, count >= 3]
                                                                        |
                                                                    disputed

                   merge_pending (rebase_review) -> [approve] -> merge_pending (queued) -> retry
```

**Single cap:** `rebase_attempts` (default 3) — incremented each time the task enters LLM rebase (conflicts requiring AI resolution). Deterministic rebases and push race losses do NOT increment this counter.

---

### New task status

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `merge_pending` | In the merge pipeline (queued, rebasing, or under rebase review) | No |

New columns on tasks table:
- `merge_phase TEXT` — `'queued'`, `'rebasing'`, `'rebase_review'` (NULL when not in merge pipeline)
- `approved_sha TEXT` — SHA blessed by reviewer, verified before merge
- `rebase_attempts INTEGER DEFAULT 0` — LLM rebase cycle count, cap at 3
- `push_race_losses INTEGER DEFAULT 0` — push race loss counter, soft cap at 20

### Status propagation table

One new status (`merge_pending`) added to each hardcoded status set:

| Call site | File | Current set | Required change |
|-----------|------|-------------|-----------------|
| `hasPendingOrInProgressWork` | `task-selector.ts:62` | `IN ('pending', 'in_progress', 'review')` | Add `'merge_pending'` |
| `selectNextTaskWithWait` exit | `task-selector.ts:504` | `pending === 0 && in_progress === 0 && review === 0` | Add `merge_pending` to active count |
| `selectTaskBatch` active count | `task-selector.ts:160` | `IN ('in_progress', 'review')` | Add `'merge_pending'`. Consequence: sections with tasks in merge pipeline are blocked from batch selection (intentional — task is near completion). |
| `findNextTask` pending work | `queries.ts:1350` | Explicit priority blocks: P1=`review`, P2=`in_progress`, P3=`pending` | Add P0 block for `merge_pending` with `action: 'merge'` (before review — highest priority, closest to completion). Uses explicit inclusion, NOT exclusion. |
| `findNextTaskSkippingLocked` | `task-selector.ts:363` | Same priority structure as `findNextTask` | Add P0 block for `merge_pending` — same change as `findNextTask` |
| `hasDependenciesMet` | `queries.ts` | `completed` only | No change |
| `buildParallelRunPlan` | `runners-parallel.ts:125` | `NOT IN (completed, disputed, ...)` | Uses exclusion — correctly included |
| `selectNextTaskWithLock` routing | `task-selector.ts` | `pending->start, in_progress->resume, review->review` | Add: `merge_pending->merge` |
| `getTaskCounts` | `task-selector.ts:246` | Named buckets: `pending`, `in_progress`, `review`, etc. | Add `merge_pending: number` field to return type and COUNT query |
| Wakeup pending work check | `wakeup-checks.ts:57` (inline query, not a named function) | `IN ('pending', 'in_progress', 'review')` | Add `'merge_pending'` |
| `getSectionCounts` | `section-pr.ts:37` | `IN ('pending','in_progress','review','partial')` | Add `'merge_pending'` |
| Section "done" check | `tasks.ts:1111` | `['pending', 'in_progress', 'review', 'partial']` | Add `'merge_pending'` |
| `followUpEligibilityFilter` | `queries.ts:1360-1368` + `task-selector.ts:372-381` | `IN ('pending', 'in_progress', 'review')` | Add `'merge_pending'` — appears 3x in `findNextTask` and 3x in `findNextTaskSkippingLocked` (6 instances total) |
| `STATUS_MARKERS` | `queries.ts:23` | Maps each status to display marker | Add `merge_pending` entry |
| `SelectedTask.action` type | `task-selector.ts:25` | `'review' \| 'resume' \| 'start'` | Add `\| 'merge'` |
| `orchestrator-loop` dispatch | `orchestrator-loop.ts:338` | `if start / else if resume / else if review` | Add `else if merge` -> `processMergeQueue` |
| Foreground `loop` dispatch | `loop.ts:372` | `if start / else if resume / else if review` | Add `else if merge` -> `processMergeQueue` (same handler) |
| `VALID_TASK_STATUSES` | `investigator-actions.ts:24` | Whitelist of valid statuses | Add `'merge_pending'` |
| `hasPendingWork` (scanner) | `scanner.ts:148` | `IN ('pending', 'in_progress', 'review')` | Add `'merge_pending'` |
| `scanHighInvocations` | `scanner-queries.ts:67` | `NOT IN ('completed', 'skipped', ...)` | Uses exclusion — correctly included |
| Stuck task detector | `stuck-task-detector.ts:258` | `IN ('in_progress', 'review')` | Add `'merge_pending'` for hanging invocation detection |

### Task selector

One new action type. The merge queue handler internally routes based on `merge_phase`:

| Status | Action | Handler |
|--------|--------|---------|
| `pending` | `start` | `runCoderPhase` |
| `in_progress` | `resume` | `runCoderPhase` |
| `review` | `review` | `runReviewerPhase` |
| `merge_pending` | `merge` | `processMergeQueue` (routes internally via `merge_phase`) |

Both foreground `loop` and daemon mode handle the `merge` action — the merge lock provides serialization regardless of which process drives the loop.

### Runtime environment for merge handler

| `merge_phase` | Pool slot | Merge lock | Expected duration |
|---------------|-----------|------------|-------------------|
| `queued` | Claims fresh pool slot | Acquires merge lock (heartbeat-based) | Seconds (rebase + ff-only + push) |
| `rebasing` | Claims fresh pool slot | No merge lock | 5-30 minutes (LLM invocation) |
| `rebase_review` | Claims fresh pool slot | No merge lock | 5-15 minutes (LLM invocation) |

**Lock nesting order:** task lock (outer) -> merge lock (inner). Merge lock uses non-blocking acquisition — returns false immediately if contended, task retried next iteration.

**Pool slot claiming:** The merge handler claims a fresh pool slot at dispatch time (same mechanism as the reviewer — `claimSlot` from `pool.ts`). The original coder/reviewer slot was released after the reviewer phase completed. If no pool slot is available (all claimed), the task is retried next iteration.

### Merge lock

- One merge attempt at a time per project (keyed by project path)
- Lock scope: deterministic rebase + ff-only + push only (seconds)
- Uses heartbeat-based locking (existing `workspace_merge_locks` table with `heartbeat_at` and TTL stale detection) for crash recovery
- Contention is handled by the merge handler, not the task selector — no coupling between them

### SHA tracking

`approved_sha` has exactly two writers: the initial reviewer and the rebase reviewer.

1. `pushTaskBranchForDurability`: pushes branch only, does NOT set `approved_sha`
2. `transitionAfterReviewerApproval`: SOLE initial authority — fetches remote HEAD, records as `task.approved_sha`
3. `fetchAndPrepare`: verifies `task branch HEAD === task.approved_sha` before merge
4. `handleRebaseCoder`: does NOT set `approved_sha` — it is not a reviewer
5. `handleRebaseReview` (approve): re-records `task.approved_sha` from remote HEAD at approval time
6. If SHA mismatch in `fetchAndPrepare`: task returns to `review` for re-review

### Health system integration

The monitor, sanitizer, and stuck-task detector must be merge-pipeline-aware:

**Wakeup sanitizer (`wakeup-sanitise-recovery.ts`):** Two changes required:

1. **Reviewer-approval recovery** (lines 133-157): Currently marks `review` tasks as `completed` on recovered approve token. Must transition to `merge_pending` (with `merge_phase = 'queued'` and `approved_sha` recorded), not `completed`. Prevents bypassing the merge queue.

2. **Merge-role-aware recovery**: When recovering orphaned invocations for tasks in `merge_pending` status, the sanitizer must check the invocation role (`merge`, `rebase_coder`, `rebase_reviewer`) and handle each correctly:
   - Orphaned `rebase_coder` invocation: reset `merge_phase` to `queued` for retry (do NOT reset to `pending` — that loses the review approval)
   - Orphaned `rebase_reviewer` with approve token: re-record `approved_sha`, set `merge_phase = 'queued'`
   - Orphaned `rebase_reviewer` with reject token: set `merge_phase = 'rebasing'`, increment `rebase_attempts`
   - Orphaned `merge` invocation: release merge lock if held, reset `merge_phase = 'queued'`
   - The `shouldSkipInvocation` guard (line 79) must NOT block recovery of `rebase_coder`/`rebase_reviewer` invocations — these don't hold the merge lock

**Stuck task detector (`stuck-task-detector.ts`):** The hanging invocation query (line 258) only checks `('in_progress', 'review')`. Add `'merge_pending'` so tasks stuck in the merge pipeline (e.g., LLM rebase taking too long) are detected and reported.

**Monitor scanner (`scanner.ts`):** `hasPendingWork` (line 148) must include `'merge_pending'`. Without this, projects with tasks in the merge pipeline appear idle, triggering false-positive "idle project" anomalies.

**First responder (`investigator-actions.ts`):** Three changes:

1. `VALID_TASK_STATUSES` (line 24): Add `'merge_pending'`
2. `UPDATABLE_TASK_FIELDS` (line 18): Add `'merge_phase'`, `'approved_sha'`, `'rebase_attempts'`
3. New actions the FR agent can take:
   - `release_merge_lock`: Forcibly release a stale merge lock for a project. Used when `stale_merge_lock` anomaly is detected.
   - `reset_merge_phase`: Reset a task's `merge_phase` to `'queued'` and clear failure state, allowing merge retry without losing review approval. Used for most `stuck_merge_*` anomalies.

**New monitor anomaly types** for the scanner:

| Anomaly | Severity | Trigger | Auto-recovery |
|---------|----------|---------|---------------|
| `stale_merge_lock` | critical | Merge lock held > 5 minutes | FR releases lock via `release_merge_lock` |
| `stuck_merge_phase` | critical | Task in `merge_pending` with same `merge_phase` for > 90 min (rebasing/rebase_review) or > 15 min (queued) | FR resets via `reset_merge_phase` |
| `disputed_task` | warning | Task in `disputed` status | FR reports for human triage |

**FR prompt enrichment:** When investigating merge anomalies, include `task.merge_phase`, `task.rebase_attempts`, `task.approved_sha`, and merge lock state (holder, heartbeat_at, age) in the anomaly context.

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
| `src/parallel/merge-git.ts`, `merge-process.ts`, `merge-sealing.ts`, `merge-workspace.ts`, `merge-commit-checks.ts`, `merge-validation.ts`, `merge-progress.ts`, `merge-errors.ts`, `merge-lock.ts`, `merge-conflict*.ts` (all under `src/parallel/`) | Remove — the cherry-pick pipeline is replaced by ff-only + rebase. Note: `src/workspace/merge-lock.ts` is KEPT (reused for merge queue). |

## What stays

| Component | Why |
|-----------|-----|
| Pool slot lifecycle (`pool.ts`, `git-lifecycle.ts`) | Coder still works in pool slots |
| `pushWithRetries` (`git-helpers.ts`) | Still used for task branch and target branch pushes. **MUST replace synchronous busy-wait** (lines 124-128) with async backoff (`setTimeout`/`await sleep`). Current busy-wait blocks the event loop for up to 6.7 min during retry backoff, preventing heartbeat timers from firing — causes stale lock reclamation during legitimate merges. |
| `prepareForTask` (`git-lifecycle.ts`) | Still sets up pool slot for coder work |
| Task selector (`task-selector.ts`) | Extended with one new action type (`merge`) |
| Reviewer phase (`loop-phases-reviewer.ts`) | Still reviews, just doesn't merge |
| Workspace merge lock pattern + heartbeat (`src/workspace/merge-lock.ts`) | Reused for merge queue serialization. NOT the parallel `src/parallel/merge-lock.ts` (which is removed). |

---

## Implementation Order

### Phase 0: Prerequisite fixes
1. Replace `pushWithRetries` synchronous busy-wait with async backoff (blocks heartbeats — must ship before merge gate relies on heartbeat-based locking)

### Phase 1: Push restructuring
2. Move task branch push from `cleanupPoolSlot` to `submitForReviewWithDurableRef` in coder decision (`pushTaskBranchForDurability`)
3. `cleanupPoolSlot` becomes slot release only — no push, no status overrides
4. Push failure = `blocked_error` (infrastructure), not `pending`/`skipped`

### Phase 2+3: Decouple review + merge gate (atomic)
These ship together so `merge_pending` tasks always have a processor.

5. Add `merge_pending` status to `TaskStatus` enum
6. Add `merge_phase`, `approved_sha`, `rebase_attempts`, `push_race_losses` columns to tasks table (migration)
7. Update all call sites in the propagation table (one status per site)
8. Extend `SelectedTask.action` union with `'merge'`; add dispatch handler in orchestrator-loop and foreground loop
9. Reviewer approval transitions to `merge_pending` (records `approved_sha`, sets `merge_phase = 'queued'`) instead of calling `mergeToBase`
10. Remove `mergeToBase` call from reviewer phase
11. New merge gate module: `processMergeQueue` with internal routing via `merge_phase`
12. Merge lock per project (heartbeat-based, reusing `src/workspace/merge-lock.ts`)
13. Update wakeup sanitizer reviewer-approval recovery to transition to `merge_pending` instead of `completed`
14. Update stuck-task-detector, scanner `hasPendingWork`, and `VALID_TASK_STATUSES` for `merge_pending`

### Phase 4: Rebase cycle
15. `handleRebaseCoder` — rebase-specific prompt (rebase onto target, resolve conflicts, verify build). Failure = `disputed` (task-level), not `blocked_error` (infrastructure). Includes diff fence validation.
16. `handleRebaseReview` — lighter review focused on conflict resolution quality. Re-records `approved_sha` on approval.
17. `rebase_attempts` cap (default 3) — incremented on LLM rebase entry only (single increment point: `transitionToRebasing`)
18. Add merge-role-aware recovery to wakeup sanitizer (`rebase_coder`, `rebase_reviewer`, `merge` invocation roles). New invocation roles must be registered in the invocation logging system.

### Phase 5: Cleanup
19. Remove `autoMergeOnCompletion` from daemon
20. Remove `runParallelMerge`, integration workspace, cherry-pick pipeline (all `src/parallel/merge-*.ts` and `merge-conflict*.ts`)
21. Remove workstream branch push from coder decision phase
22. Remove dead code: `src/workspace/git-lifecycle-merge.ts`, remaining unused parallel modules

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Push succeeds but task branch already on remote (no-op coder) | `git push` returns "Everything up-to-date" — not an error, proceed to review |
| Two tasks approved simultaneously, both try merge | Merge lock serializes — first wins ff-only, second gets deterministic rebase attempt. If no conflicts, merges without LLM. |
| Rebase coder introduces new bugs | Rebase review catches it, rejects, rebase_attempts increments |
| Target branch force-pushed externally | ff-only will fail, deterministic rebase attempted first, conflicts escalate to LLM rebase coder |
| Task branch deleted from remote while in review | Reviewer fetch fails — transition to `blocked_error`, not silent skip |
| Task branch modified after approval (SHA mismatch) | `fetchAndPrepare` detects mismatch, task returns to `review` for re-review |
| ff-only succeeds but target push fails (race) | Task stays in `merge_pending/queued` for retry. Does NOT increment `rebase_attempts`. |
| Multiple tasks hit rebase cap simultaneously | Each escalates to `disputed` independently |
| Local-only project (no remote) | No task branch push, no merge queue. Existing local behavior preserved — out of scope. |
| Rebase succeeds but ff-only still fails (concurrent merge) | Normal — re-enter merge gate. Deterministic rebase handles most cases without LLM. |
| Crash during merge (lock held) | Heartbeat-based lock — stale detection via TTL on `heartbeat_at` reclaims lock from dead holders |
| Sanitizer recovers reviewer approval | Transitions to `merge_pending/queued` (not `completed`), preserving merge queue path |
| Monitor detects stuck merge_pending task | Stuck-task-detector catches hanging invocations; FR resets via `reset_merge_phase` or releases lock via `release_merge_lock` |
| Foreground `loop` picks up merge_pending task | Handled normally — `processMergeQueue` runs the same in both modes, merge lock serializes |
| Push succeeds but DB update fails (crash/SIGTERM after push) | Idempotency check in `fetchAndPrepare`: `git merge-base --is-ancestor approved_sha target_HEAD` → skip to `markCompleted` |
| Rebase coder modifies unrelated files (prompt injection/bug) | Diff fence validates only conflict-affected files were changed; violation → `disputed` with audit log |
| Push race loss loops indefinitely under extreme contention | `push_race_losses` soft cap (default 20) → `disputed` after sustained contention |
| Sanitizer recovers orphaned rebase_coder invocation | Merge-role-aware recovery: resets `merge_phase` to `queued`, does NOT reset task to `pending` |
| Stale merge lock blocks entire project | Monitor detects `stale_merge_lock` anomaly (> 5 min), FR releases via `release_merge_lock` action |
| `pushWithRetries` busy-wait blocks heartbeats | Async backoff replaces synchronous busy-wait — heartbeat timers can fire during retry delays |
| Task reset from merge_pending (FR or sanitizer) | Must clear `merge_phase`, `rebase_attempts`, `approved_sha` to prevent stale phase state |

## Non-Goals

- PR-based merge flow (GitHub PRs) — future work
- Branch protection rules enforcement — relies on git server-side config
- Multi-remote support — single remote per project (`config.git.remote`)
- Changing the coder or reviewer prompt formats — only the merge/rebase pipeline changes
- Local-only project merge improvements — out of scope
- Drain mode (stop all runners for rebase) — deferred; simple `disputed` escalation is sufficient
- `blocked_error` lifecycle redesign — pre-existing concern, handled by wakeup sanitizer retries
- Centralized `STATUS_SETS` refactor — valuable follow-up but broader than merge queue scope

## Cross-Provider Review — Round 1

**Reviewers:** Claude (`superpowers:code-reviewer`) and Codex
**Date:** 2026-03-23

### R1-1: Remove drain mode from v1 (Claude Critical, Codex Critical)
**Decision:** ADOPT. Removed. Tasks escalate to `disputed` after failed rebase cycles.

### R1-2: Add SHA tracking for approved commits (Claude Important, Codex Important)
**Decision:** ADOPT. Added `approved_sha` column, verified before merge.

### R1-3: Fix merge gate race — push is the real race point (Claude Important)
**Decision:** ADOPT. `pushTargetBranch` handles non-ff push rejection.

### R1-4: Only count rebase REVIEW REJECTIONS toward cycle cap (Codex Important)
**Decision:** ADOPT. Only LLM rebase entries increment the cap.

### R1-5: Add status propagation table (Claude Critical, Codex Important)
**Decision:** ADOPT. Full propagation table added.

### R1-6: Merge lock scope — seconds, not entire rebase cycle (Claude Important)
**Decision:** ADOPT. Lock covers deterministic rebase + ff-only + push only.

### R1-7: Implement Phases 2+3 atomically (Codex Important)
**Decision:** ADOPT. Single atomic deployment.

### R1-8: Specify task selector action types (Claude Suggestion, Codex Suggestion)
**Decision:** ADOPT. Action type table added.

### R1-9: Migration plan for in-flight tasks (Codex Suggestion)
**Decision:** ADOPT. Atomic Phase 2+3 handles this naturally.

## Cross-Provider Review — Round 2

**Reviewers:** Claude (`superpowers:code-reviewer`) and Gemini (`gemini -p`)
**Date:** 2026-03-23

### R2-1: Status propagation table incomplete — 10+ missing call sites (Claude Critical)
**Decision:** ADOPT. Expanded table to 20 rows.

### R2-2: `SelectedTask.action` type union breaks downstream (Claude Critical)
**Decision:** ADOPT. Specified type change and all dispatch sites.

### R2-3: Unbounded ff-only race loss loop (Claude Critical)
**Decision:** ADOPT. Added `rebase_attempts` cap (simplified further in round 3).

### R2-4: `pushTaskBranchForDurability` insertion point unspecified (Claude Important)
**Decision:** ADOPT. Specified: called from `submitForReviewWithDurableRef`.

### R2-5: Current `mergeToBase` does cheap deterministic rebase (Claude Important)
**Decision:** ADOPT. Added deterministic rebase before LLM escalation.

### R2-6: No runtime environment spec (Claude Important)
**Decision:** ADOPT. Added runtime table and lock nesting order.

### R2-7: SHA tracking TOCTOU gap in rebase review (Claude Important)
**Decision:** ADOPT. Rebase reviewer re-records `approved_sha`.

### R2-8: `approved_sha` set by two functions (Gemini Critical)
**Decision:** ADOPT. Made reviewer sole authority.

### R2-9: `runRebaseCoder` failure -> `disputed`, not `blocked_error` (Gemini Important)
**Decision:** ADOPT. LLM conflict failure is task-specific.

### R2-10: Merge lock should use epoch pattern (Gemini Important)
**Decision:** ADOPT. Epoch-based locking specified.

### R2-11 through R2-14: Various deferrals
**Decision:** DEFER. Pre-existing concerns or out of scope.

## Cross-Provider Review — Round 3 (Simplification)

**Reviewers:** Claude (`superpowers:code-reviewer`) and Gemini (`gemini -p`)
**Date:** 2026-03-23

### R3-1: Reduce three statuses to one with internal `merge_phase` (Claude Critical, Gemini Important)
**Assessment:** Both reviewers converge: three new statuses propagating through 17+ call sites is the primary complexity cost. Claude proposes one status (`merge_pending`) with internal `merge_phase` column. Gemini proposes centralizing all status logic with `STATUS_SETS`. Both are valid; the single-status approach provides immediate simplification while `STATUS_SETS` is a broader follow-up.
**Decision:** ADOPT. Collapsed to single `merge_pending` status. Internal `merge_phase` column (`queued`, `rebasing`, `rebase_review`) is private to the merge queue module. This eliminates 2/3 of propagation updates, 2 of 3 action types, 2 of 3 dispatch branches. The `STATUS_SETS` centralization is noted as a valuable follow-up.

### R3-2: Simplify caps to single `rebase_attempts` counter (Claude Suggestion, Gemini Important)
**Assessment:** Both reviewers flag the two-counter system as unnecessary. Deterministic rebases are free (milliseconds, no LLM). Only LLM rebase entries are expensive. A single `rebase_attempts` counter (cap 3) tracking LLM entries provides the same protection with half the state.
**Decision:** ADOPT. Replaced `rebase_review_rejection_count` + `total_rebase_cycles` with single `rebase_attempts` (default 3). Incremented only when task enters LLM rebase (conflicts).

### R3-3: Sanitizer will bypass merge queue on recovered reviewer approvals (Claude Critical, Gemini Important)
**Assessment:** `recoverOrphanedInvocation` in `wakeup-sanitise-recovery.ts` marks `review` tasks as `completed` on recovered approve tokens. This bypasses the merge queue — code never reaches the target branch but the task is marked done.
**Decision:** ADOPT. Sanitizer reviewer-approval recovery must transition to `merge_pending/queued` (not `completed`). Added to implementation order and health system integration section.

### R3-4: Monitor, scanner, and stuck-task-detector are blind spots (Claude Important, Gemini Important)
**Assessment:** `hasPendingWork` in scanner, `VALID_TASK_STATUSES` in investigator-actions, and hanging invocation detection in stuck-task-detector all need `merge_pending`. Without this, the first responder triggers false wakeups, manual recovery is blocked, and stuck merge tasks go undetected.
**Decision:** ADOPT. Added all three to propagation table and health system integration section.

### R3-5: `approved_sha` has too many writers — remove rebase coder (Claude Important)
**Assessment:** The rebase coder is not a reviewer. Only reviewers should set `approved_sha`. The rebase reviewer re-records SHA at approval time, making the rebase coder's write redundant.
**Decision:** ADOPT. `approved_sha` writers reduced to two: initial reviewer and rebase reviewer.

### R3-6: Task selector does not need merge lock awareness (Claude Suggestion)
**Assessment:** The merge handler returns immediately if the lock is contended. Coupling the task selector to the merge lock adds complexity without benefit.
**Decision:** ADOPT. Removed task selector lock awareness. Contention handled by the handler.

### R3-7: Foreground loop should handle merge pipeline (Gemini Important)
**Assessment:** With a single status and single action type, the "daemon-only" restriction is unnecessary complexity. The merge lock provides serialization regardless of which process drives the loop. Filtering creates inconsistent behavior.
**Decision:** ADOPT. Foreground `loop` handles `merge` action the same as daemon mode.

### R3-8: Centralized `STATUS_SETS` object (Gemini Suggestion)
**Assessment:** Valuable broader refactor but out of scope for merge queue. With single-status approach, the blast radius is already small.
**Decision:** DEFER. Noted in Non-Goals as follow-up.

## Cross-Provider Review — Round 4 (Monitor Autonomy + Edge Cases)

**Reviewers:** 4 agents — Claude monitor-focused, Gemini monitor-focused, Claude edge-case-focused, Gemini edge-case-focused
**Date:** 2026-03-23
**Goal:** No critical/high/medium issues remaining — only lows resolvable during development. Make the monitor as universal and autonomous as possible.

### R4-1: Idempotency check for crash-after-push recovery (Claude Edge Critical, Gemini Edge High)
**Assessment:** If push succeeds but runner crashes before `markCompleted`, the task stays `merge_pending` but code is on main. Next attempt could fail ("no commits to merge") or duplicate work. Both reviewers independently flagged this.
**Decision:** ADOPT. Added `git merge-base --is-ancestor` check to `fetchAndPrepare`. If `approved_sha` already reachable from target HEAD → skip to `markCompleted`.

### R4-2: `findNextTask` uses explicit inclusion, not exclusion (Claude Edge Critical)
**Assessment:** Propagation table incorrectly claimed `findNextTask` uses exclusion (`NOT IN`). Actual code uses explicit status lists (`'review'`, `'in_progress'`, `'pending'`). `merge_pending` tasks would NEVER be selected without a new query block. This was the most dangerous inaccuracy in the design.
**Decision:** ADOPT. Fixed propagation table entry. `merge_pending` gets a new priority-level query block (highest priority — closest to completion).

### R4-3: New monitor anomaly types and FR actions (Claude Monitor Critical, Gemini Monitor Critical)
**Assessment:** Both monitor-focused reviewers converged on the same three anomaly types (`stale_merge_lock`, `stuck_merge_phase`, `disputed_task`) and two new FR actions (`release_merge_lock`, `reset_merge_phase`). Also: `UPDATABLE_TASK_FIELDS` needs merge columns, FR prompt needs merge context enrichment.
**Decision:** ADOPT. Full monitor autonomy section added to health system integration.

### R4-4: Sanitizer merge-role-aware recovery (Claude Monitor Critical, Gemini Monitor High)
**Assessment:** Sanitizer's generic `recoverOrphanedInvocation` would reset `merge_pending` tasks to `pending`, losing review approval. Must check invocation role (`merge`, `rebase_coder`, `rebase_reviewer`) and handle each correctly. Also: `shouldSkipInvocation` guard is too coarse-grained for non-lock-holding invocations.
**Decision:** ADOPT. Added per-role recovery paths to sanitizer section.

### R4-5: Rebase coder diff fence (Gemini Edge High)
**Assessment:** Without validation, LLM rebase coder could modify unrelated files (prompt injection, hallucination, scope creep). Rebase reviewer is not a guaranteed catch for subtle changes.
**Decision:** ADOPT. Added diff fence to `handleRebaseCoder` — validates only conflict-affected files modified, violations → `disputed`.

### R4-6: Busy-wait in `pushWithRetries` blocks heartbeats (Claude Edge Critical)
**Assessment:** `git-helpers.ts` lines 124-128 use synchronous busy-wait that blocks the event loop for up to 6.7 minutes. Heartbeat timers can't fire, causing stale lock reclamation during legitimate merges → potential data loss from concurrent merge attempts.
**Decision:** ADOPT. Added async backoff requirement to "What stays" table. `pushWithRetries` must use `setTimeout`/`await sleep` instead of busy-wait.

### R4-7: Stale merge_phase clearing on task reset (Gemini Monitor Medium)
**Assessment:** If FR or sanitizer resets a `merge_pending` task, stale `merge_phase` and `rebase_attempts` values persist, causing incorrect routing on re-entry.
**Decision:** ADOPT. Added clearing requirement to `markCompleted` contract and edge cases.

### R4-8: Push race loss soft cap (Claude Edge Medium)
**Assessment:** Without a cap, extreme contention (many concurrent tasks targeting same branch) causes infinite retry loops. A soft cap (default 20) provides a circuit breaker.
**Decision:** ADOPT. Added to `pushTargetBranch` contract.

### R4-9: `disputed` tasks invisible to monitor (Gemini Monitor Critical)
**Assessment:** No scanner query looks for `disputed` tasks. They accumulate silently with no visibility.
**Decision:** ADOPT. Added `disputed_task` warning anomaly to monitor anomaly types table.

### Deferred from Round 4

| Finding | Reason |
|---------|--------|
| SHA check missing from current `mergeToBase` code | Implementation detail — current code is being replaced |
| ff-only "invariant violation" error message | Being replaced by `attemptRebaseAndFastForward` |
| Multi-reviewer `approved_sha` race (tiny window) | Extremely narrow window, no practical impact |
| Stuck detector specific duration thresholds | Implementation detail — exact values tuned at dev time |
| Rebase rerun on DB failure after push | Subsumed by R4-1 idempotency check |
| Section done / follow-up eligibility for `merge_pending` | Already in propagation table (rows 10-11) |
| `reset_task` incompatible with merge pipeline | Addressed by R4-3 (`reset_merge_phase` action) |
| Infinite `query_db` loop guard for FR | Low severity — implementation detail for FR loop |

## Cross-Provider Review — Round 5 (Document Clarity + Implementation Planning)

**Reviewers:** Claude document reviewer, Gemini document reviewer, Claude implementation planner
**Date:** 2026-03-23
**Goal:** Ensure the document is clear and complete enough to implement without asking questions. Produce a definitive task list.

### R5-1: "Epoch-based" locking is wrong — `workspace_merge_locks` uses heartbeat (Claude Critical)
**Assessment:** The `workspace_merge_locks` table has `heartbeat_at`, not an `epoch` column. The epoch pattern exists only in `src/parallel/merge-lock.ts` which is being removed. Document was misleading throughout.
**Decision:** ADOPT. All references corrected to "heartbeat-based with TTL stale detection." Explicit note that `src/workspace/merge-lock.ts` (kept) is different from `src/parallel/merge-lock.ts` (removed).

### R5-2: `findNextTaskSkippingLocked` missing from propagation table (Claude Critical)
**Assessment:** `findNextTaskSkippingLocked` has the exact same priority structure as `findNextTask`. Both need the P0 block for `merge_pending`. Only `findNextTask` was listed.
**Decision:** ADOPT. Added to propagation table. Priority explicitly specified as P0 (before review).

### R5-3: `followUpEligibilityFilter` appears 6 times across 2 functions (Claude Critical)
**Assessment:** The filter exists in 3 query blocks in `findNextTask` and 3 in `findNextTaskSkippingLocked`. Propagation table only listed one location.
**Decision:** ADOPT. Updated propagation table entry with both function references and instance count.

### R5-4: `rebase_attempts` double-increment risk (Claude Important, Gemini Critical)
**Assessment:** Both reviewers independently flagged: `transitionToRebasing` increments, AND `handleRebaseReview` reject claims to increment. Double-counting bug if both fire. The intent is that `handleRebaseReview` reject calls `transitionToRebasing` (single increment point).
**Decision:** ADOPT. Clarified `handleRebaseReview` reject contract: "calls `transitionToRebasing`" instead of claiming to increment separately.

### R5-5: `handlePrepFailure` never specified (Claude Important, Gemini Important)
**Assessment:** `handleMergeAttempt` calls `handlePrepFailure` but no contract exists. SHA mismatch recovery path (return to `review`) is only in the edge cases table, not in a function contract.
**Decision:** ADOPT. Added `handlePrepFailure` contract with per-error-type behavior.

### R5-6: `fetchAndPrepare` pool slot state unspecified (Gemini Important)
**Assessment:** "Prepares pool slot for merge operation" is not actionable. Implementer needs to know exact git state.
**Decision:** ADOPT. Specified: target branch checked out, task branch fetched into local tracking ref.

### R5-7: `push_race_losses` not cleared in `markCompleted` (Claude Important)
**Decision:** ADOPT. Added to clearing list.

### R5-8: Phase 4b ordering — prerequisite listed after dependent (Claude Important)
**Decision:** ADOPT. Moved async backoff to Phase 0 (before everything else).

### R5-9: Pool slot claiming mechanism not specified (Claude Important)
**Decision:** ADOPT. Added "Pool slot claiming" paragraph to runtime environment section.

### Deferred from Round 5

| Finding | Reason |
|---------|--------|
| Rebase coder prompt template details | Implementation detail — prompt structure follows existing patterns |
| `handleRebaseCoder` build/test config location | Implementation detail — follows existing config patterns |
| `partial` status inconsistency in wakeup-checks | Pre-existing issue, out of scope |
| `config.git.branch` not in `schema.ts` | Fixed reference, but full config shape is implementation detail |
