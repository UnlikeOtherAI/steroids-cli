# Workspace Pool & Deterministic Git Lifecycle (Revised v8)

> Replace the current "clone-per-workstream" model with a fixed workspace pool and host-controlled git lifecycle. Every git operation (branch, reset, commit verification, push, rebase, cleanup) is deterministic — no LLM involvement. This revision addresses all critical, high, and medium findings from seven rounds of adversarial review by Claude Opus and OpenAI Codex.

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

The new design **preserves the merge lock** from `merge-lock.ts` and **serializes merge-to-main** through it. Cherry-pick is superseded by rebase + ff-only, but the serialization and crash recovery properties are kept.

---

## 3. Design

### 3.1 Workspace Pool

**Pool of workspace directories created lazily on demand.**

Location: `~/.steroids/workspaces/<projectHash>/pool-<index>/`

**Full clones only — no `--depth 1`**: Shallow clones break rebase and merge. Pool workspaces are always full clones:
```
git clone --no-tags <remoteUrl> pool-<index>/
```
If an existing slot was previously shallow (migration from old behavior), detect via `git rev-parse --is-shallow-repository` and run `git fetch --unshallow` before any operation.

**Remote URL validation**: `origin` must point to the actual remote URL (GitHub/GitLab/etc.), not the local project path. On pool slot initialization:
1. `git -C <projectPath> remote get-url origin` — get actual remote URL
2. If result is a local filesystem path, walk up: check if that local repo has its own remote
3. Store resolved `remoteUrl` in `workspace_pool_slots.remote_url` (see Section 3.2)
4. Clone using stored `remoteUrl`
5. If no remote can be resolved (local-only project): `remote_url = NULL`. All push/fetch operations are skipped; git operations are local-only (see Section 3.11).

**No hard cap on pool size**: Slots are created lazily. The natural cap is the number of active runners. Unused slots are garbage-collected by `steroids workspaces clean`.

### 3.2 Pool Slot Claiming — DB-Backed Leases (Global DB)

**The `.steroids-lock` file approach is eliminated.** PID-based file locks fail on macOS due to aggressive PID reuse.

Pool slot ownership is tracked in **the global database** (`~/.steroids/global.db`), alongside `workstreams` and `runners`. This is explicitly NOT the project DB — using the project DB (accessed via symlink from pool workspaces) introduces ambiguity about inode resolution across symlink paths. The global DB is the correct home for cross-runner coordination state.

#### New DB Table: `workspace_pool_slots` (in global.db)

```sql
CREATE TABLE workspace_pool_slots (
  id                INTEGER PRIMARY KEY,
  project_id        TEXT NOT NULL,
  slot_index        INTEGER NOT NULL,
  slot_path         TEXT NOT NULL,         -- absolute path to pool-<index>/
  remote_url        TEXT,                  -- resolved remote URL (NULL = local-only)
  runner_id         TEXT,                  -- NULL if idle
  task_id           TEXT,                  -- NULL if idle
  base_branch       TEXT,                  -- e.g. "main"
  task_branch       TEXT,                  -- e.g. "steroids/task-<uuid>"
  starting_sha      TEXT,                  -- git rev-parse HEAD at task pickup
  submission_sha    TEXT,                  -- git rev-parse HEAD after post-coder gate
  rebased_sha       TEXT,                  -- git rev-parse HEAD after successful rebase
  status            TEXT NOT NULL DEFAULT 'idle',
  -- 'idle' | 'coder_active' | 'awaiting_review' | 'review_active'
  -- | 'merging' | 'merge_pending' | 'conflict_resolution' | 'push_failed' | 'auth_failed'
  claimed_at        INTEGER,               -- ms since epoch
  heartbeat_at      INTEGER,               -- ms since epoch, refreshed every 30s
  claim_generation  INTEGER NOT NULL DEFAULT 0,
  conflict_attempts INTEGER NOT NULL DEFAULT 0,
  schema_version    INTEGER NOT NULL DEFAULT 1,  -- for migration guards
  UNIQUE(project_id, slot_index)
);
```

**Key addition from v2**: `rebased_sha` — the commit SHA after a successful rebase. This is distinct from `submission_sha` (pre-rebase) because rebase rewrites SHAs. All reachability checks use `rebased_sha`, never `submission_sha`.

**Claiming a slot** — transactional to prevent race conditions:
```sql
BEGIN IMMEDIATE;
  -- Find idle slot or determine next slot_index
  SELECT * FROM workspace_pool_slots
  WHERE project_id = ? AND status = 'idle'
  LIMIT 1;
  -- If none found: INSERT new slot with MAX(slot_index) + 1
  -- (or slot_index = 0 if no rows exist for this project)
  -- UNIQUE constraint violation means concurrent runner beat us → retry
UPDATE workspace_pool_slots
  SET runner_id = ?, task_id = ?, status = 'coder_active',
      claimed_at = ?, heartbeat_at = ?,
      claim_generation = claim_generation + 1
  WHERE id = ?;
COMMIT;
```
On UNIQUE constraint violation (two runners race to create the same slot_index): the losing runner retries the SELECT — the winning runner's slot now appears as non-idle, so the retrying runner proceeds to create the next index.

**Stale lease reclamation rules**:
- A slot is stale if `heartbeat_at < now - 5min`
- **Only the following statuses are eligible for 5-minute reclamation**: `coder_active`, `awaiting_review`, `review_active`
- **NEVER 5-minute reclaim** slots in `merging`, `merge_pending`, `push_failed`, `auth_failed` — these have defined recovery paths (see Section 3.10) that require inspecting the workspace state
- **`conflict_resolution` slots**: reclaimed after a longer 30-minute TTL (`heartbeat_at < now - 30min`). The longer window accommodates legitimate coder invocation time. On reclaim: reset slot to `idle`, return task to `pending` for full retry (see Section 3.10 step 1).

**Heartbeat**: runner refreshes `heartbeat_at` every 30 seconds while active. The heartbeat MUST also be refreshed within retry loops during push operations (see Phase 5 steps 7 and 9).

### 3.3 Task Git Lifecycle

The entire git lifecycle is host-controlled. The LLM may commit freely during coding but never runs branching, reset, push, rebase, or merge operations.

#### Phase 1: Task Pickup — Clean Slate

**This phase is SKIPPED when `slot.status = 'conflict_resolution'`** — see Section 3.9 (Conflict Resolution Phase). The workspace is preserved as-is.

```
1. If remote_url IS NULL: use local-only mode (see Section 3.11). Otherwise:

1b. Mid-rebase guard (run before any checkout):
    If .git/rebase-merge/ OR .git/rebase-apply/ OR .git/REBASE_HEAD exists:
      git rebase --abort
      (Tolerate exit 128 / "fatal: no rebase in progress" — NOT a fatal error.
       The sentinel file check makes this case extremely unlikely, but exit 128 must
       not cause the phase to abort. Any other non-zero exit is a real error.
       Defense-in-depth: if git rebase --abort exits 128 despite sentinel files being
       present (filesystem/git state inconsistency), the subsequent step 5 clean-state
       check will detect remaining dirty state and trigger a workspace re-clone.)
    Sentinel coverage:
      .git/rebase-merge/  — merge backend (default since git 2.26+)
      .git/rebase-apply/  — apply backend (legacy, --apply flag)
      .git/REBASE_HEAD    — interactive rebase mid-conflict stop (can exist
                            without rebase-merge/ in partial-cleanup edge cases)
    This handles workspaces left in mid-rebase state by a crashed runner or a coder
    that ran git rebase during conflict resolution. Without this, step 3's
    git checkout fails with "You are in the middle of a rebase."

2. git fetch origin
   (full fetch — fetches all new objects and branch tips)

3. git checkout <baseBranch>
   git reset --hard origin/<baseBranch>

4. git clean -fd -e .steroids
   (NO -x flag. Preserves gitignored files: node_modules/, .env, dist/, build caches.
    -e .steroids excludes the symlinked steroids metadata directory.
    Note: .git/info/exclude already lists .steroids via ensureWorkspaceGitExcludesSteroids()
    — this is a defense-in-depth exclusion.)

5. Verify: git status --porcelain == empty
   - If non-empty: workspace corrupt. Delete directory, re-clone from remoteUrl. Log error.

6. Record startingSha = git rev-parse HEAD

7. git checkout -b steroids/task-<fullTaskId>
   (full UUID, not truncated — no collision risk)

8. Update DB: slot.status = 'coder_active', .task_id, .task_branch, .base_branch,
              .starting_sha = startingSha, .rebased_sha = NULL, .conflict_attempts = 0
```

Base branch defaults to `main`, fallback to `master`.

#### Phase 2: Coder Execution

The coder runs in the workspace directory on the task branch. Read, write, and commit freely. Host does not interfere.

#### Phase 3: Post-Coder Verification Gate

After coder exits:

```
1. Check: git status --porcelain
   - If non-empty (uncommitted work):
     a. git add -A
     b. git commit -m "feat: implement <taskTitle> (auto-committed by steroids)"

2. Check: git log startingSha..HEAD --oneline
   - If empty (no commits since task pickup):
     → Return task to coder: "No changes detected. Make code changes and commit."
     → slot.status remains 'coder_active'

3. Record submissionSha = git rev-parse HEAD
4. Update DB: slot.status = 'awaiting_review', .submission_sha = submissionSha
```

#### Phase 4: Review Execution

Reviewer examines diff between `startingSha` and `HEAD`. DB: `slot.status = 'review_active'`.

#### Phase 5: Post-Review Verification Gate

```
1. Check: git status --porcelain
   - If non-empty (reviewer left uncommitted changes):
     a. Log warning: "Reviewer left uncommitted changes — discarding"
     b. git checkout -- .
     c. git clean -fd
     d. Continue (do NOT commit reviewer changes)

2. Verify: git rev-parse HEAD == submissionSha
   - If HEAD != submissionSha: log anomaly (reviewer may have amended a commit).
     This is a WARNING only, not a hard failure. Record in logs and continue.
     (Changed from hard failure in v2 — reviewer --amend would spuriously block tasks.)

3. Verify: git log startingSha..HEAD --oneline is non-empty
   - If empty: fatal error, escalate.

4. Acquire merge lock (merge-lock.ts pattern, 3min TTL, 30s heartbeat).
   **Cross-DB ordering contract** (global.db slot + project.db merge lock):
   - ON ACQUIRE: Update slot.status = 'merging' in global.db FIRST, then acquire merge lock in project.db.
     If lock acquisition fails after slot update: reset slot.status back to previous state.
   - ON RELEASE: Release merge lock in project.db FIRST, then update slot.status in global.db.
     Crash between release and slot update: reconciliation sees stale 'merging' slot with no lock held
     → checks rebased_sha → recovers deterministically (Case A or B in reconciliation step 3).
   This ordering ensures recovery logic can always determine state from slot status + rebased_sha alone.
   Wait strategy: poll every 5s, max wait 90s.
   If cannot acquire in 90s:
     - Update DB: slot.status = 'merge_pending'
       (Slot remains claimed. task_id, task_branch, submission_sha all intact.
        merge_pending is a SLOT status, NOT a task status. The task stays in 'review'.)
     - Do NOT release the slot to idle.
     - STOP. Reconciliation step 5 will retry Phase 5 step 4 for this slot.
   On acquisition: Update DB: slot.status = 'merging'

5. git fetch origin <baseBranch>
   Refresh heartbeat after fetch completes.

6. Rebase task branch:
   a. git rebase origin/<baseBranch>
   b. If success:
      - Record rebasedSha = git rev-parse HEAD
      - Update DB: slot.rebased_sha = rebasedSha
      - Continue to step 7
   c. If conflicts:
      - git rebase --abort
      - Release merge lock
      - Update DB: slot.status = 'conflict_resolution',
                   slot.conflict_attempts = conflict_attempts + 1
      - Enter Section 3.9 (Conflict Resolution). STOP.

7. Push updated task branch:
   git push origin steroids/task-<taskId> --force-with-lease
   (SHAs changed after rebase — force-with-lease is correct)
   Retry policy: 3x with backoff (1s, 4s, 16s). Refresh heartbeat between retries.
   - On auth error (401/403): release merge lock, mark slot.status = 'auth_failed'
     (NOT 'push_failed' — auth_failed is in the slot status enum and bypasses the
      push_failed auto-retry loop. task_id and slot remain claimed.), mark task 'auth_failed'.
     STOP. (Auth errors don't self-heal; human must fix credentials.)
   - On transient error, all retries exhausted: release merge lock,
     mark slot.status = 'push_failed'. STOP.
     (Slot stays claimed. On next wakeup, reconciliation re-enters Phase 5 from step 4.)

8. Merge to base branch (still holding merge lock):
   a. git checkout <baseBranch>
   b. git reset --hard origin/<baseBranch>
      (Reset to the exact tip fetched in step 5 — rebase was against this tip,
       so ff-only is guaranteed.)
   c. git merge --ff-only steroids/task-<taskId>
      - If ff-only succeeds: continue.
      - If ff-only fails (unexpected):
        i.  Re-attempt: git fetch origin <baseBranch>,
                         git rebase origin/<baseBranch>,
                         git reset --hard origin/<baseBranch>,
                         git merge --ff-only steroids/task-<taskId>
           (Re-rebase handles the case where base advanced between our fetch and merge,
            e.g., after a crash-and-restart where base moved during downtime.)
        ii. Update rebasedSha after re-rebase: rebasedSha = git rev-parse HEAD (task branch)
        iii. If second ff-only also fails: fatal invariant violation.
             Release merge lock, escalate to human. Preserve task branch.

9. Push base branch:
   git push origin <baseBranch>
   Retry policy: 3x with backoff (2s, 8s, 32s). Refresh heartbeat between retries.
   - On auth error: release merge lock, mark slot.status = 'auth_failed'
     (NOT 'push_failed' — same reasoning as step 7), mark task 'auth_failed'. STOP.
   - On transient error, all retries exhausted: release merge lock,
     mark slot.status = 'push_failed'. STOP.
     (Local baseBranch has the merge committed but not pushed.
      On retry: reconciliation detects push_failed, re-acquires lock, checks if already
      merged via rebasedSha, and if not: re-pushes baseBranch.)

10. Release merge lock.

11. Verify reachability — confirm push succeeded:
    a. git fetch origin <baseBranch>
    b. git merge-base --is-ancestor <rebasedSha> origin/<baseBranch>
       (Ancestry check, NOT exact equality. Exact equality would produce false positives:
        if another runner acquires the merge lock and pushes their task between step 10
        (our lock release) and step 11 (our verify), origin/<baseBranch> advances past
        rebasedSha. Our push succeeded; the check must not punish us for concurrent activity.
        Since rebasedSha was ff-only merged, it will always be an ancestor of any future
        commits built on top of it.)
    - If not ancestor: fatal. Our commits are genuinely not on the remote.
      Escalate to human. Do NOT delete task branch.

12. Cleanup (only after step 11 passes):
    a. git push origin --delete steroids/task-<taskId>
       - Scoped deletion: only delete if this branch's task ID is in our DB.
         (Prevents accidentally deleting branches from other tooling using same prefix.)
       - If fails: log, continue. Orphan remote branches are minor — reconciliation handles.
    b. git branch -D steroids/task-<taskId>
    c. git checkout <baseBranch> && git reset --hard origin/<baseBranch>

13. Mark task done in database.
14. Update DB: slot.status = 'idle', clear task_id, task_branch, starting_sha,
               submission_sha, rebased_sha
```

#### `push_failed` Re-Entry Protocol

When reconciliation finds a slot with `status = 'push_failed'` (slot is still claimed, workspace intact):

```
1. Re-acquire merge lock.

2. git fetch origin <baseBranch>

3. Check if already merged:
   If slot.rebased_sha IS NULL: skip this check, proceed to step 4 (treat as not-yet-merged).
   git merge-base --is-ancestor slot.rebased_sha origin/<baseBranch>
   - If command errors with "not a valid object name" (rebased_sha is not in the local
     object store, e.g., after a workspace re-clone since the original rebase):
     → Treat as "not yet merged". Proceed to step 4.
   - If ancestor:
     → Already merged (perhaps by another process or a previous partial retry,
        or the push succeeded before the crash but was not recorded; another runner
        may have pushed on top — ancestry check handles that correctly).
     → Skip to Phase 5 step 12 (cleanup).
   (Ancestry check, NOT exact equality. Exact equality fails when: our base-branch push
    succeeded but the crash prevented recording it, then another runner pushed on top —
    remoteHead != rebased_sha but rebased_sha IS an ancestor. Exact equality would
    incorrectly proceed to re-push, fail with non-fast-forward, and enter a livelock.
    Same reasoning as Phase 5 step 11.)

4. Determine workspace state (git rev-parse --abbrev-ref HEAD):
   a. If on task branch (rebase done, task-branch push failed):
      If slot.rebased_sha IS NULL: inconsistent state (push_failed + task branch + NULL
        rebased_sha should not occur normally). Fall through to step 4c (reset to idle).
      Otherwise:
        git push origin HEAD:steroids/task-<taskId> --force-with-lease=steroids/task-<taskId>:<rebased_sha>
        (Explicit expected SHA from slot.rebased_sha prevents stale tracking-ref lease
         violations after a crash — the local tracking ref may not reflect the last push.
         If remote already has this SHA: git exits 0 "Everything up-to-date" — idempotent.)
        - On success: Continue from Phase 5 step 8 (merge to base).
        - On auth error: release merge lock, mark slot.status = 'auth_failed',
          mark task 'auth_failed'. STOP.
        - On transient error, all retries exhausted: mark slot.status = 'push_failed'. STOP.
   b. If on baseBranch:
      → Check if local merge was committed:
        localAhead = git log origin/<baseBranch>..HEAD --oneline
        (This check MUST run before any git reset — after a reset, localAhead is always empty.)
        - If localAhead is NON-EMPTY (merge committed locally, base push failed):
          → Attempt re-push (Phase 5 step 9 retry policy):
            git push origin <baseBranch>
            - On success: Continue from Phase 5 step 10 (release lock).
            - On auth error: release merge lock, mark slot.status = 'auth_failed',
              mark task 'auth_failed'. STOP.
            - On non-fast-forward failure (another runner pushed to origin/<baseBranch>
              between our original push failure and this re-entry — the locally committed
              merge is now stale against the advanced remote):
              → Enter re-merge path below.
              (step B.iii discards the stale local merge; re-merges against current tip)
            - On transient, all retries exhausted: mark slot.status = 'push_failed'. STOP.
        - If localAhead is EMPTY OR re-push failed with non-fast-forward:
          → Re-merge path:
            B.i.   Verify task_branch exists locally:
                   git rev-parse --verify steroids/task-<taskId>
                   - If NOT found: task branch was deleted. Fall through to step 4c.
            B.ii.  git checkout <task_branch>
            B.iii. git checkout <baseBranch> && git reset --hard origin/<baseBranch>
                   (resets to current remote tip, discarding any locally committed merge —
                    idempotent: works whether or not a merge was previously committed)
            B.iv.  git merge --ff-only <task_branch>
                   - If success: push (step B.v)
                   - If ff-only FAILS (base advanced past rebased_sha):
                     a. git checkout <task_branch>
                     b. git rebase origin/<baseBranch>
                        - If success: update slot.rebased_sha = git rev-parse HEAD
                          git checkout <baseBranch>
                          git reset --hard origin/<baseBranch>
                          git merge --ff-only <task_branch>
                          (now guaranteed to succeed — just rebased against current tip)
                        - If conflicts: git rebase --abort
                          Release merge lock.
                          Slot → 'conflict_resolution', conflict_attempts++.
                          Enter Section 3.9 (Conflict Resolution). STOP.
            B.v.   git push origin <baseBranch> (with Phase 5 step 9 retry policy)
                   - On auth error: release merge lock, mark slot.status = 'auth_failed',
                     mark task 'auth_failed'. STOP.
                   - On transient, all retries exhausted: mark slot.status = 'push_failed'. STOP.
            → Continue from Phase 5 step 10 (release lock).
   c. If on unexpected branch, task branch deleted, or HEAD is detached:
      → Release merge lock. Reset slot to idle. Task returns to 'pending' for full retry.

5. Continue Phase 5 from the appropriate step (as above).
```

### 3.4 Branch Naming

- Task branches: `steroids/task-<fullTaskId>` — full UUID, no truncation.
- No LLM-chosen names. No session-based names.

### 3.5 Merge Policy — Rebase + ff-only Only

**Strategy**: rebase task branch onto `origin/<baseBranch>` tip → ff-only merge.

After a successful rebase against the exact tip that `baseBranch` is reset to, ff-only is guaranteed to succeed. If it doesn't on the first attempt (e.g., after a crash-and-restart where base advanced), one re-rebase + retry is attempted before escalating.

**No squash**: squash invalidates `submission_sha` (stored SHA unreachable from main) and breaks bisect/blame. Commit history is preserved.

### 3.6 Conflict Resolution Strategy

1. **Programmatic rebase** (holding merge lock): if no conflicts, done.
2. **Coder-assisted resolution** (Section 3.9): workspace preserved, coder resolves in-place.
   Up to 2 conflict events before escalation. A "conflict event" is: a rebase conflict
   (Phase 5 step 6c) OR a coder invocation that produces no commits (Section 3.9 step 4d).
   This allows e.g.: one real coder attempt (commits something) + one subsequent rebase failure,
   or one rebase failure + one no-commit coder invocation. In the no-commit case, the coder
   is escalated after one invocation — a coder that makes no progress is a strong signal.
3. **Manual escalation**: `blocked_conflict` after 2 conflict events. Slot reset, dashboard surfaced.

### 3.7 Single-Runner Mode

Pool has exactly 1 slot (`pool-0/`). Lifecycle is identical. Merge lock is still acquired.

### 3.8 Parallel Mode — Merge Lock Wait Strategy

Merge-to-main is serialized by the DB-backed merge lock. **Wait strategy for blocked runners**:
- Poll every 5 seconds for lock availability
- Maximum wait: 90 seconds
- If still blocked after 90s: release attempt, mark task `merge_pending`, pick up a different task
- `merge_pending` tasks are re-queued by reconciliation on next wakeup

**Heartbeat coverage**: the heartbeat MUST be refreshed between every retry attempt in Phase 5 steps 7 and 9. The implementation must not simply hold a single heartbeat timer — it must actively refresh within the retry loops. Failure to refresh causes lock expiry during slow network operations, enabling another runner to re-acquire the lock mid-merge.

Lock TTL: 3 minutes. Heartbeat interval: 30 seconds.

**`merge_pending` implicit bound**: `merge_pending` slots have no TTL (Section 3.2). The implicit bound is the merge lock's 3-minute TTL: if the lock holder crashes, the lock expires in ≤3min, and the next wakeup cycle can acquire it and unblock the `merge_pending` slot. Under the spec's bounded retry policy (steps 7 and 9: max 3 retries with ≤42s total backoff), a live lock holder MUST release the lock within a finite, bounded time. A `merge_pending` slot therefore waits at most: lock TTL (3min) + wakeup interval (≤60s) in the crash case, or ≤90s wait + wakeup interval in the contention case. Implementation note: if a future change introduces unbounded retries, a `merge_pending` staleness TTL should be added.

### 3.9 Conflict Resolution Phase

Entered from Phase 5 step 6c. **Phase 1 is unconditionally skipped.** Workspace stays on task branch with original commits intact.

**Entry guard**: Before invoking the coder, the runner checks `slot.status`. If `conflict_resolution`, it calls `runConflictResolutionPhase()` — a dedicated function that does NOT call `prepareForTask()` (Phase 1). This is enforced in code, not just in the prompt.

**Branch verification**: After coder exits in conflict resolution mode, the host verifies:
```
currentBranch = git rev-parse --abbrev-ref HEAD
if currentBranch != slot.task_branch:
  → Coder switched branches. Discard session.
  → Reset workspace: git checkout <task_branch> (if it exists), git clean -fd
  → If task_branch no longer exists: mark slot idle, task returns to 'pending' (full retry)
```
This is the programmatic guard against the coder running `git checkout main` or similar.

```
State on entry:
  - Workspace on task branch (post rebase --abort, original commits intact)
  - DB: slot.status = 'conflict_resolution', slot.conflict_attempts = N

1. Check conflict_attempts:
   - If conflict_attempts >= 2:
     (A "conflict event" is a rebase conflict OR a no-commit coder invocation.
      With threshold 2: e.g. conflict+coder-no-commit = 2 events → block.
      A coder that commits but triggers another conflict also accumulates 2 events → block.
      This is intentional: "up to 2 conflict events" not "2 coder invocations."
      See Section 3.6 for the rationale.)
     → Mark task 'blocked_conflict'
     → Run Phase 1 clean-slate (reset workspace to main)
     → DB: slot.status = 'idle', clear task fields
     → Surface for human intervention

2. Gather conflict context:
   diffStats = git diff origin/<baseBranch>...HEAD --stat

3. Invoke coder (via runConflictResolutionPhase(), NOT runCoderPhase()):
   Prompt includes:
   - Current branch name (verified to be task_branch)
   - Conflict diff stats
   - Explicit instruction: "Do NOT run git checkout, git switch, git reset, or git branch commands"
   - Explicit instruction: "Resolve conflicts by editing files, then git add and git commit"

4. After coder exits:
   a. Verify still on task_branch (see branch verification above)
   b. Run Phase 3 (post-coder gate)
   c. If coder committed: re-enter Phase 5 from step 4 (acquire merge lock, re-attempt rebase)
   d. If coder made no commits:
      conflict_attempts++  ← MUST increment here (not just in Phase 5 step 6c)
      Update DB: slot.conflict_attempts = conflict_attempts
      Return to step 1. (Without this increment, a coder that never commits would
      loop indefinitely — step 1's conflict_attempts >= 2 check would never trigger.)
```

### 3.10 Startup Reconciliation

On every runner start, before claiming a pool slot:

**Step 1 — Stale slot reclamation**:
- 5-minute TTL reclamation — `heartbeat_at < now - 5min` AND `status IN ('coder_active', 'awaiting_review', 'review_active')`:
  → Reset to `idle`, clear task fields, return task to `pending`
- 30-minute TTL reclamation — `heartbeat_at < now - 30min` AND `status = 'conflict_resolution'`:
  → Reset to `idle`, clear task fields, return task to `pending`
  (Longer window because legitimate coder invocations take time)
- `status IN ('merging', 'merge_pending', 'push_failed', 'auth_failed')`: NOT reclaimed by time — handled by steps 3, 4, and 5 below

**Step 2 — Orphan branch detection** (scoped):
- List all `steroids/task-*` branches on remote
- For each branch, extract task UUID and look up in local DB:
  - If task UUID exists in local DB AND task is in a terminal/idle state → delete branch
  - If task UUID NOT in local DB → do NOT delete (could belong to another installation or machine)
- **Age-based TTL fallback** (for the DB-wipe / reinstall scenario): delete branches where task UUID is NOT in local DB AND the most recent commit's **committer date** is older than 30 days. The 30-day window is conservative enough to avoid deleting branches from another active machine.
  (Committer date: `git log --format="%cI" -1 origin/steroids/task-<uuid>` — use committer date, NOT author date (`%aI`). Rebase preserves author dates but updates committer dates, so committer date correctly reflects when the branch was last rebased/touched.)

**Step 3 — Stale 'merging' slots (heartbeat expired)**:
- Find slots where `status = 'merging'` AND `heartbeat_at < now - 5min`
- Branch on `rebased_sha`:

  **Case A — `rebased_sha IS NOT NULL`** (rebase completed before crash):
  - git fetch origin <baseBranch>
  - git merge-base --is-ancestor rebased_sha origin/<baseBranch>?
    - If command errors with "not a valid object name" (rebased_sha not in local object
      store, e.g., after a workspace re-clone since the crash): treat as "not yet merged".
      Enter push_failed re-entry (Section 3.3). The re-entry workspace checks will
      determine the correct recovery path.
    - If yes (ancestor): already merged. Proceed to Phase 5 step 12 (cleanup).
    - If no: enter push_failed re-entry (Section 3.3).

  **Case B — `rebased_sha IS NULL`** (crash during rebase before it completed):
  - Run mid-rebase guard on workspace: if `.git/rebase-merge/` or `.git/rebase-apply/` or
    `.git/REBASE_HEAD` exists, run `git rebase --abort` to restore workspace to the task branch
    state (original commits intact).
    (Tolerate exit 128 / "fatal: no rebase in progress" — NOT a fatal error. Same rule as Phase 1 step 1b.)
  - Reset slot to `idle`. Clear task fields. Return task to `pending` for full retry.
  - (Phase 1 will do a full clean reset on next pickup via the mid-rebase guard in step 1b.)

- **Schema version guard**: skip this step for slots with `schema_version < 1` (legacy slots)

**Step 4 — push_failed / auth_failed recovery**:
- Find slots with `status = 'push_failed'`
- Re-enter push_failed re-entry protocol (Section 3.3)
- For `status = 'auth_failed'`: do NOT auto-retry. Surface in dashboard for human to fix credentials, then manually re-queue.

**Step 5 — merge_pending slots**:
- Find slots with `status = 'merge_pending'` (NOT task status — `merge_pending` is slot-only)
- These slots are claimed with `task_id`, `task_branch`, `submission_sha` all intact
- The workspace is in post-review state (on task branch, commits present since startingSha)
- Re-enter Phase 5 from step 4 (attempt to acquire merge lock)
- If merge lock still unavailable: slot status stays `merge_pending`, retry on next wakeup

### 3.11 Local-Only Mode

When `slot.remote_url IS NULL` (no remote configured):

**Phase 1 modifications**:
- Skip `git fetch origin`
- `git checkout <baseBranch> && git reset --hard <baseBranch>` (no `origin/` prefix)
- `git clean -fd -e .steroids` (unchanged)

**Phase 5 modifications**:
- Steps 5 (fetch), 7 (push task branch), 9 (push base branch), 11 (remote verify): all skipped
- Rebase (step 6): `git rebase <baseBranch>` (local branch, no `origin/` prefix)
- Merge (step 8): `git checkout <baseBranch> && git reset --hard <baseBranch> && git merge --ff-only steroids/task-<taskId>`
- After local merge: task is marked complete. Work is on local `<baseBranch>`.
- Cleanup step 12a (delete remote branch): skipped. Step 12b–c: unchanged.

**Startup reconciliation**: skip remote fetch steps for local-only slots.

### 3.12 Orchestrator Compatibility: `stage_commit_submit`

Keep `stage_commit_submit` as a recognized no-op in the action parser — map to `submit`. Remove from orchestrator prompt as a follow-up after the gate is confirmed in production.

---

## 4. What Changes vs. Current System

| Aspect | Current | New |
|--------|---------|-----|
| Workspace creation | New shallow clone per workstream | Full clone, fixed pool, reuse via reset |
| Clone depth | `--depth 1` (shallow) | Full — required for rebase |
| Pre-task gitignored files | Whatever the workspace has | Preserved (`-fd` without `-x`) |
| Pool slot claiming | PID file lock | DB-backed lease in global.db: TTL + heartbeat + claim_generation |
| Workspace state tracking | DB + JSON state file | DB only — `workspace_pool_slots` in global.db |
| `origin` remote | Local filesystem path | Validated real remote URL |
| Post-coder commit check | LLM trust + auto-commit fallback | Deterministic gate |
| Post-review uncommitted changes | Auto-commit | Discard with warning |
| Merge lock | Per-merge, cherry-pick-tied | Extended TTL + heartbeat in retry loops |
| Merge strategy | Cherry-pick integration workspace | Rebase + ff-only from pool workspace |
| Reachability verification | None | `git merge-base --is-ancestor rebased_sha origin/<baseBranch>` (handles concurrent post-lock pushes) |
| Merge policy | Cherry-pick | Rebase + ff-only (no squash fallback) |
| Merge serialization | None | DB merge lock, 90s max wait, `merge_pending` fallback |
| Branch cleanup | None | After confirmed remote-tip match, scoped deletion |
| Conflict resolution workspace | Fresh context | Workspace preserved; dedicated phase function |
| Phase 6 coder branch guard | None | `git rev-parse --abbrev-ref HEAD` verified after coder exits |
| `push_failed` recovery | Task marked failed | Slot kept claimed; explicit re-entry protocol |
| Auth vs. transient error | Combined | Separate: auth not retried, transient retried 3x |
| Startup reconciliation | None | Stale slots, orphan branches, incomplete merges, push_failed |
| Local-only projects | Push attempted, fails | Detected at init; local-only merge path |
| `stage_commit_submit` | Orchestrator-decided | Recognized no-op |

---

## 5. Implementation Order

### Phase 1: DB Schema & Pool Slot Infrastructure
1. Migration: `workspace_pool_slots` table in global.db (Section 3.2 schema)
2. `src/workspace/pool.ts` — transactional slot claim/release/heartbeat; origin URL resolution; full clone init; shallow detection + unshallow
3. `src/workspace/git-lifecycle.ts` — `prepareForTask()`, `postCoderGate()`, `postReviewGate()`, `mergeToBase()`, `cleanupBranch()`, local-only variants

### Phase 2: Pre-Coder Gate + Clone Replacement
4. Update `src/parallel/clone.ts` — delegate to pool
5. Update `src/commands/loop-phases.ts` `runCoderPhase()` — call `prepareForTask()`, route `conflict_resolution` slots to `runConflictResolutionPhase()`
6. Remove JSON state file creation/reading everywhere

### Phase 3: Post-Coder Verification Gate
7. Update `src/commands/loop-phases.ts` — deterministic verification gate in place of current git-state gathering
8. Parser: keep `stage_commit_submit` as no-op

### Phase 4: Post-Review Push & Merge Pipeline
9. `src/commands/loop-phases.ts` `runReviewerPhase()` — full Phase 5 pipeline
10. `src/git/push.ts` — `pushWithMergeLock()`, `mergeToBase()`, `verifyReachability()`, `cleanupBranch()`
11. Extend `src/parallel/merge-lock.ts` — 3min TTL, heartbeat within retry loops, 90s caller-side wait with `merge_pending` fallback

### Phase 5: Conflict Resolution
12. `runConflictResolutionPhase()` in `src/commands/loop-phases.ts` — branch guard, workspace preservation, push_failed re-entry

### Phase 6: Startup Reconciliation & CLI
13. `src/workspace/reconcile.ts` — all reconciliation steps from Section 3.10
14. Call reconcile on runner start
15. `steroids workspaces` CLI — list pool slots, DB lease status, manual cleanup

---

## 6. Edge Cases

| Scenario | Handling |
|----------|----------|
| Runner crashes mid-coder | Heartbeat expires. Reconciliation reclaims eligible stale slot (`coder_active`). Phase 1 on next pickup. Coder work lost — acceptable, task retries. |
| Runner crashes during rebase (Phase 5 step 6) | `status = 'merging'`, heartbeat expires, `rebased_sha = NULL`. Reconciliation: stale merging slot, no rebased_sha → treat as push_failed re-entry from top. Re-acquire lock, re-fetch, re-rebase. |
| Runner crashes after rebase, before push | `rebased_sha` is set. Reconciliation: `origin/<baseBranch>` tip != `rebased_sha` → enter push_failed re-entry. Workspace is on rebased task branch. Re-push task branch, merge, push base. |
| Runner crashes after main push, before cleanup | Reconciliation: `origin/<baseBranch>` tip == `rebased_sha` → already merged. Proceed to cleanup. Task branch is an orphan — reconciliation orphan step deletes it. |
| Coder makes zero changes | Post-coder gate rejects. Task returned with "no changes" note. |
| Coder leaves uncommitted work | Post-coder gate auto-commits. Reviewer sees clean state. |
| Reviewer leaves uncommitted changes | Post-review gate discards with warning. Proceeds with coder's committed work. |
| Coder switches branches in Phase 6 | Branch verification detects. Session discarded. Task branch restored if possible; else slot reset, task retries from scratch. |
| Phase 6 coder fails to resolve twice | `blocked_conflict`. Slot reset. Dashboard surfaced. |
| Shallow clone detected in existing slot | `git fetch --unshallow` before any rebase. Log migration warning. |
| Pool slot directory corrupted | git command fails → delete directory, re-clone. |
| Local-only project | `remote_url = NULL`. Local-only code path throughout. Work merges to local base branch. |
| Two runners compete for merge lock | Second runner waits up to 90s polling. If still blocked: slot status → `merge_pending` (slot stays claimed, workspace intact). Runner picks up different task. Reconciliation re-enters Phase 5 step 4 on next wakeup. |
| `push_failed` on task-branch push | Slot kept claimed. Re-entry: re-acquire lock, check if already merged, re-push task branch, continue merge. |
| `push_failed` on base-branch push (merge committed) | Slot kept claimed. Re-entry: re-acquire lock, `git log origin/<baseBranch>..HEAD` is non-empty → re-push base branch. |
| `push_failed` on base-branch push (crash pre-merge, workspace on baseBranch) | Slot kept claimed. Re-entry: `git log origin/<baseBranch>..HEAD` is empty → checkout task branch, checkout baseBranch, ff-only merge, push. |
| `conflict_resolution` slot orphaned by runner crash | 30-minute TTL. Reconciliation step 1 resets slot to idle, task returns to pending for full retry. |
| Orphan branches accumulate after DB wipe/reinstall | 30-day age-based TTL fallback in reconciliation step 2. Branches older than 30 days with no matching task UUID are deleted. |
| Auth failure on push | Task `auth_failed`. Not auto-retried. Human fixes credentials, manually re-queues task. |
| ff-only fails after successful rebase | One retry: re-fetch, re-rebase, reset base, retry ff-only. If still fails: escalate. |
| New runner installed on upgraded system | `schema_version` guard in reconciliation skips incomplete-merge check for legacy slots. |
| Orphan branch from external tooling with same prefix | Reconciliation only deletes branches whose task UUID exists in local DB as terminal. External branches untouched. |

---

## 7. Non-Goals

1. **Multi-repo support**: One workspace pool per git repo.
2. **Cherry-pick merge strategy**: Deprecated. Remains in codebase but not primary path.
3. **Workspace sharing between runners**: Each pool slot exclusively owned by one runner.
4. **LLM-driven git operations**: All lifecycle operations are host-controlled.
5. **Squash merge**: Explicitly excluded — invalidates stored SHAs, breaks audit trail.
6. **Batched merge to main**: Each approved task merges immediately.
7. **Enforcing LLM cannot run git**: The LLM is instructed not to run certain git commands during conflict resolution, and the host verifies branch after the fact. Preventing all git use by the LLM during coding is a non-goal.

---

## 8. Resolved Questions

1. **Squash vs. preserve commits?** → Preserve. Rebase + ff-only preserves all coder commits. Squash is non-goal.
2. **Immediate vs. batched merge?** → Immediate.
3. **Merge serialization mechanism?** → DB merge lock with 90s caller wait + `merge_pending` fallback.
4. **Pool slot lock mechanism?** → DB-backed lease in global.db.
5. **State file?** → Eliminated. `workspace_pool_slots` in global.db is the single source of truth.
6. **`git clean` flags?** → `git clean -fd -e .steroids` (no `-x`).
7. **Clone depth?** → Full clone. No `--depth 1`.
8. **Branch name format?** → Full task UUID.
9. **`origin` remote URL?** → Validated real remote URL stored in DB at initialization.
10. **Reachability check SHA?** → `rebased_sha` (post-rebase), not `submissionSha` (pre-rebase). Check: `git merge-base --is-ancestor rebased_sha origin/<baseBranch>` — ancestry, not exact equality, to correctly handle concurrent pushes between lock release and verify.
11. **`push_failed` recovery?** → Slot kept claimed. Explicit re-entry protocol. Reconciliation covers both task-branch and base-branch push failure.
12. **Phase 6 Phase-1 bypass?** → Enforced in code via `runConflictResolutionPhase()` routing on `slot.status`. Not just a prompt instruction.
13. **Local-only projects?** → Supported. Merge to local base branch. No push operations.
14. **Which DB for pool slots?** → Global DB (`~/.steroids/global.db`), alongside `workstreams` and `runners`.

---

## 9. Cross-Provider Review Summary

### Round 1 Findings → All Adopted in v2

Shallow clone, state file, PID lock, `git clean -fdx`, post-review auto-commit, conflict return path, merge serialization, merge-to-main architectural regression, branch deletion ordering, origin URL validation, Phase 5 crash recovery, `stage_commit_submit` migration, branch name truncation.

### Round 2 Critical Findings → Fixed in v3

- **`submissionSha` wrong SHA for reachability**: Introduced `rebased_sha` field. (Both reviewers)
- **`push_failed` undefined re-entry**: Slot kept claimed; explicit re-entry protocol. (Both reviewers)

### Round 2 High Findings → Fixed in v3

- **Phase 6 no programmatic guard**: `runConflictResolutionPhase()` routing + branch verification. (Both)
- **`workspace_pool_slots` in wrong DB**: Explicitly global.db. (Opus)
- **Lazy slot creation race**: Transactional claim with UNIQUE retry. (Both)
- **Merge lock blast radius / heartbeat**: Heartbeat in retry loops; 90s wait with `merge_pending` slot status. (Both)
- **`local_only` silently loses work**: Local-only merge path (Section 3.11). (Opus)
- **ff-only failure not always invariant**: One re-rebase retry before escalation. (Opus)

### Round 3 Findings → Fixed in v4

- **`merge_pending` ghost state** (Medium, both): Added to slot status enum. Slot stays claimed. NOT a task status. Reconciliation step 5 targets `merge_pending` slots.
- **Reachability check false positive under concurrent pushes** (High, Codex): Changed Phase 5 step 11 to `--is-ancestor` (not exact equality).
- **`conflict_resolution` slots never reclaimed on crash** (High, Codex): Added 30-minute TTL reclamation in reconciliation step 1.
- **`push_failed` re-entry 4b pre-merge state** (High, Codex): Re-entry inspects `git log origin/<baseBranch>..HEAD` to detect pre-merge crash; performs local merge if needed.
- **Orphan branch cleanup after DB wipe** (Medium, Codex): Added 30-day committer-date TTL fallback.

### Round 4 Findings → Fixed in v5

- **Mid-rebase workspace breaks Phase 1 checkout** (Medium, both): Added `git rebase --abort` guard as Phase 1 step 1b. Runs before any `git checkout`, handles workspace left in mid-rebase state by crashed runner or rogue coder git commands.
- **Stale `merging` + `rebased_sha=NULL` permanently orphaned** (Medium, both): Reconciliation step 3 now handles Case B (`rebased_sha IS NULL`) explicitly — aborts in-progress rebase, resets slot to idle, task to pending.
- **`push_failed` 4b ff-only failure if base advanced pre-lock** (Medium, Codex): Added re-rebase retry in the empty-localAhead recovery path. If ff-only fails: re-rebase task branch against current origin; if conflicts: enter Section 3.9.
- **Orphan branch TTL uses author date** (Medium, Codex / Low, Opus): Switched to committer date (`%cI`) which correctly reflects last rebase/push activity.
- **Cross-DB ordering has no explicit contract** (Medium, Codex): Added ordering contract to Phase 5 step 4: slot update BEFORE lock acquire; lock release BEFORE slot update. Ensures recovery from any crash is deterministic via slot status + rebased_sha alone.

### Round 5 Findings → Fixed in v6

- **`git rebase --abort` exit 128 must be explicitly tolerated** (Medium, Codex): Both Phase 1 step 1b and reconciliation Case B call `git rebase --abort` conditionally (only when sentinel directories exist), but the spec must explicitly state exit 128 / "no rebase in progress" is not a fatal error. Added tolerance note to both locations so implementors do not treat non-zero as fatal. (Opus Probe 1 confirmed the conditional check is architecturally correct; Codex correctly identified the spec was under-specified.)
- **`push_failed` re-entry step 3 exact equality creates livelock** (Medium, Opus): If our base-branch push succeeded but crash prevented recording it, and another runner pushed on top, `remoteHead != rebased_sha` even though we're already merged. Exact equality re-enters push logic, fails with non-fast-forward, and loops forever. Fixed: changed to `git merge-base --is-ancestor` (same class of fix as Phase 5 step 11 in Round 3).

### Round 6 Findings → Fixed in v7

- **`push_failed` step 4b `localAhead NON-EMPTY` non-fast-forward failure** (High, Opus; Medium, Codex): When our base-branch push failed and another runner pushed between our failure and re-entry, the blunt re-push fails with non-fast-forward and has no recovery path — deterministic livelock under any concurrent load. Fixed: restructured step 4b around a shared re-merge path (shared between non-empty-push-fail and empty-localAhead). When non-empty push fails with non-fast-forward, discard stale local merge via `git checkout <baseBranch> && git reset --hard origin/<baseBranch>`, re-checkout task branch, and re-merge — identical to the empty-localAhead recovery.
- **`rebased_sha` NULL guard missing in push_failed re-entry step 3** (High, Opus): No guard for `rebased_sha IS NULL` before the `git merge-base --is-ancestor` call. NULL SHA causes undefined git behavior (error exit, not "not ancestor"). Fixed: explicit NULL check at start of step 3 — skip to step 4 if NULL.
- **`rebased_sha` not in local object store after workspace re-clone** (Medium, Opus): `rebased_sha` is a locally rebased commit, never pushed. If the workspace was re-cloned since the crash (Phase 1 step 5 re-clone path), `git merge-base --is-ancestor` exits with "not a valid object name" rather than cleanly returning false. Fixed: explicit error handling — treat "not a valid object name" as "not yet merged", proceed to push_failed re-entry. Applied to both reconciliation Case A and push_failed re-entry step 3.
- **Missing `.git/REBASE_HEAD` sentinel** (Medium, Opus): Interactive rebases stopped mid-conflict write `.git/REBASE_HEAD`. In partial-cleanup edge cases, this file can exist without `.git/rebase-merge/`. Without this check, `git checkout <baseBranch>` fails with "You are in the middle of a rebase." Fixed: added `|| .git/REBASE_HEAD exists` to all sentinel checks (Phase 1 step 1b and reconciliation Case B).
- **`conflict_attempts` not incremented on no-commit path** (Medium, Opus): Section 3.9 step 4d said "counts as another attempt" but did NOT explicitly increment `conflict_attempts`. A coder that never commits in conflict resolution would loop indefinitely — step 1's `>= 2` check never triggers. Fixed: explicit `conflict_attempts++` + DB update added to step 4d.
- **Auth error not classified in re-entry push operations** (Medium, Codex): Re-entry step 4a and 4b pushes had no auth vs. transient distinction. Auth errors would cycle through push_failed indefinitely. Fixed: auth error handling (→ `auth_failed`) added to all push operations in the re-entry protocol.
- **`--force-with-lease` needs explicit expected SHA** (Medium, Opus): Step 4a `--force-with-lease` without explicit SHA relies on the local tracking ref. After a crash, the tracking ref may be stale or absent — stale tracking ref causes lease violation even when remote matches `rebased_sha`. Fixed: changed to `git push origin HEAD:steroids/task-<taskId> --force-with-lease=steroids/task-<taskId>:<rebased_sha>`.
- **exit 128 defense-in-depth made explicit** (Medium, Codex/Opus): Added documentation that if `git rebase --abort` exits 128 despite sentinel files being present (filesystem/git state inconsistency), Phase 1 step 5 clean-state check will detect remaining dirty state and trigger workspace re-clone. The defense-in-depth already existed; now documented.

### Round 7 Findings → Fixed in v8

- **Shared re-merge path defined before decision logic** (High, Opus): Steps i–iv of the shared re-merge path were presented inline BEFORE the `localAhead` check that governs whether to use them. Sequential reading produces an implementation where `localAhead` is checked after baseBranch is already reset (always empty), losing the optimistic re-push path. Fixed: restructured step 4b to run the `localAhead` check first, then the re-merge path (now labelled B.i–B.v) is invoked by both sub-cases.
- **Phase 5 steps 7 and 9 set `push_failed` for auth errors** (High, Codex): Auth errors on task-branch and base-branch pushes both set `slot.status = 'push_failed'`, causing reconciliation to auto-retry indefinitely instead of surfacing for human intervention. Fixed: both steps now set `slot.status = 'auth_failed'` for auth errors.
- **`git checkout <task_branch>` in step B.ii has no guard for missing branch** (Medium, both): If the local task branch was deleted (e.g., by the coder, or after workspace re-clone), the checkout fails with no defined recovery. Fixed: added B.i verification (`git rev-parse --verify`) before checkout; if not found → step 4c (reset to idle, task to pending).
- **NULL `rebased_sha` in step 4a `--force-with-lease` produces malformed command** (Medium, Opus): If `push_failed` is reached with `rebased_sha = NULL` (inconsistent DB state), step 4a would execute `--force-with-lease=ref:` with an empty SHA, causing unpredictable git behavior. Fixed: explicit NULL guard in step 4a — if NULL, skip to step 4c.
- **`conflict_attempts` semantics misaligned with "2 attempts" language** (Medium, Codex): Section 3.6 said "up to 2 attempts" which implies 2 coder invocations, but with `conflict_attempts++` on the no-commit path, the first conflict + no-commit = 2 events = blocked (only 1 coder invocation). Fixed: clarified Section 3.6 to define "attempt" as a "conflict event" (rebase conflict OR no-commit invocation), not a coder invocation count. The `>= 2` threshold is intentional and consistent with this definition.
- **`merge_pending` has no documented TTL bound** (Medium, Opus): Spec didn't explain why merge_pending can't wait forever. Fixed: added documentation that the 3-minute merge lock TTL provides the implicit bound — a live holder must release within bounded retries, and a crashed holder loses the lock in ≤3min.

### Deferred (Low risk, implementation phase)

- `git add -A` may commit unexpected files — existing behavior, follow-up improvement
- `git clean -e` symlink behavior — mitigated by existing `.git/info/exclude`
- Phase 5 step 8 re-rebase needs explicit `git checkout <task_branch>` before re-rebase — implementation detail
- Heartbeat timer must be stopped before lock release — implementation detail
- `auth_failed` dashboard surfacing — implementation detail
- `merge_pending` workspace state verification before Phase 5 re-entry — defense-in-depth; if workspace is missing, push_failed re-entry step 4c handles it (unexpected state → reset to idle, task to pending)
- Local orphan task branches in pool workspaces (after Case B resets) accumulate without cleanup — cosmetic, `steroids workspaces clean` follow-up
- push_failed re-entry protocol should explicitly reference cross-DB ordering contract on lock acquisition — editorial, same contract applies
