# Merge Queue — Implementation Plan

> Design doc: [docs/plans/merge-queue.md](./merge-queue.md)
> This document is the definitive task list and flight-ready checklist for implementing the merge queue pipeline. Every task maps to a specific change in the design doc. Nothing ships without every checkbox ticked.

---

## Phase 0: Prerequisite Fixes

### 0.1 Replace `pushWithRetries` synchronous busy-wait with async backoff

**Files:** `src/git/git-helpers.ts`
**Design ref:** "What stays" table, R4-6
**Why first:** The busy-wait (lines 124-128) blocks the Node.js event loop for up to 6.7 min during retry backoff. Heartbeat timers cannot fire, causing stale lock reclamation during legitimate merges. Must ship before merge gate relies on heartbeat-based locking.

**Changes:**
- Replace `while (Date.now() < deadline) {}` busy-wait with `await new Promise(r => setTimeout(r, delay))`
- Verify function signature remains `async`
- Existing callers unaffected (already `await`-ing)

**Tests:** Existing `pushWithRetries` tests still pass. Optionally add test verifying event loop is not blocked during retry delay.

### 0.2 Add tryOnce mode to `acquireWorkspaceMergeLock`

**Files:** `src/workspace/merge-lock.ts`
**Design ref:** R6-2, `acquireMergeLock` contract
**Why first:** The merge handler needs non-blocking lock acquisition. Current `acquireWorkspaceMergeLock` (lines 80-84) has a busy-wait polling loop that blocks the event loop.

**Changes:**
- Add `tryOnce?: boolean` parameter to `acquireWorkspaceMergeLock`
- When `tryOnce = true`: single acquisition attempt, return `true`/`false` immediately (no polling)
- Reduce `STALE_LOCK_TTL_MS` to 90 seconds for merge queue use (merge gate takes seconds, not minutes)
- Existing callers unaffected (default behavior preserved)

**Tests:** Test tryOnce returns false immediately when lock is held. Test stale lock detection at 90s threshold.

---

## Phase 1: Push Restructuring

### 1.1 Implement `pushTaskBranchForDurability`

**Files:** `src/orchestrator/loop-phases-coder-decision.ts`, `src/git/git-helpers.ts`
**Design ref:** Phase 1 contract, `pushTaskBranchForDurability`

**Changes:**
- Create `pushTaskBranchForDurability(db, task, slotPath, config)` function
- Pushes `steroids/task-<taskId>` to `config.git.remote` with retry (3 attempts, async backoff)
- Does NOT set `approved_sha`
- Success: transitions task to `review`
- Failure: transitions to `blocked_error` (infrastructure error)
- NEVER transitions to `pending` or `skipped` on push failure
- Called from `submitForReviewWithDurableRef` BEFORE the status transitions to `review`

**Tests:** Test successful push → `review`. Test failed push → `blocked_error`. Test that `approved_sha` is NOT set.

### 1.2 Decouple `cleanupPoolSlot` from Git push operations

**Files:** `src/orchestrator/orchestrator-loop.ts`, `src/workspace/pool.ts`
**Design ref:** Phase 1 step 3

**Changes:**
- Remove all push logic from `cleanupPoolSlot`
- `cleanupPoolSlot` now ONLY releases the workspace slot
- `cleanupPoolSlot` no longer modifies task status

**Tests:** Test that `cleanupPoolSlot` does not perform a push. Test that task status is unchanged after `cleanupPoolSlot`.

### 1.3 Tests for push restructuring

**Files:** `tests/merge-queue-push.test.ts` (new)
**Design ref:** Phase 1

**Tests:**
- Successful coder phase → task branch pushed → status = `review`
- Failed push during coder-to-review → status = `blocked_error`
- `cleanupPoolSlot` no longer pushes
- Push failure does NOT produce `pending` or `skipped` status

---

## Phase 2+3: Decouple Review + Merge Gate (Atomic)

> All tasks in this phase ship together. If `merge_pending` exists without a processor, tasks strand.

### 2.1 DB migration — new task columns

**Files:** `migrations/NNN_add_merge_queue_fields.sql` (new), `migrations/manifest.json`
**Design ref:** "New task status" section

**Changes:**
- Add columns: `merge_phase TEXT`, `approved_sha TEXT`, `rebase_attempts INTEGER DEFAULT 0`
- Update `manifest.json` with new migration
- Verify migration runs on existing databases

**Tests:** Migration applies cleanly. New columns are nullable/defaulted correctly.

### 2.2 Define `merge_pending` status and types

**Files:** `src/database/queries.ts`, `src/orchestrator/task-selector.ts`
**Design ref:** "New task status" section, propagation table rows

**Changes:**
- Add `'merge_pending'` to `TaskStatus` type/enum in `queries.ts`
- Add `merge_pending` entry to `STATUS_MARKERS` constant
- Add `| 'merge'` to `SelectedTask.action` type in `task-selector.ts`

**Tests:** TypeScript compiles. Status marker renders correctly.

### 2.3 Extend invocation logger role whitelist

**Files:** `src/providers/invocation-logger.ts`
**Design ref:** R6-9

**Changes:**
- Line 353-355: extend `canDbLog` check to include `role === 'merge'`
- Without this, merge invocations are invisible to the health system

**Tests:** Verify `canDbLog` returns true for role `merge` with valid `taskId` and `projectPath`.

### 2.4 Update status propagation — all call sites

**Files:** See propagation table in design doc (21 rows)
**Design ref:** "Status propagation table"

Each call site below must be updated. Checked individually:

#### 2.4.1 `hasPendingOrInProgressWork`
**File:** `task-selector.ts:62`
**Change:** Add `'merge_pending'` to `IN (...)` list

#### 2.4.2 `selectNextTaskWithWait` exit condition
**File:** `task-selector.ts:504`
**Change:** Add `merge_pending` to active count check

#### 2.4.3 `selectTaskBatch` active count
**File:** `task-selector.ts:160`
**Change:** Add `'merge_pending'` to `IN ('in_progress', 'review')` active count

#### 2.4.4 `findNextTask` — new P0 priority block
**File:** `queries.ts:1350`
**Change:** Add new priority block for `merge_pending` with `action: 'merge'` — BEFORE the review block (highest priority, closest to completion). Uses explicit inclusion.

#### 2.4.5 `findNextTaskSkippingLocked` — new P0 priority block
**File:** `task-selector.ts:363`
**Change:** Same P0 block as 2.4.4

#### 2.4.6 `selectNextTaskWithLock` routing
**File:** `task-selector.ts`
**Change:** Add `merge_pending -> merge` to status-to-action routing

#### 2.4.7 `getTaskCounts`
**File:** `task-selector.ts:246`
**Change:** Add `merge_pending: number` to return type and COUNT query

#### 2.4.8 Wakeup pending work check
**File:** `wakeup-checks.ts:57`
**Change:** Add `'merge_pending'` to `IN (...)` list

#### 2.4.9 `getSectionCounts`
**File:** `section-pr.ts:37`
**Change:** Add `'merge_pending'` to `IN (...)` list

#### 2.4.10 Section "done" check
**File:** `tasks.ts:1111`
**Change:** Add `'merge_pending'` to active status array

#### 2.4.11 `followUpEligibilityFilter` (6 instances)
**File:** `queries.ts:1360-1368` + `task-selector.ts:372-381`
**Change:** Add `'merge_pending'` — 3 instances in `findNextTask`, 3 in `findNextTaskSkippingLocked`

#### 2.4.12 `buildParallelRunPlan`
**File:** `runners-parallel.ts:125`
**Change:** Uses exclusion (`NOT IN`) — verify `merge_pending` is correctly included as active work (no change needed if exclusion-based)

#### 2.4.13 `scanHighInvocations`
**File:** `scanner-queries.ts:67`
**Change:** Uses exclusion — verify correct (no change needed)

#### 2.4.14 `hasPendingWork` (scanner)
**File:** `scanner.ts:148`
**Change:** Add `'merge_pending'` to `IN (...)` list

#### 2.4.15 `VALID_TASK_STATUSES` (FR)
**File:** `investigator-actions.ts:24`
**Change:** Add `'merge_pending'` to whitelist

**Tests:** For each call site, verify the query/check includes `merge_pending`. TypeScript compiles after all changes.

### 2.5 Add dispatch handlers for `merge` action

**Files:** `src/orchestrator/orchestrator-loop.ts`, `src/loop.ts`
**Design ref:** Implementation order step 9

**Changes:**
- Both loops: add `else if (selectedTask.action === 'merge')` block
- Block calls `processMergeQueue(db, task, config)` (from new module)

**Tests:** Verify dispatch routing for `merge` action reaches `processMergeQueue`.

### 2.6 Modify reviewer approval to transition to `merge_pending`

**Files:** `src/orchestrator/loop-phases-reviewer.ts`
**Design ref:** Phase 2 contract, `transitionAfterReviewerApproval`

**Changes:**
- On approval: fetch current HEAD of remote `steroids/task-<taskId>` → record as `task.approved_sha`
- Transition task to `merge_pending` with `merge_phase = 'queued'`
- Remove `mergeToBase` call entirely from reviewer phase

**Tests:** Test reviewer approval → status = `merge_pending`, `merge_phase = 'queued'`, `approved_sha` set. Test `mergeToBase` is not called.

### 2.7 Implement merge gate module — `processMergeQueue`

**Files:** `src/orchestrator/merge-queue.ts` (new)
**Design ref:** "Pipeline overview", all Phase 3 step contracts

**Changes:**
- Create `src/orchestrator/merge-queue.ts`
- Export `processMergeQueue(db, task, config)` — routes via `task.merge_phase`:
  - `queued` → `handleMergeAttempt`
  - `rebasing` → stub (Phase 4)
  - `rebase_review` → stub (Phase 4)
- Implement `handleMergeAttempt`:
  - `acquireMergeLock` (tryOnce) — return immediately if contended
  - `fetchAndPrepare` — fetch target + task branch, idempotency check, SHA verify
  - `handlePrepFailure` — per-error-type handling (sha_mismatch → review, transient → retry, permanent → blocked_error)
  - `attemptRebaseAndFastForward` — ff-only first, then deterministic rebase, then conflict detection
  - `pushTargetBranch` — push with race loss detection (transient → retry, permanent → blocked_error)
  - `cleanupTaskBranch` — delete remote task branch (non-fatal)
  - `markCompleted` — status → completed, clear merge columns
- `try/finally` ensures `releaseMergeLock` always called

**Tests:** See 2.11 for comprehensive test coverage.

### 2.8 Fix sanitizer merge lock table reference

**Files:** `src/runners/wakeup-sanitise.ts`
**Design ref:** R6-8

**Changes:**
- Lines 131-143: replace `merge_locks` query (project DB) with `workspace_merge_locks` query (global DB)
- Use `heartbeat_at` + TTL stale detection instead of `expires_at`
- Pass global DB reference to the sanitizer function

**Tests:** Test that `hasActiveMergeLock` correctly detects locks in global DB. Test stale detection works with heartbeat_at.

### 2.9 Fix wakeup sanitizer recovery for merge pipeline

**Files:** `src/runners/wakeup-sanitise-recovery.ts`, `src/runners/wakeup-sanitise.ts`
**Design ref:** R6-7, R3-3, health system integration

**Changes:**
- **Reviewer-approval recovery** (lines 133-157): on recovered approve token → `merge_pending` with `merge_phase = 'queued'` and `approved_sha` (not `completed`)
- **Generic recovery status filter** (lines 201-206): extend `WHERE status = 'in_progress'` to include `OR status = 'merge_pending'`
- **Basic merge-role recovery**: for `merge_pending` tasks with orphaned `merge` invocation → reset `merge_phase = 'queued'`, release merge lock if held
- **Disputed task recovery** (lines 230-268): clear merge columns in the UPDATE: `merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0`

**Tests:** Test reviewer-approval recovery → `merge_pending`. Test generic recovery handles `merge_pending` tasks. Test disputed recovery clears merge columns.

### 2.10 Fix FR `reset_task` and update FR fields

**Files:** `src/monitor/investigator-actions.ts`
**Design ref:** R6-12, R4-3

**Changes:**
- `UPDATABLE_TASK_FIELDS`: add `'merge_phase'`, `'approved_sha'`, `'rebase_attempts'`
- `reset_task` (lines 64-74): add `merge_phase = NULL, approved_sha = NULL, rebase_attempts = 0` to the UPDATE
- Add new actions: `release_merge_lock`, `reset_merge_phase`
- New anomaly types in scanner: `stale_merge_lock`, `stuck_merge_phase`, `disputed_task`

**Tests:** Test `reset_task` clears merge columns. Test new FR actions execute correctly.

### 2.11 Update stuck-task-detector for merge pipeline

**Files:** `src/health/stuck-task-detector.ts`
**Design ref:** R6-10, R6-13

**Changes:**
- Orphan detection (lines 180, 216): extend role join to handle `merge_pending` status with merge roles
- Hanging invocation query (line 339): add `'merge_pending'` to status IN list
- Phase-aware thresholds: `merge_pending/queued` → ~5 min, `rebasing`/`rebase_review` → standard LLM timeout

**Tests:** Test orphan detection finds `merge_pending` tasks with `merge` role invocations. Test phase-aware thresholds.

### 2.12 Comprehensive merge gate tests

**Files:** `tests/merge-queue-gate.test.ts` (new)
**Design ref:** All Phase 2+3 contracts

**Tests:**
- Happy path: approved task → `merge_pending` → merge → `completed`, code on target branch
- SHA mismatch: task branch modified after approval → returns to `review` with cleared merge state
- Crash recovery: `approved_sha` already in target → skip to `markCompleted`
- Push race loss: non-ff push rejection → stays `merge_pending/queued` for retry
- Lock contention: second merge attempt returns immediately, task retried
- Transient fetch failure: no status change, retry next iteration
- Transient push failure: no status change, retry next iteration
- Permanent failure: → `blocked_error`

---

## Phase 4: Rebase Cycle

### 4.1 Extend invocation logger for rebase roles

**Files:** `src/providers/invocation-logger.ts`
**Design ref:** R6-9 (Phase 4 portion)

**Changes:**
- Extend `canDbLog` whitelist to include `'rebase_coder'`, `'rebase_reviewer'`

**Tests:** Verify `canDbLog` returns true for rebase roles.

### 4.2 Implement `transitionToRebasing`

**Files:** `src/orchestrator/merge-queue.ts`
**Design ref:** `transitionToRebasing` contract

**Changes:**
- Sets `merge_phase = 'rebasing'`
- Increments `rebase_attempts` (single increment point)
- If `rebase_attempts >= maxRebaseAttempts` (default 3): task → `disputed`
- Records divergence reason for audit trail

**Tests:** Test increment on each call. Test cap escalation to `disputed`. Test audit trail entry.

### 4.3 Implement `handleRebaseCoder`

**Files:** `src/orchestrator/merge-queue.ts`, `src/prompts/rebase-coder.ts` (new)
**Design ref:** `handleRebaseCoder` contract

**Changes:**
- Claims pool slot
- Checks out task branch, resets to `task.approved_sha` (`git reset --hard`)
- Captures conflict file list: start `git rebase`, record files from `git diff --name-only --diff-filter=U`, abort
- Spawns LLM rebase coder with rebase-specific prompt
- After LLM: validates diff fence (only conflict-affected files modified)
- Force-pushes updated task branch (`--force-with-lease`)
- Success: `merge_phase = 'rebase_review'`
- LLM failure / diff fence violation: → `disputed`
- Infrastructure failure: → `blocked_error`
- Does NOT set `approved_sha`

**Tests:** Test successful rebase → `rebase_review`. Test diff fence violation → `disputed`. Test LLM failure → `disputed`. Test branch reset to `approved_sha` before each attempt.

### 4.4 Implement `handleRebaseReview`

**Files:** `src/orchestrator/merge-queue.ts`
**Design ref:** `handleRebaseReview` contract

**Changes:**
- Claims pool slot
- Runs existing reviewer on rebased task branch (lighter review focused on conflict resolution)
- Approve: re-records `task.approved_sha` from remote HEAD, sets `merge_phase = 'queued'`
- Reject: calls `transitionToRebasing` (handles increment + cap check)

**Tests:** Test approval → `queued` with new `approved_sha`. Test rejection → `transitionToRebasing` called. Test rejection at cap → `disputed`.

### 4.5 Add rebase-role recovery to sanitizer

**Files:** `src/runners/wakeup-sanitise-recovery.ts`
**Design ref:** R4-4, implementation order step 26

**Changes:**
- Orphaned `rebase_coder`: reset `merge_phase = 'queued'` (NOT `pending` — preserves review approval)
- Orphaned `rebase_reviewer` with approve token: re-record `approved_sha`, `merge_phase = 'queued'`
- Orphaned `rebase_reviewer` with reject token: `merge_phase = 'rebasing'`, increment `rebase_attempts`
- `shouldSkipInvocation`: do not block recovery of `rebase_coder`/`rebase_reviewer` (they don't hold merge lock)

**Tests:** Test each orphaned role recovery path. Test `shouldSkipInvocation` allows rebase role recovery.

### 4.6 Update monitor for merge anomalies

**Files:** `src/monitor/scanner.ts`, `src/monitor/investigator-actions.ts`, `src/monitor/investigator-prompt.ts`
**Design ref:** R4-3

**Changes:**
- New anomaly types: `stale_merge_lock`, `stuck_merge_phase`, `disputed_task`
- Scanner queries: detect stale lock (>5 min), stuck phase (>90 min for rebase, >15 min for queued), disputed tasks
- FR actions: `release_merge_lock`, `reset_merge_phase`
- FR prompt enrichment: include `merge_phase`, `rebase_attempts`, `approved_sha`, merge lock state

**Tests:** Test anomaly detection triggers. Test FR actions execute correctly.

### 4.7 Rebase cycle tests

**Files:** `tests/merge-queue-rebase.test.ts` (new)
**Design ref:** Phase 4 contracts

**Tests:**
- Merge conflicts → rebase cycle: `rebasing` → `rebase_review` → `queued` → `completed`
- Rebase review rejection → increment + retry
- Cap reached → `disputed`
- Diff fence violation → `disputed`
- Branch reset to `approved_sha` before each rebase attempt
- Orphaned rebase invocation recovery

---

## Phase 5: Cleanup

### 5.1 Remove `autoMergeOnCompletion` from daemon

**Files:** `src/orchestrator/daemon.ts`
**Design ref:** Implementation order step 27

**Changes:**
- Remove `autoMergeOnCompletion` call and all related logic (lines ~298-381)
- Remove any imports only used by this function

**Tests:** Build succeeds. Existing tests pass.

### 5.2 Remove parallel merge pipeline files

**Files:** All `src/parallel/merge-*.ts`, `src/parallel/merge-conflict*.ts`
**Design ref:** "What gets removed" table, implementation order step 28

**Changes:**
- Delete: `merge-git.ts`, `merge-process.ts`, `merge-sealing.ts`, `merge-workspace.ts`, `merge-commit-checks.ts`, `merge-validation.ts`, `merge-progress.ts`, `merge-errors.ts`, `merge-lock.ts`, `merge-conflict*.ts`
- Remove `createIntegrationWorkspace` from `clone.ts` (lines 449-499)
- Remove `runParallelMerge` and its imports
- Do NOT delete `src/workspace/merge-lock.ts` (reused by merge queue)

**Tests:** Build succeeds. No import errors.

### 5.3 Remove workstream branch push from coder decision

**Files:** `src/orchestrator/loop-phases-coder-decision.ts`
**Design ref:** Implementation order step 29

**Changes:**
- Remove workstream branch push logic (lines ~230-246)
- Task branches only — no workstream branches

**Tests:** Build succeeds. Existing coder tests pass.

### 5.4 Remove remaining dead code

**Files:** `src/workspace/git-lifecycle-merge.ts`, any remaining unused parallel modules
**Design ref:** Implementation order step 30

**Changes:**
- Delete `git-lifecycle-merge.ts` if it exists and is unused
- Scan for any other imports referencing removed modules
- Clean up any orphaned exports

**Tests:** Build succeeds. `npm test` passes.

### 5.5 Final verification

**Files:** All test suites
**Design ref:** Final gate

**Tests:**
- `npm run build` — zero TypeScript errors
- `npm test` — all tests pass
- No references to removed modules remain
- `merge_pending` status flows correctly through the entire pipeline

---

## Flight-Ready Checklist

> Every box must be ticked before the merge queue is considered complete. Review this checklist against the implementation at each phase boundary.

### Phase 0: Prerequisites
- [ ] **0.1** `pushWithRetries` uses async backoff (no synchronous busy-wait)
- [ ] **0.2** `acquireWorkspaceMergeLock` supports tryOnce mode
- [ ] **0.2** Stale lock TTL reduced to 90s for merge queue use

### Phase 1: Push Restructuring
- [ ] **1.1** `pushTaskBranchForDurability` function exists and is called from coder decision
- [ ] **1.1** Push success → task status = `review`
- [ ] **1.1** Push failure → task status = `blocked_error` (never `pending`/`skipped`)
- [ ] **1.1** `approved_sha` is NOT set during push
- [ ] **1.2** `cleanupPoolSlot` performs NO git push
- [ ] **1.2** `cleanupPoolSlot` does NOT modify task status
- [ ] **1.3** Tests written and passing

### Phase 2+3: Merge Gate (ATOMIC — all boxes must be ticked simultaneously)

**Schema & Types**
- [ ] **2.1** Migration adds `merge_phase TEXT`, `approved_sha TEXT`, `rebase_attempts INTEGER DEFAULT 0`
- [ ] **2.1** Migration runs on fresh and existing databases
- [ ] **2.2** `TaskStatus` type includes `'merge_pending'`
- [ ] **2.2** `STATUS_MARKERS` has `merge_pending` entry
- [ ] **2.2** `SelectedTask.action` includes `'merge'`

**Invocation Logging**
- [ ] **2.3** `canDbLog` returns true for `role === 'merge'`
- [ ] **2.3** Merge invocations appear in `task_invocations` table

**Status Propagation (21 call sites)**
- [ ] **2.4.1** `hasPendingOrInProgressWork` includes `merge_pending`
- [ ] **2.4.2** `selectNextTaskWithWait` exit includes `merge_pending` count
- [ ] **2.4.3** `selectTaskBatch` active count includes `merge_pending`
- [ ] **2.4.4** `findNextTask` has P0 block for `merge_pending` → action `merge`
- [ ] **2.4.5** `findNextTaskSkippingLocked` has P0 block for `merge_pending` → action `merge`
- [ ] **2.4.6** `selectNextTaskWithLock` routes `merge_pending` → `merge`
- [ ] **2.4.7** `getTaskCounts` returns `merge_pending` count
- [ ] **2.4.8** Wakeup pending work check includes `merge_pending`
- [ ] **2.4.9** `getSectionCounts` includes `merge_pending`
- [ ] **2.4.10** Section "done" check includes `merge_pending`
- [ ] **2.4.11** `followUpEligibilityFilter` — all 6 instances include `merge_pending`
- [ ] **2.4.12** `buildParallelRunPlan` correctly includes `merge_pending` as active (exclusion-based — verify)
- [ ] **2.4.13** `scanHighInvocations` correctly includes `merge_pending` (exclusion-based — verify)
- [ ] **2.4.14** `hasPendingWork` (scanner) includes `merge_pending`
- [ ] **2.4.15** `VALID_TASK_STATUSES` (FR) includes `merge_pending`

**Dispatch**
- [ ] **2.5** `orchestrator-loop.ts` dispatches `merge` action to `processMergeQueue`
- [ ] **2.5** `loop.ts` (foreground) dispatches `merge` action to `processMergeQueue`

**Reviewer Transition**
- [ ] **2.6** Reviewer approval → `merge_pending` with `merge_phase = 'queued'`
- [ ] **2.6** Reviewer approval records `approved_sha` from remote HEAD
- [ ] **2.6** `mergeToBase` completely removed from reviewer phase
- [ ] **2.6** Reviewer rejection → `pending` (existing behavior unchanged)

**Merge Gate Module**
- [ ] **2.7** `src/orchestrator/merge-queue.ts` exists
- [ ] **2.7** `processMergeQueue` routes by `merge_phase`
- [ ] **2.7** `handleMergeAttempt` acquires lock (tryOnce)
- [ ] **2.7** Lock contention → return immediately, retry next iteration
- [ ] **2.7** `fetchAndPrepare` — idempotency check (`merge-base --is-ancestor`)
- [ ] **2.7** `fetchAndPrepare` — SHA verification (branch HEAD = `approved_sha`)
- [ ] **2.7** SHA mismatch → `review` with cleared merge state
- [ ] **2.7** Transient fetch failure → retry next iteration (no `blocked_error`)
- [ ] **2.7** Permanent fetch failure → `blocked_error`
- [ ] **2.7** `attemptRebaseAndFastForward` — ff-only first, then deterministic rebase
- [ ] **2.7** Deterministic rebase succeeds → ff-only → push
- [ ] **2.7** Deterministic rebase fails (conflicts) → `transitionToRebasing` (stub in Phase 2+3, returns `disputed`)
- [ ] **2.7** `pushTargetBranch` — race loss → retry next iteration
- [ ] **2.7** `pushTargetBranch` — transient failure → retry next iteration
- [ ] **2.7** `pushTargetBranch` — permanent failure → `blocked_error`
- [ ] **2.7** `cleanupTaskBranch` — non-fatal failure
- [ ] **2.7** `markCompleted` — clears `merge_phase`, `rebase_attempts`, `approved_sha`
- [ ] **2.7** `releaseMergeLock` always called (try/finally)

**Sanitizer Fixes**
- [ ] **2.8** Sanitizer queries `workspace_merge_locks` in global DB (not `merge_locks` in project DB)
- [ ] **2.8** Lock detection uses `heartbeat_at` + TTL (not `expires_at`)
- [ ] **2.9** Reviewer-approval recovery → `merge_pending` (not `completed`)
- [ ] **2.9** Generic recovery handles `merge_pending` tasks
- [ ] **2.9** Basic `merge` role recovery: reset `merge_phase = 'queued'`
- [ ] **2.9** Disputed task recovery clears merge columns

**FR Fixes**
- [ ] **2.10** `UPDATABLE_TASK_FIELDS` includes merge columns
- [ ] **2.10** `reset_task` clears merge columns

**Health System**
- [ ] **2.11** Stuck-task-detector orphan queries handle `merge_pending` + merge roles
- [ ] **2.11** Hanging invocation query includes `merge_pending`
- [ ] **2.11** Phase-aware thresholds for `merge_pending` tasks

**Tests**
- [ ] **2.12** Happy path test passing
- [ ] **2.12** SHA mismatch test passing
- [ ] **2.12** Crash recovery test passing
- [ ] **2.12** Push race loss test passing
- [ ] **2.12** Lock contention test passing
- [ ] **2.12** Transient failure retry tests passing

### Phase 4: Rebase Cycle
- [ ] **4.1** `canDbLog` includes `rebase_coder`, `rebase_reviewer`
- [ ] **4.2** `transitionToRebasing` increments counter, checks cap
- [ ] **4.2** Cap exceeded → `disputed`
- [ ] **4.3** `handleRebaseCoder` resets branch to `approved_sha` before rebase
- [ ] **4.3** Conflict file list captured before LLM runs
- [ ] **4.3** Diff fence validated after LLM completes
- [ ] **4.3** Diff fence violation → `disputed`
- [ ] **4.3** LLM failure → `disputed`
- [ ] **4.3** Success → force-push + `merge_phase = 'rebase_review'`
- [ ] **4.3** Does NOT set `approved_sha`
- [ ] **4.4** Rebase review approve → re-record `approved_sha`, `merge_phase = 'queued'`
- [ ] **4.4** Rebase review reject → `transitionToRebasing`
- [ ] **4.5** Orphaned `rebase_coder` → `merge_phase = 'queued'`
- [ ] **4.5** Orphaned `rebase_reviewer` approve → `approved_sha` + `merge_phase = 'queued'`
- [ ] **4.5** Orphaned `rebase_reviewer` reject → `rebasing` + increment counter
- [ ] **4.5** `shouldSkipInvocation` allows rebase role recovery
- [ ] **4.6** Scanner detects `stale_merge_lock`, `stuck_merge_phase`, `disputed_task`
- [ ] **4.6** FR can execute `release_merge_lock`, `reset_merge_phase`
- [ ] **4.7** All rebase cycle tests passing

### Phase 5: Cleanup
- [ ] **5.1** `autoMergeOnCompletion` removed from daemon
- [ ] **5.2** All `src/parallel/merge-*.ts` files deleted
- [ ] **5.2** `createIntegrationWorkspace` removed
- [ ] **5.2** `src/workspace/merge-lock.ts` is NOT deleted (still used)
- [ ] **5.3** Workstream branch push removed from coder decision
- [ ] **5.4** No dead imports or references to removed modules
- [ ] **5.5** `npm run build` — zero errors
- [ ] **5.5** `npm test` — all tests pass
- [ ] **5.5** End-to-end: approved task → merge_pending → merge → completed → code on target branch