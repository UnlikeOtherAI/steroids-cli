# Workspace Reset Death Spiral — Root Cause Analysis

**Date**: 2026-03-06
**Status**: Final — 14 adversarial reviews across 7 rounds (Claude + Codex). No unaddressed MEDIUM+ findings.
**Affected project**: Technician (`/System/Volumes/Data/.internal/projects/Projects/Technician`)

---

## 1. Problem Statement

Three tasks in the Technician project all failed with maximum rejections (15), wasting significant compute. The coder successfully implemented the required work in early cycles, reviewers approved it, but the work was **destroyed between coder iterations**, leading to a death spiral where:

- The coder rebuilds files each turn, but they vanish on the next turn
- Reviewers see an empty workspace and reject
- The coder files disputes ("workspace mismatch"), but the orchestrator ignores them
- This cycle repeats until the 15-rejection cap is hit

**Affected tasks:**

| Task ID | Title | Rejections | Approvals before spiral |
|---------|-------|------------|------------------------|
| `4eab4e13` | Initialize Node.js backend | 15 | Approved by both reviewers in cycle 2 |
| `be98d32e` | Initialize KMP project | 15 | Multiple partial approvals |
| `d76baa67` | Docker Compose + Dockerfile | 1 (failed) | Approved by every reviewer in every cycle |

---

## 2. Current Behavior — The Exact Failure Sequence

### 2.1 The reflog evidence

The task branch reflog for `steroids/task-4eab4e13` shows the destruction pattern:

```
8e77d5fc branch: Reset to HEAD           ← branch force-reset to base
b10e0a40 commit: feat: implement ...     ← coder's work committed
8e77d5fc branch: Reset to HEAD           ← destroyed again
2851b66f commit: feat: implement ...     ← coder rebuilt it
8e77d5fc branch: Reset to HEAD           ← destroyed again
... (repeats 9 times)
```

Every coder commit is followed by a force-reset of the task branch back to the initial `8e77d5fc` commit (which contains only documentation).

### 2.2 The code path that causes this

**File**: `src/workspace/git-lifecycle.ts`, function `prepareForTask()`

The function is called at the start of every **pooled** coder phase — both `start` and `resume` actions — at `src/commands/loop-phases-coder.ts:82`. It unconditionally:

1. **Line 150**: `git checkout <baseBranch>` — switches to the resolved base branch
2. **Line 151**: `git reset --hard <baseRef>` — hard-resets to `origin/<baseBranch>` (or local `baseBranch` in local-only mode)
3. **Line 154**: `git clean -fd -e .steroids` — removes untracked files (preserving `.steroids` config)
4. **Line 208**: `git checkout -B steroids/task-<id>` — the `-B` flag **force-recreates** the task branch at the current HEAD

Note: this is a pool-mode-only code path. The legacy non-pool path does not call `prepareForTask()`. Both `prepareForTask()` (via `resolveBaseBranch()` at line 131) and `mergeToBase()` (via `slot.base_branch` at line 289) use the resolved branch — not hardcoded `main`. The Technician project's resolved base branch was `main`.

### 2.3 The timeline for task `4eab4e13` (Node.js backend) — from audit log

| Audit ID | Transition | Details |
|----------|------------|---------|
| 38 | pending → in_progress | Coder starts |
| 55 | in_progress → review | Coder commits `7d5de07d`, submits for review |
| 58 | review → review | Reviewers decide: REJECT (env loading, one approve one reject) |
| 59 | review → in_progress | Arbitration: REJECT with specific fix needed |
| 62-63 | in_progress → review | Coder fixes issue, commits `6bc8fd8d` |
| **64** | review → review | **Both reviewers APPROVE** (direct multi-review resolution) |
| **65** | **review → pending** | **`Merge failure: git fetch origin main — fatal: couldn't find remote ref main`** |
| 66 | pending → in_progress | Task re-selected, `prepareForTask()` destroys branch |
| 72-73 | in_progress → review | Coder re-creates files, commits `3e49d4e7` |
| **74** | review → review | **Both reviewers APPROVE again** |
| **75** | **review → pending** | **Same merge failure: `couldn't find remote ref main`** |
| ... | ... | Pattern repeats: approve → merge fail → pending → branch destroyed |
| **84-85** | review → pending | **4th consecutive: approve → merge failure** |
| 97 | in_progress → review | Coder now submitting `8e77d5fc` (the base commit — workspace was empty) |
| 98 | review → review | **Both reviewers reject — files don't exist** |
| 99 | review → in_progress | Arbitration: REJECT, all files missing |
| ... | ... | Death spiral: coder can't persist files, reviewers see empty workspace |
| (dispute) | | Coder files dispute: "workspace mismatch" |

**Key insight**: The first 4 cycles all had dual APPROVE, but every merge attempt failed with the same infrastructure error. After repeated merge failures + branch resets, the coder could no longer persist work and the task entered the rejection death spiral.

### 2.4 The Docker task anomaly

Task `d76baa67` (Docker) was approved by every reviewer in every cycle (20+ approvals) with `rejection_count=1`. The merge failure path calls `returnTaskToPending()`, which does NOT increment `rejection_count`. Additionally, `failure_count` is shared between merge failures and provider invocation failures (see ROOT CAUSE 2) and is reset to 0 by `clearTaskFailureCount()` during the coder phase (line 180) and reviewer phase (lines 205, 261), so the existing `MAX_FAILURE_COUNT=5` cap is **never reached**.

### 2.5 Claude session resume failures

Every Claude reviewer invocation fails to resume the previous session because the isolated HOME directory (created at `claude.ts:225`) is deleted on process exit (`claude.ts:338`). Only auth/config files are symlinked — not the session store. This guarantees failure on every `--resume` attempt.

```
250|reviewer|claude|failed|Failed to resume Claude session 38fb0065-ddab-4e3c-b824-cdd1ded74f43
251|reviewer|claude|completed|1  ← fresh session succeeds
```

---

## 3. Root Causes

The incident has three independent defects. The first is the trigger; the second and third are why the system couldn't recover:

```
TRIGGER:  Missing remote base branch → merge always fails
BUG 1:   failure_count cap defeated → infinite retry loop (any merge failure, not just this one)
BUG 2:   prepareForTask() destroys task branch on every re-entry → all prior work lost
```

### ROOT CAUSE 1: Merge fails because remote base branch doesn't exist (TRIGGER)

The audit log reveals the exact error:

```
Merge failure (attempt 1/5): Unexpected error: Command failed: git fetch origin main
fatal: couldn't find remote ref main
```

**Evidence**:
- `git ls-remote origin --heads` returns **empty** — the remote GitHub repo has no branches
- The source project has `main` only locally — it was never pushed to origin
- `mergeToBase()` at `git-lifecycle.ts:323` calls `git fetch origin <baseBranch>` without `tolerateFailure`, throws an exception caught at line 438

### ROOT CAUSE 2: `failure_count` cap is defeated by `clearTaskFailureCount` (CRITICAL — SYSTEMIC)

`merge-pipeline.ts` has `MAX_FAILURE_COUNT = 5` and `handleMergeFailure()` calls `incrementTaskFailureCount()`. But this cap **can never be reached** because:

1. Merge fails → `failure_count` incremented to 1
2. `returnTaskToPending()` → task goes to `pending`
3. Coder runs → `clearTaskFailureCount()` at `loop-phases-coder.ts:180` → `failure_count` reset to 0
4. Reviewers approve → `clearTaskFailureCount()` at `loop-phases-reviewer.ts:205` → `failure_count` still 0
5. Merge fails again → `failure_count` incremented to 1
6. Repeat forever — cap of 5 never reached

**Important**: `failure_count` is a **shared counter** used by three increment call sites:
- `merge-pipeline.ts:72` — merge failures (`handleMergeFailure`)
- `loop-phases-helpers.ts:215` — provider invocation failures (`handleProviderInvocationFailure`)
- `orchestrator-loop.ts:649` — batch provider failures (legacy orchestrator)

The `clearTaskFailureCount()` calls at `loop-phases-coder.ts:180` and `loop-phases-reviewer.ts:205,261` were designed to reset provider failure counts after successful invocations. As a side effect, they also reset merge failure counts — defeating the merge failure cap. This is a dual-use counter bug: provider-success clears and merge-failure tracking are incompatible on the same column.

### ROOT CAUSE 3: `prepareForTask()` unconditionally destroys task branch commits (CRITICAL — INDEPENDENT)

**Location**: `src/workspace/git-lifecycle.ts:148-208`

Every pooled coder invocation (both `start` and `resume`) calls `prepareForTask()`, which:
1. Hard-resets to `origin/<baseBranch>` (using stale ref when remote is unreachable)
2. Force-creates the task branch with `-B` at the reset HEAD
3. All previous commits on the task branch become unreachable (exist only in reflog)

This is an **independent data-loss bug** that affects all pooled resume paths, not just post-merge-failure re-entry. Even in normal reject/resume cycles, the coder loses all prior commits and must rebuild from scratch. In this incident, it amplified the merge failure into total work loss.

### ROOT CAUSE 4: Claude session resume is broken by design (LOW — EFFICIENCY)

**Location**: `src/providers/claude.ts:225,338`

Every invocation creates a fresh isolated HOME at `claude.ts:225`. The HOME is deleted on exit at `claude.ts:338`. The coder/reviewer code still attempts `--resume` via `findResumableSession()`, which always fails, doubling the number of reviewer invocations.

---

## 4. Desired Behavior

After the fix, the system should behave as follows:

1. **Infrastructure failures block immediately**: When the remote base branch doesn't exist, the task transitions to `blocked_error` with a descriptive reason — not back to `pending`. The operator sees the blocked task and fixes the infrastructure (push the branch). No compute is wasted on retries. A single `verifyBaseRef()` helper validates the ref at both setup and merge time.

2. **Merge failures are tracked separately from provider failures**: A dedicated `merge_failure_count` column tracks merge-specific failures. It is only incremented by merge failures and only cleared on successful merge. After 3 merge failures → `blocked_error`. The existing `failure_count` continues to track provider invocation failures with its existing clear semantics unchanged.

3. **Task branch commits survive re-entry**: When `prepareForTask()` finds an existing local task branch (`steroids/task-<id>`), it checks it out as-is instead of force-recreating it. No ahead/behind comparison needed — branch existence alone is sufficient. The merge pipeline (which already handles rebase) reconciles with any base branch updates.

4. **Session resume is not attempted when guaranteed to fail**: For the Claude provider (whose isolated HOME is always ephemeral), `findResumableSession()` is skipped. The fallback (fresh session with history reconstruction) is used directly. Other providers retain resume capability.

---

## 5. Design — Proposed Fix

### Fix 1: Validate remote reachability at workspace setup and merge time (HIGHEST PRIORITY)

This is the minimal hotfix that would have prevented the entire incident.

**Single helper**: Create a `verifyBaseRef(slotPath, remote, baseBranch, localOnly)` function that validates the effective base ref. Both `prepareForTask()` and `mergeToBase()` call this helper — one source of truth for base-ref validation, per Simplification First.

**Helper contract**: `verifyBaseRef(slotPath, baseBranch, localOnly)` checks **local refs only** — it runs `git rev-parse --verify refs/remotes/origin/<baseBranch>` to confirm the branch exists in the local ref store after a fetch. It does NOT perform a fetch itself. The caller is responsible for ensuring a fetch has been done before calling the helper. Returns `'ok' | 'missing'`. When `localOnly` is true, skip verification entirely (return `'ok'`) — there is no remote to validate against, and the existing code already skips fetch for local-only slots at line 116.

**Classification (deterministic)**:
- Fetch fails (network, auth, DNS) → **transient** → existing retry path (no `blocked_error`)
- Fetch succeeds but `verifyBaseRef()` returns `'missing'` → **permanent** (branch missing) → `blocked_error`

This avoids non-deterministic heuristics: the classification is based on two concrete git commands with binary outcomes. The helper has a single contract: check local refs. Both callers follow the same pattern: fetch first, then verify.

**In `prepareForTask()`**: The existing `git fetch origin` at line 117 already fetches all remote refs. Call `verifyBaseRef()` after line 146 (after both `resolveBaseBranch()` at line 131 and the section branch override at lines 134-146 have executed, so the final `baseBranch` value is known). If the branch is missing, return `{ ok: false, blocked: true, reason: 'Remote base branch does not exist' }`. This uses the existing `blocked_error` status — no new status values needed.

**In `mergeToBase()`**: Change the fetch at line 323 from `execGit(slotPath, ['fetch', remote, baseBranch])` to `execGit(slotPath, ['fetch', remote], { tolerateFailure: true })`. If fetch fails → return transient failure (existing retry path). If fetch succeeds → call `verifyBaseRef()`. If missing → return a `MergeResult` with `infrastructure: true`. The caller (`handleMergeFailure`) checks `infrastructure` and sets `blocked_error` immediately without incrementing the merge counter or calling `returnTaskToPending()`.

**`MergeResult` change**: Add `infrastructure: boolean` to the failure variant. This is a 1-field type extension — no status propagation needed, no DB change, deterministic (no string parsing).

### Fix 2: Add dedicated `merge_failure_count` column

The existing `failure_count` is a **shared counter** incremented by three call sites: merge failures (`merge-pipeline.ts:72`), provider invocation failures (`loop-phases-helpers.ts:215`), and batch provider failures (`orchestrator-loop.ts:649`). The clears at `loop-phases-coder.ts:180` and `loop-phases-reviewer.ts:205,261` correctly reset provider failure counts after successful invocations — but as a side effect, they defeat the merge failure cap.

**Fix**: Add a `merge_failure_count INTEGER DEFAULT 0` column to the `tasks` table. Create `incrementMergeFailureCount()` and `clearMergeFailureCount()` query functions. `handleMergeFailure()` increments this counter. It is cleared only on successful merge — call `clearMergeFailureCount(db, task.id)` in the merge success path at `loop-phases-reviewer.ts`, immediately before `approveTask()`. Cap at 3 → `blocked_error`. The cap of 3 is intentionally lower than the existing `MAX_FAILURE_COUNT=5` for provider failures because merge failures are more likely to indicate persistent infrastructure problems. Leave `failure_count` and `clearTaskFailureCount()` unchanged — they continue to handle provider invocation failures correctly.

**Reset path propagation**: The new `merge_failure_count` must be zeroed in all existing reset paths:
- `tasks-reset.ts:144` — add `merge_failure_count = 0` to the UPDATE query
- `tasks-reset.ts:161` — add `merge_failure_count = 0` to the bulk pending reset
- Manual recovery (Section 6, step 8) — include `merge_failure_count=0` in the reset

**Blocked task recovery**: Single-task reset (`steroids tasks reset <id>`, `tasks-reset.ts:55-62`) already accepts any task status — no change needed for per-task recovery. However, the bulk selection flags (`--failed`, `--disputed`, `--all` at `tasks-reset.ts:64-68`) do not include `blocked_error` or `blocked_conflict`. Add a `--blocked` flag that selects both `blocked_error` and `blocked_conflict` tasks for bulk reset. When resetting `blocked_conflict` tasks, also clear `conflict_count = 0` (otherwise the next rebase conflict immediately re-blocks).

**Additional reset path**: `steroids tasks update --status pending` (`src/commands/tasks.ts:1003`) calls `resetTaskFailureCount()` which only clears `failure_count`. Update this path to also clear `merge_failure_count = 0` to prevent sticky counters.

**Why a new column (reversing previous position)**: The Round 2 reviews (both Claude and Codex independently) identified that `failure_count` has three increment sites, not one. The previous claim that it was "scoped to merge failures by its single increment call site" was factually wrong. Per Root-Cause First (AGENTS.md), the broken invariant is that two unrelated failure modes share a counter — fix the invariant directly with clean separation. A migration + 2 query functions is less complex than trying to restructure the clear semantics without introducing new failure modes.

### Fix 3: Preserve task branch commits in `prepareForTask()`

Do not force-recreate an existing task branch.

**Approach**: At `git-lifecycle.ts:208`, check if `steroids/task-<id>` exists as a local branch. If it does, `git checkout steroids/task-<id>` (preserving existing commits). If it doesn't, `git checkout -B steroids/task-<id>` (fresh start, same as today).

```
Current: git checkout -B steroids/task-<id>  (always force-recreates at HEAD)
Proposed:
  IF local branch steroids/task-<id> exists:
    git checkout steroids/task-<id>  (preserves existing commits)
  ELSE:
    git checkout -B steroids/task-<id>  (fresh start)
```

**Why no ahead/behind comparison**: Per Simplification First, branch existence alone is sufficient. The previous design used `slot.starting_sha` for comparison, but `starting_sha` is cleared on full slot release (`pool.ts:196`) — it would be absent when the task is re-picked up. Branch existence is a simpler, deterministic check with no external state dependency.

**Safety of Steps 5-6**: The `git checkout baseBranch` + `git reset --hard baseRef` at lines 150-151 and `git clean -fd` at line 154 operate on the base branch checkout. They do not affect other local branch refs — the `steroids/task-<id>` branch pointer remains intact. The subsequent `git checkout steroids/task-<id>` at line 208 restores the task branch's committed tree.

**`starting_sha` invariant**: `startingSha` is recorded at line 201 (`git rev-parse HEAD`) while HEAD is on `baseBranch` — BEFORE the branch checkout at line 208. With a preserved branch, `startingSha` = base HEAD and `HEAD` moves to the task branch tip at checkout. This means `startingSha..HEAD` covers all divergent commits (old + new). Both downstream consumers handle this correctly:
- `postCoderGate()` at line 246: Sees old commits → passes. This is correct: the preserved branch HAS work to submit.
- `mergeToBase()` at line 295: Sees old commits → proceeds to merge. This is correct: all divergent commits need merging.

For genuine rejections (reviewer found real defects), the coder prompt already includes the full rejection history, so the coder can fix issues on top of existing commits rather than rebuilding from scratch. If the coder adds no new commits after a rejection, `postCoderGate` still passes (old commits exist), and the reviewer will see the unfixed code and reject again — no death spiral, no data loss.

### Fix 4: Skip session resume for Claude provider

The Claude provider's isolated HOME model (`claude.ts:225` creates, `claude.ts:338` deletes) guarantees `--resume` will fail on **every** invocation — not just in pool mode. The fallback (fresh session with history reconstruction) already works correctly.

**Scope**: Skip `findResumableSession()` when the provider is Claude. Other providers (Codex, Gemini) have persistent-home logic that may support resume — do not regress them. Per Root-Cause First, the defect is that Claude's HOME is always ephemeral. Per Simplification First, always skipping for Claude is simpler than a pool-mode-only check (no `isPoolMode` flag needed).

**Mechanism**: In `CoderRunner.runTask()` at `src/orchestrator/coder.ts:68` and `ReviewerRunner.runTask()` at `src/orchestrator/reviewer.ts:216`, skip `findResumableSession()` when `provider === 'claude'`. The provider name is already available at those call sites via the config object.

---

## 6. Implementation Order

### Phase 1: Immediate hotfix (Fix 1 + Fix 2)
1. Create `verifyBaseRef()` helper; add remote base branch validation in `prepareForTask()` and `mergeToBase()` — use existing `blocked_error` status
2. Add `merge_failure_count` column (migration); create increment/clear query functions; update `handleMergeFailure()` to use new counter; cap at 3
3. Extend `MergeResult` failure variant with `infrastructure: boolean`; update `handleMergeFailure()` to block immediately on infrastructure failures

**This alone would have prevented the Technician incident.**

### Phase 2: Durability fix (Fix 3)
4. Modify `prepareForTask()` to check for existing task branch — use plain `checkout` instead of `-B` when branch exists

### Phase 3: Efficiency (Fix 4)
5. Skip session resume for Claude provider (all modes — the HOME is always ephemeral)

### Immediate recovery (manual)
6. Push `main` to origin for the Technician project
7. Recover orphaned commits from reflog before GC:
   - `git reflog steroids/task-4eab4e13...` — commits `b10e0a40`, `2851b66f`, etc. are recoverable
   - `git reflog steroids/task-be98d32e...` — same pattern
8. Reset affected tasks to `pending` with `rejection_count=0`, `failure_count=0`, `merge_failure_count=0`
9. Retry once the remote is valid

---

## 7. Edge Cases

| Scenario | Handling |
|----------|----------|
| Task branch has commits but they conflict with updated base | `mergeToBase()` handles rebase conflicts already; `prepareForTask()` just preserves the branch. Coder may produce work that conflicts at merge time — acceptable since the merge pipeline rebases and retries |
| Task branch has commits from a different coder provider | Preserve — the new coder should build on existing work |
| Remote base branch becomes available after blocking | Operator fixes infrastructure, then runs `steroids tasks reset --id <task-id>` to move from `blocked_error` to `pending`; `prepareForTask()` fetch succeeds on next run |
| `prepareForTask()` called while mid-rebase | Existing `hasMidRebase` detection and `abortRebase` handle this |
| Coder submits no file changes (empty commit) | Existing `coder-noop-submission.ts` handles this; no change needed |
| Concurrent runners claim same task | Task locks (`task_locks` table) prevent duplicate execution |
| Provider crash + merge failure on same task | Separate counters: `failure_count` tracks provider crashes (existing), `merge_failure_count` tracks merge failures (new). Each has its own cap and clear semantics |
| Transient network error during fetch (not missing branch) | `verifyBaseRef()` distinguishes missing ref (permanent) from fetch failure (transient). Only missing ref triggers `blocked_error`; transient failures use existing retry path |
| Local-only slot (no remote) | `verifyBaseRef()` returns `'ok'` when `localOnly` is true — no remote to validate against. Existing code already skips fetch for local-only |
| Re-clone triggered by dirty worktree (lines 157-198) | The re-clone path (`rmSync` + fresh clone) deletes all local branches including the preserved task branch. This is a rare corruption-recovery fallback. Branch preservation does not survive re-clone — accepted as known limitation since the re-clone indicates filesystem corruption where branch data may already be unreliable |

---

## 8. Non-Goals

- Full per-task persistent workspaces — too much disk/complexity for this fix. The pool model with hard reservation during coder→review→merge lifecycle is sufficient.
- Coder dispute detection — per Simplification First, Fixes 1+2 prevent the death spiral at its root. Adding deterministic dispute detection is defense-in-depth that increases complexity without addressing the actual defect. Deferred to follow-up if Fixes 1+2 prove insufficient.
- Adding new `TaskStatus` values — reuse existing `blocked_error` and `blocked_conflict` with descriptive reason strings to avoid propagation risk through all six status-dependent areas.
- Merge-only retry path (approved work stays in merge lane on merge failure instead of returning to coder) — valuable but significantly changes the task state machine. Deferred to follow-up. Fix 1 (blocking on infrastructure failure) and Fix 2 (merge failure cap) prevent the infinite loop; Fix 3 (branch preservation) prevents data loss on re-entry.

---

## 9. Cross-Provider Review

### Round 1: Four adversarial reviews (2 Claude, 2 Codex)

#### Critical Findings — Adopted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| 1 | `failure_count` cap is defeated by `clearTaskFailureCount` | Claude-1, Codex-2, Claude-3 | **ADOPT** — Elevated to ROOT CAUSE 2. |
| 2 | Implementation order should be reversed | Codex-4 | **ADOPT** — Phase 1 = Fix 1+2, Phase 2 = Fix 3. |
| 3 | `mergeToBase()` uses `slot.base_branch` not hardcoded `main` | Codex-2 | **ADOPT** — Corrected throughout. |

#### High Findings — Adopted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| 4 | New task statuses proposed without propagation analysis | Claude-1 | **ADOPT** — Removed; reuse `blocked_error`/`blocked_conflict`. |
| 5 | Slot-claiming claim overstated | Codex-2, Claude-1 | **ADOPT** — Moved to Latent Risks. |
| 6 | Durable submission refs not a contributing factor | Claude-1 | **ADOPT** — Moved to Latent Risks. |
| 7 | Data-loss recovery missing from plan | Codex-4 | **ADOPT** — Added recovery steps. |
| 8 | Workspace setup validation missing | Codex-4 | **ADOPT** — Added to Fix 1. |
| 9 | Non-goals too broad around slot model | Codex-4 | **ADOPT** — Narrowed. |

#### Medium Findings — Adopted or Deferred

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| 10 | Branch preservation over-engineered | Claude-3 | **ADOPT** — Simplified Fix 3. |
| 11 | Coder dispute detection gaming risk | Claude-3 | **DEFER** — Moved to Non-Goals. |
| 12 | Claude resume simpler to skip | Claude-3 | **ADOPT** — Simplified Fix 4. |
| 13 | `conflict_count` never resets | Codex-2 | **DEFER** — Follow-up. |
| 14 | Monitoring/alerting under-scoped | Codex-4 | **DEFER** — Out of scope. |
| 15 | Persistent workspaces dismissed | Codex-4 | **DEFER** — Noted in non-goals. |

#### Low Findings — Noted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| 16 | Docker task timeline not detailed | Claude-1 | **NOTED** |
| 17 | `prepareForTask` scope — pool-mode only | Codex-2 | **ADOPT** — Clarified. |

### Round 2: Two adversarial reviews (1 Claude, 1 Codex)

#### Critical/High Findings — Adopted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R2-1 | `failure_count` has THREE increment sites (merge, provider, batch) — not one. Document's claim of "single increment site" was factually wrong. Shared counter makes "move the clear" approach incorrect. | Claude-5, Codex-6 | **ADOPT** — Reversed Fix 2 to dedicated `merge_failure_count` column. Root-Cause First: fix the broken invariant (dual-use counter) directly. Previous Simplification First argument was based on a false premise. |
| R2-2 | Approved work should not return to coder on merge infra failures — should stay in merge lane | Codex-6 | **DEFER** — Valid, but significantly changes the task state machine. Fix 1 (block on infra failure) + Fix 2 (cap) + Fix 3 (preserve branch) together prevent the death spiral without state machine changes. Added to Non-Goals with justification. |
| R2-3 | `slot.starting_sha` is cleared on full slot release (`pool.ts:196`) — Fix 3's ahead/behind comparison is non-implementable as written | Codex-6 | **ADOPT** — Simplified Fix 3 to branch-existence check only. No `starting_sha` dependency. |
| R2-4 | Fix 1 needs to distinguish transient vs permanent remote failures; `mergeToBase()` can't set `blocked_error` directly (lacks project DB) | Claude-5 | **ADOPT** — Added `infrastructure: boolean` to `MergeResult` failure variant; caller handles blocking decision. |

#### Medium Findings — Adopted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R2-5 | Fix 1 duplicates base-ref validation in two places — should be one helper | Codex-6 | **ADOPT** — Single `verifyBaseRef()` helper used by both call sites. |
| R2-6 | ROOT CAUSE 3 is independent data-loss bug, not just amplifier of merge failures | Codex-6 | **ADOPT** — Reframed in Section 3: separate trigger from systemic bugs. |
| R2-7 | Fix 3 simpler as "don't force-recreate existing branch" without ahead/behind check | Codex-6 | **ADOPT** — Simplified (same as R2-3). |
| R2-8 | Fix 4 pool-mode detection (`projectPath !== effectiveProjectPath`) doesn't match actual function signatures | Claude-5 | **ADOPT** — Changed to explicit `isPoolMode` boolean parameter. |
| R2-9 | Fix 3 should explain why Steps 5-6 (hard reset on baseBranch) don't affect the task branch | Claude-5 | **ADOPT** — Added safety explanation. |

#### Low Findings — Noted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R2-10 | Line 154 description omits `-e .steroids` | Claude-5 | **ADOPT** — Corrected. |
| R2-11 | "Already reachable from base" edge case adds undocumented behavior | Codex-6 | **ADOPT** — Removed from edge cases (not needed for this fix). |
| R2-12 | Misplaced note about `mergeToBase()` in Section 2.2 | Claude-5 | **ADOPT** — Clarified. |
| R2-13 | Stale-base coder efficiency edge case missing | Claude-5 | **ADOPT** — Added to edge cases. |

### Round 3: Two adversarial reviews (1 Claude, 1 Codex)

#### High Findings — Adopted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R3-1 | `verifyBaseRef()` mechanism under-specified; placement at "after line 117" is before base branch is known (resolved at line 131+146) | Claude-7, Codex-8 | **ADOPT** — Specified two-step mechanism (fetch succeeds → check ref). Call after line 146. |
| R3-2 | `merge_failure_count` not cleared by any existing reset path (`tasks-reset.ts`); tasks stay poisoned after operator reset | Codex-8 | **ADOPT** — Added reset path propagation requirements to Fix 2. |
| R3-3 | Fix 3 `starting_sha` invariant: preserved branch changes the meaning of `startingSha..HEAD` range used by `postCoderGate()` and `mergeToBase()` | Codex-8 | **ADOPT** as documentation — `startingSha` is recorded at line 201 (base HEAD, before checkout); with preserved branch, `startingSha..HEAD` covers all divergent commits. This is correct behavior. Added explicit explanation to Fix 3. |

#### Low Findings — Adopted

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R3-4 | `clearMergeFailureCount()` call site not specified | Claude-7 | **ADOPT** — Specified: call in merge success path at `loop-phases-reviewer.ts` before `approveTask()`. |
| R3-5 | Fix 4 `isPoolMode` threading: `findResumableSession()` lives in `runTask()`, not in `invokeCoder()`/`invokeReviewer()` | Claude-7 | **ADOPT** — Noted threading requirement. |
| R3-6 | Section 2.4 missing line 261 reference for `clearTaskFailureCount` | Claude-7 | **ADOPT** — Added. |
| R3-7 | Merge failure cap of 3 vs provider failure cap of 5 not explained | Claude-7 | **ADOPT** — Added justification. |

### Round 4: Two adversarial reviews (1 Claude, 1 Codex)

**Claude**: CLEAN — no MEDIUM or higher findings remain. All code references verified against source.

**Codex**: 2 HIGH, 1 MEDIUM.

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R4-1 | Fix 4 over-broad: disables resume for ALL providers in pool mode, but defect is Claude-specific (HOME deletion). Other providers may have working resume. | Codex-10 | **ADOPT** — Scoped Fix 4 to Claude provider only. Per Root-Cause First, the defect is in Claude's HOME lifecycle, not in pool mode generally. |
| R4-2 | `blocked_error` tasks can't be recovered via `steroids tasks reset` (only handles `failed`/`disputed`). Operators need direct SQL. | Codex-10 | **ADOPT** — Added requirement to update `tasks-reset.ts` to accept `blocked_error` and `blocked_conflict` for reset. |
| R4-3 | `verifyBaseRef()` inconsistent contract: "one source of truth" but described as fetching in `mergeToBase()` and not in `prepareForTask()`. | Codex-10 | **ADOPT** — Clarified: helper checks local refs only (no fetch). Caller responsible for ensuring fetch is done. Both call sites follow same pattern: fetch first, then verify. |

### Round 5: Two adversarial reviews (1 Claude, 1 Codex)

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R5-1 | Fix 4 implementation location mislabeled: says `claude.ts` but `findResumableSession()` lives in `coder.ts:68` and `reviewer.ts:216` | Claude-9 | **ADOPT** — Corrected location to `CoderRunner.runTask()` and `ReviewerRunner.runTask()`. |
| R5-2 | Fix 4 scoped to pool-mode-only leaves invariant broken for non-pool runs. Claude HOME is always ephemeral. Always skipping for Claude is simpler AND more correct. | Codex-10 | **ADOPT** — Removed pool-mode condition. Skip resume when `provider === 'claude'` in all modes. Per Root-Cause First + Simplification First: fix the actual defect (ephemeral HOME), don't scope to a symptom (pool mode). |
| R5-3 | `merge_failure_count` not propagated through `tasks update --status pending` path (`tasks.ts:1003`). `conflict_count` not cleared when resetting `blocked_conflict` tasks. | Codex-10 | **ADOPT** — Added both reset paths to Fix 2 design. |

### Round 6: Two adversarial reviews (1 Claude, 1 Codex)

**Claude**: CLEAN — no MEDIUM or higher findings remain.

**Codex**: 2 HIGH, 1 MEDIUM.

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R6-1 | Fix 3 re-clone path (`rmSync` at line 160 + fresh clone) deletes all local branches including preserved task branch. Branch preservation doesn't survive re-clone. | Codex-12 | **ADOPT** — Documented as known limitation in edge cases. Re-clone is a rare corruption-recovery fallback; adding branch backup logic to a corruption path violates Simplification First. |
| R6-2 | Fix 1 `verifyBaseRef()` checks `refs/remotes/origin/<baseBranch>` but local-only slots have no remote. Would incorrectly classify local-only projects as broken infrastructure. | Codex-12 | **ADOPT** — Added `localOnly` parameter; helper returns `'ok'` for local-only slots. |
| R6-3 | `tasks reset <id>` (line 55-62) already accepts any status without a status gate. The actual gap is bulk selection flags (`--failed`, `--disputed`, `--all`), not single-task reset. | Codex-12 | **ADOPT** — Reframed: add `--blocked` bulk flag instead of "accept blocked statuses." |

### Round 7: Two adversarial reviews (1 Claude, 1 Codex)

**Claude**: CLEAN — no MEDIUM or higher findings remain.

**Codex**: 1 HIGH, 1 MEDIUM — both deferred per Simplification First.

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| R7-1 | Re-clone fallback path (lines 157-198) doesn't have `verifyBaseRef()` gate | Codex-14 | **DEFER** — Per Simplification First: `verifyBaseRef()` on the primary path returns `blocked: true` BEFORE line 157 is reached. The re-clone path only triggers when the remote is reachable but the worktree is dirty. Defending against a branch disappearing between two fetches in the same function is over-engineering. |
| R7-2 | `blocked_reason` not cleared on reset — stale diagnostic text on recovered tasks | Codex-14 | **DEFER** — Per Simplification First: `status` determines behavior, not `blocked_reason`. Stale reason text on a pending task is cosmetic. Nothing reads `blocked_reason` for pending tasks. |

---

## 10. Latent Risks (not root causes of this incident)

These were identified during review as real design concerns but did not cause the observed death spiral:

1. **Slot theft via soft affinity**: `partialReleaseSlot` preserves `task_id` and `claimSlot` orders by task affinity, making theft a narrow race. But with more pool slots or concurrent runners, the race window widens. Consider hard reservation during coder→review→merge lifecycle.

2. **Durable submission refs are slot-local**: In the observed incident, reviewer preflight successfully resolved the durable ref (the task reached the approval+merge stage). But if a slot is stolen between coder and reviewer, the ref would be lost. Consider storing authoritative submission refs in shared state.

3. **`conflict_count` has no reset function**: Only `incrementTaskConflictCount` exists; there is no `clearTaskConflictCount`. If a conflict is resolved, the counter cannot be reset without manual DB intervention.

4. **Coder disputes are not wired into the loop**: The coder signal parser (`signal-parser.ts`) only recognizes `STATUS: REVIEW|RETRY|ERROR` — not `DISPUTE`. Coder-filed disputes are logged but never halt the loop. If Fixes 1+2 prove insufficient, deterministic detection (consecutive identical failures across cycles) could be added as a fallback — but per Determinism First (AGENTS.md), this must not rely on parsing LLM output.
