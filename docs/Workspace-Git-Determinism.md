# Workspace Pool & Deterministic Git Lifecycle (v10)

> Replace the current "clone-per-workstream" model with a fixed workspace pool and host-controlled git lifecycle. Every git operation (branch, reset, commit verification, push, rebase, cleanup) is deterministic — no LLM involvement.
>
> **Design principle**: A correct simple system that occasionally wastes a coder session is superior to a complex recovery system that is never implemented correctly. When anything fails post-review, reset to idle and retry from scratch. Bounded retry counts prevent infinite loops.

---

## 1. Problem Statement

The current system has four compounding reliability failures:

1. **Workspace sprawl**: Each parallel workstream creates a new shallow clone, accumulating dozens of stale directories that are inconsistently cleaned.
2. **No commit verification**: The host trusts the LLM to have committed its work. If the coder forgets to commit, the reviewer operates on incomplete state.
3. **Push is fire-and-forget**: After review approval, `pushToRemote()` is a single attempt with no retry, rebase, or conflict resolution path.
4. **Branch sprawl**: Branches created by workstreams are never cleaned up — 100+ orphan branches requiring manual cleanup.

---

## 2. Current Behavior

### Workspace Creation (`src/parallel/clone.ts`)
- `createWorkspaceClone()` does `git clone --depth 1 --no-tags --single-branch`
- Path: `~/.steroids/workspaces/<projectHash>/ws-<workstreamId>/`
- `.steroids` is symlinked to source project (not copied)
- New clone per workstream session — no reuse

### Git in the Loop (`src/commands/loop-phases.ts`)
- Before coder: records `initialSha = getCurrentCommitSha()`
- After coder: checks `getRecentCommits()`, `hasUncommittedChanges()`, `getChangedFiles()`
- `stage_commit_submit` action: host runs `git add -A && git commit` if coder left uncommitted work
- Push on approval: `pushToRemote(projectPath, 'origin', branchName)` — single attempt, no retry

### Existing Merge Orchestrator (`src/parallel/merge.ts`, `src/parallel/merge-lock.ts`)
- Dedicated integration workspace with cherry-pick merge
- DB-backed merge lock with epoch fencing and heartbeat refresh
- Per-commit progress tracking and crash recovery
- LLM-assisted conflict resolution cycle

The new design **preserves the merge lock pattern** and **serializes merge-to-main** through it. Cherry-pick is superseded by rebase + ff-only.

---

## 3. Design

### 3.1 Workspace Pool

**Pool of workspace directories created lazily on demand.**

Location: `~/.steroids/workspaces/<projectHash>/pool-<index>/`

**Full clones only — no `--depth 1`**: Shallow clones break rebase and merge:
```
git clone --no-tags <remoteUrl> pool-<index>/
```
If an existing slot was previously shallow, detect via `git rev-parse --is-shallow-repository` and run `git fetch --unshallow` before any operation.

**Remote URL resolution**: `git -C <projectPath> remote get-url origin`. If the result is a valid remote URL (https/ssh), use it. If it's a local filesystem path or absent, set `remote_url = NULL` — all push/fetch operations are skipped (local-only mode, Section 3.8).

**No hard cap on pool size**: Slots are created lazily. The natural cap is the number of active runners. Unused slots are garbage-collected by `steroids workspaces clean`.

### 3.2 Pool Slot Claiming — DB-Backed Leases (Global DB)

Pool slot ownership is tracked in **the global database** (`~/.steroids/global.db`), alongside `workstreams` and `runners`.

#### DB Table: `workspace_pool_slots` (in global.db)

```sql
CREATE TABLE workspace_pool_slots (
  id             INTEGER PRIMARY KEY,
  project_id     TEXT NOT NULL,
  slot_index     INTEGER NOT NULL,
  slot_path      TEXT NOT NULL,         -- absolute path to pool-<index>/
  remote_url     TEXT,                  -- resolved remote URL (NULL = local-only)
  runner_id      TEXT,                  -- NULL if idle
  task_id        TEXT,                  -- NULL if idle
  base_branch    TEXT,                  -- e.g. "main"
  task_branch    TEXT,                  -- e.g. "steroids/task-<uuid>"
  starting_sha   TEXT,                  -- git rev-parse HEAD at task pickup
  status         TEXT NOT NULL DEFAULT 'idle',
  -- 'idle' | 'coder_active' | 'awaiting_review' | 'review_active' | 'merging'
  claimed_at     INTEGER,              -- ms since epoch
  heartbeat_at   INTEGER,              -- ms since epoch, refreshed every 30s
  UNIQUE(project_id, slot_index)
);
```

**5 slot statuses**: `idle`, `coder_active`, `awaiting_review`, `review_active`, `merging`. No failure-specific states — any failure resets to `idle`.

**Claiming a slot** — transactional:
```sql
BEGIN IMMEDIATE;
  SELECT * FROM workspace_pool_slots
  WHERE project_id = ? AND status = 'idle'
  LIMIT 1;
  -- If none found: INSERT new slot with MAX(slot_index) + 1
  -- UNIQUE constraint violation → retry SELECT (another runner won the race)
UPDATE workspace_pool_slots
  SET runner_id = ?, task_id = ?, status = 'coder_active',
      claimed_at = ?, heartbeat_at = ?
  WHERE id = ?;
COMMIT;
```

**Stale lease reclamation**: A slot is stale if `heartbeat_at < now - 10min` and `status != 'idle'`. Stale slots are reset to `idle`, associated tasks returned to `pending`.

**Heartbeat**: Start a 30-second interval timer when claiming a slot. Stop it when releasing the slot. That's it.

#### Merge Lock (in global.db)

The merge lock is **also in global.db** — same database as pool slots. This eliminates cross-database ordering concerns: slot status updates and lock acquisition/release can be in the same transaction when needed.

```sql
CREATE TABLE workspace_merge_locks (
  id             INTEGER PRIMARY KEY,
  project_id     TEXT NOT NULL UNIQUE,
  runner_id      TEXT NOT NULL,
  slot_id        INTEGER NOT NULL,
  acquired_at    INTEGER NOT NULL,     -- ms since epoch
  heartbeat_at   INTEGER NOT NULL,     -- ms since epoch
  FOREIGN KEY (slot_id) REFERENCES workspace_pool_slots(id)
);
```

Lock TTL: 10 minutes. Heartbeat: refreshed by the same 30-second interval timer used for slot heartbeats. Expired locks can be reclaimed by any runner.

### 3.3 Task Git Lifecycle

The entire git lifecycle is host-controlled. The LLM may commit freely during coding but never runs branching, reset, push, rebase, or merge operations.

#### Phase 1: Task Pickup — Clean Slate

```
1. If remote_url IS NULL: use local-only mode (Section 3.8). Otherwise:

2. Mid-rebase guard (run before any checkout):
   If .git/rebase-merge/ OR .git/rebase-apply/ OR .git/REBASE_HEAD exists:
     git rebase --abort (tolerate exit 128 — not a fatal error)

3. git fetch origin

4. Resolve base branch (once per slot, cached):
   Check git rev-parse --verify origin/main. If exists: baseBranch = "main".
   Else check origin/master. If exists: baseBranch = "master".
   If neither exists: mark task 'blocked_error' ("no valid base branch"). STOP.

5. git checkout <baseBranch>
   git reset --hard origin/<baseBranch>

6. git clean -fd -e .steroids

7. Verify: git status --porcelain == empty
   If non-empty: delete directory, re-clone from remoteUrl once.
   After re-clone, re-run steps 3-6, then re-check.
   If still non-empty after re-clone: mark task 'blocked_error'. STOP.

8. Record startingSha = git rev-parse HEAD

9. git checkout -B steroids/task-<fullTaskId>
   (-B to handle reruns where the branch already exists from a prior failed attempt)

10. Update DB: slot.status = 'coder_active', .task_id, .task_branch,
               .base_branch, .starting_sha
```

#### Phase 2: Coder Execution

The coder runs in the workspace directory on the task branch. Read, write, and commit freely. Host does not interfere.

#### Phase 3: Post-Coder Verification Gate

After coder exits:

```
1. Check: git status --porcelain
   If non-empty (uncommitted work):
     git add -A
     git commit -m "feat: implement <taskTitle> (auto-committed by steroids)"

2. Check: git log startingSha..HEAD --oneline
   If empty (no commits since task pickup):
     → Return task to coder: "No changes detected."
     → slot.status remains 'coder_active'

3. Update DB: slot.status = 'awaiting_review'
```

#### Phase 4: Review Execution

Reviewer examines diff between `startingSha` and `HEAD`. DB: `slot.status = 'review_active'`.

#### Phase 5: Post-Review Merge Pipeline

```
1. Discard any uncommitted reviewer changes:
   If git status --porcelain is non-empty:
     git checkout -- .
     git clean -fd
     Log warning.

2. Verify: git log startingSha..HEAD --oneline is non-empty
   If empty: fatal error, escalate.

3. Acquire merge lock (5 minute timeout, poll every 5s).
   If cannot acquire in 5 minutes: log error, release slot to idle,
   return task to pending. STOP.
   On acquisition: slot.status = 'merging'

4. git fetch origin <baseBranch>

5. Rebase task branch:
   git rebase origin/<baseBranch>
   If conflicts:
     git rebase --abort
     Release merge lock.
     Increment task.conflict_count in task DB.
     If task.conflict_count >= 3: mark task 'blocked_conflict'. Surface for human.
     Else: reset slot to idle, return task to pending (full retry).
     STOP.

6. Push task branch:
   git push origin steroids/task-<taskId> --force-with-lease
   Retry: 3x with backoff (1s, 4s, 16s).
   On failure (all retries exhausted):
     Release merge lock. Reset slot to idle. Return task to pending.
     STOP.

7. Merge to base branch:
   git checkout <baseBranch>
   git reset --hard origin/<baseBranch>
   git merge --ff-only steroids/task-<taskId>
   If ff-only fails: fatal invariant violation. Release merge lock. Escalate.

8. Push base branch:
   git push origin <baseBranch>
   Retry: 3x with backoff (2s, 8s, 32s).
   On failure (all retries exhausted):
     Release merge lock. Reset slot to idle. Return task to pending.
     STOP.

9. Release merge lock.

10. Verify reachability:
    git fetch origin <baseBranch>
    mergedSha = git rev-parse steroids/task-<taskId>
    git merge-base --is-ancestor <mergedSha> origin/<baseBranch>
    If not ancestor: log error. Do NOT delete task branch. Escalate.

11. Cleanup:
    git push origin --delete steroids/task-<taskId>
      (only if task UUID exists in local DB; if fails: log, continue)
    git branch -D steroids/task-<taskId>
    git checkout <baseBranch> && git reset --hard origin/<baseBranch>

12. Mark task done in database.
13. Update DB: slot.status = 'idle', clear task fields.
```

**Failure policy**: Any failure in Phase 5 (push, merge, rebase conflict) releases the merge lock (if held), resets the slot to `idle`, increments `task.failure_count`, and returns the task to `pending` for a full retry from Phase 1. No partial recovery, no re-entry protocols.

**Bounded retry**: If `task.failure_count >= 5`, mark task `blocked_error` with the last error message instead of returning to pending. This prevents infinite retry loops for persistent failures (auth issues, missing branches, corrupted repos).

**"Surface for human"**: Throughout this design, "surface for human" / "escalate" means: set `task.status = 'blocked'` (or `blocked_conflict` / `blocked_error` as appropriate) with a `blocked_reason` text field, and log at ERROR level. The `steroids tasks` CLI shows task status. No additional notification mechanism is required for v1.

**Cross-DB recovery**: Slot state lives in `global.db`, task state in `project.db`. These are NOT atomically updated. On crash between updates, reconciliation handles recovery: stale slots (expired heartbeat) are reset to `idle`, and their associated `task_id` is returned to `pending`. This may occasionally return a task to `pending` that was already completed (crash after task marked done but before slot released) — the next pickup will see the task is done and skip it. Duplicate work is bounded by the failure_count cap.

### 3.4 Branch Naming

Task branches: `steroids/task-<fullTaskId>` — full UUID, no truncation. No LLM-chosen names.

### 3.5 Merge Policy — Rebase + ff-only Only

**Strategy**: rebase task branch onto `origin/<baseBranch>` tip → ff-only merge.

**No squash**: squash invalidates stored SHAs and breaks bisect/blame. Commit history is preserved.

### 3.6 Conflict Handling

Rebase conflicts are rare in an isolated-branch system (only when two tasks modify the same lines and one merges while the other is in review).

**Policy**: On rebase conflict, abort, reset slot, retry from scratch. The task's `conflict_count` is tracked in the task database (not the slot). After 3 full retries with conflicts, mark task `blocked_conflict` and surface for human intervention.

### 3.7 Single-Runner Mode

Pool has exactly 1 slot (`pool-0/`). Lifecycle is identical. Merge lock is still acquired (self-contention is a no-op).

### 3.8 Local-Only Mode

When `slot.remote_url IS NULL` (no remote configured):

**Phase 1**: Skip `git fetch`. Use `git reset --hard <baseBranch>` (no `origin/` prefix).

**Phase 5**: Skip push steps (6, 8, 10). Rebase against local `<baseBranch>`. Merge locally. Task is marked complete after local merge. Skip remote branch cleanup.

### 3.9 Orchestrator Compatibility: `stage_commit_submit`

Keep `stage_commit_submit` as a recognized no-op in the action parser — map to `submit`. Remove from orchestrator prompt as a follow-up.

---

## 4. Startup Reconciliation

On every runner start, before claiming a pool slot:

**Step 1 — Stale slot reclamation**:
- Find all slots where `heartbeat_at < now - 10min` AND `status != 'idle'`
- Reset each to `idle`, clear task fields, return associated task to `pending`

**Step 2 — Stale merge lock reclamation**:
- Find merge locks where `heartbeat_at < now - 10min`
- Delete them (runners will re-acquire on next merge attempt)

> **TTL rationale (v11)**: Both TTLs are 10 minutes. `execFileSync`-based git operations (clone timeout = 5 min, push retry backoff = up to ~360s) block the Node.js event loop, preventing `setInterval` heartbeats from firing. 10 minutes exceeds all worst-case operation durations while still reliably detecting genuine runner crashes.

That's it. No state-dependent recovery, no re-entry protocols. Stale = reset.

Orphan branch cleanup is handled by `steroids workspaces clean` (manual CLI command), not startup reconciliation.

---

## 5. What Changes vs. Current System

| Aspect | Current | New |
|--------|---------|-----|
| Workspace creation | New shallow clone per workstream | Full clone, fixed pool, reuse via reset |
| Clone depth | `--depth 1` (shallow) | Full — required for rebase |
| Pool slot claiming | PID file lock | DB-backed lease in global.db |
| Workspace state tracking | DB + JSON state file | DB only — `workspace_pool_slots` in global.db |
| `origin` remote | Local filesystem path | Validated real remote URL |
| Post-coder commit check | LLM trust + auto-commit fallback | Deterministic gate |
| Post-review uncommitted changes | Auto-commit | Discard with warning |
| Merge lock location | project.db | global.db (same DB as slots) |
| Merge strategy | Cherry-pick integration workspace | Rebase + ff-only from pool workspace |
| Merge serialization | None | DB merge lock, 5min wait |
| Failure recovery | None | Reset to idle, retry from scratch |
| Branch cleanup | None | After verified merge, scoped deletion |
| Conflict handling | LLM-assisted | Abort + retry; block after 3 conflicts |
| Slot statuses | N/A | 5 states: idle, coder_active, awaiting_review, review_active, merging |
| Local-only projects | Push attempted, fails | Detected at init; local-only merge path |

---

## 6. Edge Cases

| Scenario | Handling |
|----------|----------|
| Runner crashes mid-coder | Heartbeat expires (10min). Reconciliation resets slot to idle. Task retries. |
| Runner crashes during rebase | Heartbeat expires. Reconciliation resets slot. Phase 1 mid-rebase guard cleans up on next pickup. |
| Runner crashes after push, before cleanup | Task branch is an orphan. `steroids workspaces clean` deletes it. |
| Runner crashes after main push, before marking done | Previous work already on main. Task retries from scratch: coder re-implements, rebase drops already-applied hunks, merge is a no-op ("Already up to date"). Wasted coder session but no data loss or duplication. |
| Coder makes zero changes | Post-coder gate rejects. Task returned with "no changes" note. |
| Coder leaves uncommitted work | Post-coder gate auto-commits. |
| Reviewer leaves uncommitted changes | Post-review gate discards with warning. |
| Rebase conflict | Abort, reset, retry from scratch. Block after 3 conflicts. |
| Push fails (transient) | 3 retries with backoff. If all fail: reset, increment failure_count, retry from scratch. Blocks after 5 total failures. |
| Push fails (auth) | Reset slot to idle. Increment failure_count. After 5 failures: mark task `blocked_error` with auth details. |
| Two runners compete for merge lock | Second waits up to 5 minutes. If still blocked: reset, retry. |
| Shallow clone detected | `git fetch --unshallow` before any rebase. |
| Pool slot directory corrupted | Phase 1 step 6 detects. Delete + re-clone. |
| Local-only project | `remote_url = NULL`. Local merge path. No push. |

---

## 7. Non-Goals

1. **Multi-repo support**: One workspace pool per git repo.
2. **Cherry-pick merge strategy**: Deprecated.
3. **Workspace sharing between runners**: Each pool slot exclusively owned.
4. **LLM-driven git operations**: All lifecycle operations are host-controlled.
5. **Squash merge**: Excluded — invalidates stored SHAs.
6. **Batched merge to main**: Each approved task merges immediately.
7. **Partial failure recovery**: No re-entry protocols. Failures reset to idle.
8. **Enforcing LLM cannot run git**: Instructed not to; host verifies branch after the fact.

---

## 8. Implementation Order

### Phase 1: DB Schema & Pool Slot Infrastructure
1. Migration: `workspace_pool_slots` + `workspace_merge_locks` tables in global.db
2. `src/workspace/pool.ts` — transactional slot claim/release/heartbeat; origin URL resolution; full clone init; shallow detection + unshallow
3. `src/workspace/git-lifecycle.ts` — `prepareForTask()`, `postCoderGate()`, `postReviewGate()`, `mergeToBase()`, `cleanupBranch()`, local-only variants

### Phase 2: Pre-Coder Gate + Clone Replacement
4. Update `src/parallel/clone.ts` — delegate to pool
5. Update `src/commands/loop-phases.ts` `runCoderPhase()` — call `prepareForTask()`
6. Remove JSON state file creation/reading

### Phase 3: Post-Coder Verification Gate
7. Update `src/commands/loop-phases.ts` — deterministic verification gate
8. Parser: keep `stage_commit_submit` as no-op

### Phase 4: Post-Review Push & Merge Pipeline
9. `src/commands/loop-phases.ts` `runReviewerPhase()` — full Phase 5 pipeline
10. `src/workspace/git-lifecycle.ts` — merge lock acquisition, rebase, push, merge, verify, cleanup

### Phase 5: Reconciliation & CLI
11. `src/workspace/reconcile.ts` — stale slot + stale lock reclamation
12. `steroids workspaces` CLI — list pool slots, manual cleanup (including orphan branches)

---

## 9. Cross-Provider Review Summary

### Rounds 1–7 (v1–v8)
See git history for the full review trail. Key decisions from those rounds that are preserved in v9:
- Full clones (not shallow) — required for rebase
- DB-backed leasing (not PID file locks)
- `global.db` for pool slots (not project.db)
- Rebase + ff-only (not cherry-pick)
- Reachability check uses `--is-ancestor` (not exact equality)
- Branch naming uses full UUID
- `git clean -fd` (not `-fdx`) to preserve gitignored files
- Mid-rebase guard before checkout in Phase 1

### Round 8 — Simplification Review (v9)

**Reviewers**: OpenAI Codex, Claude Opus. **Lens**: Simplification, anti-overengineering, stability.

**Meta-finding (both reviewers)**: The 7 review rounds created a "complexity ratchet" — each round found edge cases in recovery logic added by the previous round, then added more recovery logic. The push_failed re-entry protocol was fixed in rounds 3, 4, 5, 6, AND 7, indicating irreducible complexity. The design optimized for avoiding redundant coder sessions at the cost of correctness and maintainability — the wrong tradeoff.

**Adopted findings**:

| Finding | Severity | Action |
|---------|----------|--------|
| State machine has too many states (9) | CRITICAL | Reduced to 5: idle, coder_active, awaiting_review, review_active, merging |
| push_failed re-entry protocol is irreducibly complex | CRITICAL | Eliminated. All failures → reset to idle, retry from scratch |
| Cross-DB ordering contract is fragile | HIGH | Merge lock moved to global.db. One DB, one transaction |
| Three SHAs are two too many | HIGH | Kept only `starting_sha`. Others derived ephemerally |
| Reconciliation is a second system | HIGH | Reduced to: "reset stale slots to idle." No re-entry |
| Conflict resolution overdesigned | HIGH | Removed as distinct state. Abort + retry. Block after 3 conflicts |
| merge_pending adds unnecessary state | MEDIUM | Eliminated. Wait longer (5min) for merge lock instead |
| schema_version is premature | MEDIUM | Removed |
| Remote URL "walk up" underdefined | MEDIUM | Simplified to: git remote get-url origin. Local path = local-only |
| Heartbeat overspecified | MEDIUM | 30s interval timer, start/stop on claim/release |
| Git error parsing fragile | HIGH | Use exit codes primarily. Conservative fail-and-retry |

**Deferred findings (implement later if needed)**:
- `git add -A` may commit unexpected files — existing behavior, follow-up improvement
- Orphan branch cleanup automation — manual CLI for now
- Post-crash-after-push optimization: detect task already merged before re-running coder (follow-up)

### Round 9 — Stability Review (v10)

**Reviewers**: OpenAI Codex, Claude Opus. **Lens**: Did simplification go too far? Missing invariants?

**Overall verdict (both reviewers)**: Design is implementable. No CRITICAL correctness holes.

| Finding | Severity | Source | Action |
|---------|----------|--------|--------|
| `git checkout -b` fails on retry (branch exists) | CRITICAL | Codex | Changed to `-B` in Phase 1 step 9 |
| Cross-DB atomicity (slot ↔ task) not defined | CRITICAL | Codex | Documented recovery semantics in failure policy |
| Unbounded retry for non-recoverable failures | HIGH/MEDIUM | Both | Added `failure_count` cap (5) with `blocked_error` escalation |
| Base branch resolution not robust | HIGH | Codex | Added explicit resolution step with fail-fast in Phase 1 step 4 |
| Merge lock heartbeat unspecified | MEDIUM | Opus | Specified: same 30s timer as slot heartbeat |
| Phase 1 re-clone can loop | LOW | Opus | Added one-shot guard: re-clone once, then block |
| "Surface for human" undefined | LOW | Opus | Defined: set task.status = blocked + blocked_reason, log ERROR |
| Edge case row 4 misleading | MEDIUM | Opus | Fixed wording to be accurate |

---

## 10. Implementation Checklist

### Pre-Implementation
- [ ] Review design against AGENTS.md rules (Simplification First, Determinism First, Root-Cause First)
- [ ] Verify `failure_count` / `conflict_count` / `blocked_reason` fields exist in task schema (or add migration)
- [ ] Confirm `global.db` migration path — no existing `workspace_pool_slots` or `workspace_merge_locks` tables

### Phase 1: DB Schema & Pool Slot Infrastructure
- [ ] Add `workspace_pool_slots` table migration to global.db
- [ ] Add `workspace_merge_locks` table migration to global.db
- [ ] Implement `src/workspace/pool.ts` — slot claim/release/heartbeat, origin URL resolution, full clone init
- [ ] Implement `src/workspace/git-lifecycle.ts` — `prepareForTask()`, `postCoderGate()`, `postReviewGate()`, `mergeToBase()`, `cleanupBranch()`
- [ ] Add local-only variants to git-lifecycle

### Phase 2: Pre-Coder Gate + Clone Replacement
- [ ] Update `src/parallel/clone.ts` to delegate to pool
- [ ] Update `src/commands/loop-phases.ts` `runCoderPhase()` to call `prepareForTask()`
- [ ] Remove JSON state file creation/reading

### Phase 3: Post-Coder Verification Gate
- [ ] Implement deterministic post-coder gate in `loop-phases.ts`
- [ ] Map `stage_commit_submit` to `submit` no-op in action parser
- [ ] Remove `stage_commit_submit` from orchestrator prompt

### Phase 4: Post-Review Push & Merge Pipeline
- [ ] Implement full Phase 5 pipeline in `runReviewerPhase()`
- [ ] Implement merge lock acquisition with 5min timeout + 30s poll
- [ ] Implement rebase + ff-only merge + push with bounded retries
- [ ] Implement reachability verification (`--is-ancestor`)
- [ ] Implement branch cleanup (remote + local)
- [ ] Wire up `failure_count` increment + `blocked_error` escalation at cap

### Phase 5: Reconciliation & CLI
- [ ] Implement `src/workspace/reconcile.ts` — stale slot + stale lock reclamation
- [ ] Wire reconciliation into runner startup
- [ ] Implement `steroids workspaces` CLI — list slots, manual cleanup, orphan branch deletion

### Testing & Validation
- [ ] Unit tests for pool slot claim/release/heartbeat
- [ ] Unit tests for git-lifecycle phases (mock git commands)
- [ ] Integration test: happy path (pickup → code → review → merge → done)
- [ ] Integration test: failure path (push fail → retry → success)
- [ ] Integration test: conflict path (rebase conflict → retry → block after 3)
- [ ] Integration test: stale slot reclamation
- [ ] Verify single-runner mode works with pool-0
- [ ] Verify local-only mode skips all remote operations

### Post-Implementation
- [ ] Remove old `createWorkspaceClone()` shallow clone path
- [ ] Remove old cherry-pick merge code (or gate behind flag)
- [ ] Update README.md with new `steroids workspaces` commands
- [ ] Smoke test on real project with parallel runners

---

## 11. Implementation Code Review

**Reviewers**: Mistral Devstral (vibe), OpenAI Codex, Google Gemini 2.5-pro. **Lens**: Race conditions, crash recovery, false success paths, slot lifecycle correctness.

### Findings and Decisions

| Finding | Severity | Source | Decision |
|---------|----------|--------|----------|
| `mergeToBase` returned `ok: true` when merged SHA unreachable from remote base (silent push failure) | HIGH | Codex | **Fixed** — changed to `ok: false, conflict: false` so failure count is incremented and task retries |
| Heartbeat starvation: `execFileSync` blocks event loop → `setInterval` heartbeats cannot fire during git clone (5 min timeout) or push retries (3×120s = 360s), causing reconciler to incorrectly reclaim active slots/locks | HIGH | Gemini | **Fixed** — extended slot TTL from 5 min → 10 min and merge lock TTL from 3 min → 10 min in `reconcile.ts` and `merge-lock.ts`. Note: outcome is not "git corruption" — `git push` rejects non-fast-forwards; actual result is unnecessary task retry |
| Slot released after coder phase; reviewer may claim different slot (slot affinity gap) | MEDIUM | Codex | **Deferred** — safe in single-runner mode (same idle slot reclaimed); multi-runner parallel risk documented. Follow-up: pin slot to task across coder→reviewer by keeping slot in `awaiting_review` status rather than releasing to idle |
| Slot creation UNIQUE constraint race fallback throws if no idle slot | LOW | Codex, Gemini | **Deferred** — `BEGIN IMMEDIATE` transaction makes this rare; `handleMergeFailure` retries safely |
| Non-null assertions (`slot.base_branch!`, `slot.task_branch!`) in `mergeToBase` | MEDIUM | Vibe, Gemini | **Defer** — safe invariant: `prepareForTask` always sets these fields before `mergeToBase` is called; add null guards in follow-up hardening pass |
| Busy-wait spin in merge lock polling (`while (Date.now() < end)`) | MEDIUM | Vibe, Gemini | **Defer** — acceptable since better-sqlite3 is synchronous; polling is bounded by 5-min timeout |
| Task re-execution risk: crash between base-branch push and marking task done | MEDIUM | Gemini | **Non-issue** — already documented in §6 edge case "Runner crashes after main push, before marking done". Rebase detects already-applied hunks; merge is a no-op. Wasted coder session, no data corruption |
| `reconcileStaleWorkspaces` returns `taskIds` unused by wakeup | LOW | Assessment | **Non-issue** — `selectNextTaskWithLock` (Priority 2) picks up `in_progress` tasks; tasks will be resumed automatically |
