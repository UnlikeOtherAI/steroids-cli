# Stale Task Lock Recovery via PID Liveness

**Date:** 2026-02-27
**Status:** Reviewed (Round 2 complete) — Ready for implementation

## Problem Statement

When a runner process dies (SIGTERM, SIGKILL, crash, OOM), it can leave behind:
1. A `task_locks` row with a 1-hour TTL
2. A `task_invocations` row with `status='running'`
3. A `tasks` row stuck as `status='in_progress'`

This blocks the entire project because section dependencies prevent other phases from proceeding while Phase N has an `in_progress` task.

**Recovery currently takes 30-60 minutes (or hangs indefinitely).**

### Observed Failure (docgen project, 2026-02-27)

1. Runner `b69c531c` died while working on task `db888493` in Phase 1
2. The runner's row was removed from the global `runners` table (parallel session completed)
3. The task remained `in_progress` with a `running` invocation and an unexpired `task_lock`
4. Phases 2-7 all depend on Phase 1 completing
5. Every new wakeup cycle started a new session, saw "ALL TASKS COMPLETE" (only the 4 completed tasks were selectable), and exited
6. The system spun indefinitely until manually repaired

## Current Behavior — Two Overlapping Cleanup Paths

### Path 1: `wakeup-sanitise.ts` (periodic, time-based)

- Finds `task_invocations` with `status='running'` older than 30 minutes
- **Guard bug:** Skips cleanup if `hasActiveParallelContext` is true (any active parallel runner OR merge lock exists for the project). A new session being started counts as "active parallel context", so the guard is always true during the spin cycle.
- Lock cleanup is separate: `DELETE FROM task_locks WHERE expires_at <= datetime('now')` — only fires after the full 1-hour TTL
- **Gap:** Even if the stale invocation is cleaned and task reset to `pending`, the lock is NOT deleted (1hr TTL hasn't expired), so the task-selector skips it

### Path 2: `stuck-task-recovery.ts` (PID-based)

Uses `process.kill(pid, 0)` for liveness — the right signal. But has a detection gap:

- **Orphaned task detector:** Skips tasks that have `running_invocation_count > 0` (assumes someone is working on it)
- **Hanging invocation detector:** Skips tasks where `getActiveRunnerForTask()` returns null (no runner row in global DB)
- **Dead runner detector:** Only finds runners still IN the `runners` table whose PID is dead

**The gap:** A task with a `running` invocation whose runner has been unregistered (row deleted from `runners` table) falls through ALL three detectors:
- Not "orphaned" because it has a running invocation
- Not "hanging" because there's no active runner to detect
- Not a "dead runner" because the runner row is already gone

## Desired Behavior

**Recovery within one wakeup cycle (~60 seconds) after a runner dies, regardless of death cause.**

The system should detect and recover tasks whose `running` invocations belong to dead processes or deleted runners, without relying on time-based TTLs.

## Design — Single Source of Truth: PID/Runner Liveness

### Principle

Per AGENTS.md Simplification First: "If two code paths answer the same invariant question, they must use one shared source of truth."

The invariant question is: **"Is this invocation still being actively worked on?"**

The single source of truth: **Is the runner process alive?** — checked via PID liveness (`process.kill(pid, 0)`) or runner-row existence in the global DB.

### Changes

#### Change 0: Fix datetime format mismatch + filter expired locks (pre-existing bugs)

**File:** `src/locking/queries.ts`

**Bug 0a — datetime format mismatch (Round 2 Codex BLOCKER):** All lock expiry SQL comparisons use `datetime('now')` which produces `2026-02-27 19:22:15` (space separator), but `expires_at` is stored via `toISOString()` which produces `2026-02-27T19:22:15.000Z` (ISO format with `T`). Since `'T' > ' '` in ASCII, the ISO timestamp is always lexicographically "greater" than the `datetime()` output for the same instant. This means `expires_at < datetime('now')` **never returns true** for locks that expired on the same day.

Verified with SQLite:
```sql
SELECT '2026-02-27T18:00:00.000Z' < datetime('now') → 0 (WRONG)
SELECT '2026-02-27T18:00:00.000Z' < strftime('%Y-%m-%dT%H:%M:%fZ', 'now') → 1 (CORRECT)
```

**Fix:** Replace ALL `datetime('now')` comparisons against ISO-format `expires_at` with `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`. Affected locations:

In `src/locking/queries.ts`:
- `claimExpiredTaskLock()` (line 134) — `WHERE expires_at < datetime('now')`
- `findExpiredTaskLocks()` (line 233) — `WHERE expires_at < datetime('now')`
- `cleanupExpiredTaskLocks()` (line 245) — `WHERE expires_at < datetime('now')`
- `claimExpiredSectionLock()` (line 319) — `WHERE expires_at < datetime('now')`
- `findExpiredSectionLocks()` (line 370) — `WHERE expires_at < datetime('now')`
- `cleanupExpiredSectionLocks()` (line 383) — `WHERE expires_at < datetime('now')`

In `src/runners/wakeup-sanitise.ts` (inline SQL, not calling queries.ts functions):
- Line 297 — `DELETE FROM task_locks WHERE expires_at <= datetime('now')`
- Line 302 — `DELETE FROM section_locks WHERE expires_at <= datetime('now')`

Also fix `acquired_at = datetime('now')` and `heartbeat_at = datetime('now')` in INSERT/UPDATE statements to use `strftime` for consistency (these produce `acquired_at` and `heartbeat_at` values in a different format than `expires_at`, which is confusing but not a bug since they're not compared cross-format).

**Not affected** (format is consistent, no fix needed):
- `lease_expires_at` comparisons in `wakeup.ts`, `wakeup-reconcile.ts`, `runners-parallel.ts` — stored AND compared with `datetime('now')` format, so consistent
- `merge_locks.expires_at` — compared in JavaScript via `Date.parse()` / `new Date().getTime()`, which handles ISO format correctly

**Bug 0b — listTaskLocks returns expired locks (Round 1 Claude BLOCKER):** `listTaskLocks()` at line 220 returns ALL lock rows including expired ones:
```typescript
// Before:
.prepare('SELECT * FROM task_locks ORDER BY acquired_at DESC')

// After (using correct ISO format):
.prepare("SELECT * FROM task_locks WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY acquired_at DESC")
```

This is a pre-existing bug found during review. `selectNextTaskWithLock()` in `task-selector.ts` (line 308) calls `listTaskLocks()` to build a `lockedTaskIds` set, then filters tasks against it. Expired locks currently block task selection even though `acquireTaskLock()` can claim them — the task is filtered out before the acquisition code runs.

Without this fix, the "TTL as safety net" architecture doesn't work: even after a lock expires, tasks remain blocked until the sanitiser's `DELETE FROM task_locks WHERE expires_at <= datetime('now')` runs AND a new wakeup cycle starts. And with the datetime format bug, that DELETE also never fires on the same day.

#### Change 1: Close the stuck-task-detector gap

**File:** `src/health/stuck-task-detector.ts`

Add a new detection category — or extend orphaned task detection — for invocations whose runner is provably dead:

In `detectTaskSignalsInternal()`, after the existing hanging-invocations block (after line 462), add a new block for **"dead-owner invocations"**:

```sql
SELECT i.id, i.task_id, i.runner_id, t.title, t.status, t.updated_at
FROM task_invocations i
JOIN tasks t ON t.id = i.task_id
WHERE i.status = 'running'
  AND i.runner_id IS NOT NULL
  AND t.status IN ('in_progress', 'review')
```

Then for each result, deduplicated by `task_id` (skip if already emitted as orphaned or hanging):
1. Look up `runner_id` in the global `runners` table
2. If runner row exists → check PID liveness via `isPidAlive(pid)`
3. If runner row does NOT exist → runner is dead (already unregistered)
4. If PID is dead OR runner row is missing → emit `OrphanedTaskSignal`

**Deduplication:** Track emitted task IDs across all detection blocks. If a task was already emitted by the orphaned or hanging detector, skip it here. This prevents double-emission and avoids premature `failure_count` escalation in recovery.

This closes the detection gap. The existing `recoverOrphanedTask()` in `stuck-task-recovery.ts` already calls `forceReleaseTaskLock()` + resets task to `pending` — no recovery changes needed.

**Race safety note:** Session teardown (`global-db-sessions.ts`) marks invocations as `failed` BEFORE deleting the runner row. So the `WHERE i.status = 'running'` filter naturally excludes tasks that are in the middle of graceful session cleanup — preventing false positives from the "runner row missing = dead" heuristic.

#### Change 2: Delete task lock atomically in sanitiser

**File:** `src/runners/wakeup-sanitise.ts`

In the `else` branch (lines 260-282) where the sanitiser marks a stale invocation as `failed` and resets the task to `pending`, also delete the associated task lock:

```typescript
// After: UPDATE tasks SET status = 'pending' ...
projectDb.prepare('DELETE FROM task_locks WHERE task_id = ?').run(row.task_id);
```

Also apply the same lock cleanup in the reviewer-reject recovery branch (lines 226-259), where a task transitions from `review` → `in_progress`.

This ensures that if the sanitiser path fires, the lock is cleaned up atomically with the task reset, rather than waiting for the separate lock-expiry sweep.

**Implementation note:** The stale invocations query (line 162) must be updated to also select `i.runner_id` for Change 3 to work. Add `i.runner_id` to the SELECT and to the TypeScript row type.

#### Change 3: Narrow the hasActiveParallelContext guard

**File:** `src/runners/wakeup-sanitise.ts`

The current guard at line 181 skips ALL stale invocations if any parallel context is active. Change this to a per-invocation check:

```typescript
// Before (line 181):
if (activeTaskIds.has(row.task_id) || hasActiveParallelContext) {
  continue;
}

// After:
if (activeTaskIds.has(row.task_id)) {
  continue;
}
// Merge locks are a hard skip — don't touch tasks during merge operations.
// The workspace reconciliation in wakeup Step 1b handles stale merge locks.
if (hasActiveMergeLock) {
  continue;
}
// If parallel runner is active, only skip if this invocation's runner is still alive
if (hasActiveParallelRunner && row.runner_id) {
  const runnerRow = globalDb.prepare(
    'SELECT pid FROM runners WHERE id = ?'
  ).get(row.runner_id) as { pid: number | null } | undefined;

  if (runnerRow) {
    // Runner row exists — check if process is alive
    if (runnerRow.pid !== null) {
      try {
        process.kill(runnerRow.pid, 0);
        continue; // Process alive, skip this invocation
      } catch {
        // Process dead, fall through to cleanup
      }
    } else {
      continue; // No PID to check, assume alive (defensive)
    }
  }
  // Runner row missing = runner is dead, proceed with cleanup
}
```

This preserves the safety of not cleaning up actively-running tasks, while allowing cleanup of tasks owned by dead runners even during an active parallel session.

### What Gets Removed/Simplified

1. **The 1-hour lock TTL becomes a safety net, not the recovery mechanism.** Recovery happens via PID check within one wakeup cycle. The TTL is defence-in-depth for edge cases (PID recycling, cross-machine scenarios if ever applicable).

2. **The `running_invocation_count = 0` filter in orphaned task detection becomes less critical.** The new dead-owner check handles the case it was missing.

3. **No new tables, no new config knobs, no new heartbeat mechanisms.** Just better use of what's already there.

## Implementation Order

1. **Change 0** (datetime format fix + listTaskLocks filter) — `src/locking/queries.ts` (~12 lines across 6 functions + listTaskLocks)
2. **Change 1** (detector gap) — `src/health/stuck-task-detector.ts` (~30 lines)
3. **Change 2** (atomic lock delete + query update) — `src/runners/wakeup-sanitise.ts` (~5 lines)
4. **Change 3** (narrow guard) — `src/runners/wakeup-sanitise.ts` (~20 lines, uses `hasActiveMergeLock` / `hasActiveParallelRunner` separately instead of combined `hasActiveParallelContext`)
5. **Tests** — update `tests/stuck-task-detector.test.ts` (add `runner_id` to schema, add dead-owner test, update test at line 110-131 that validates the old gap behavior), add `wakeup-sanitise` tests (none exist currently)

## Edge Cases

| Scenario | Handling |
|---|---|
| PID recycled (new process reuses dead runner's PID) | `kill -0` returns true → invocation is NOT cleaned up. The 1-hour lock TTL provides backup expiry (now functional with Change 0 fixing `listTaskLocks`). macOS PID space is 99999; recycling within 60s is unlikely but possible on busy machines. Compound risk (PID reuse + listTaskLocks bug) is eliminated by Change 0. |
| Runner dies during merge (merge lock held) | `hasActiveMergeLock` prevents sanitiser from touching tasks. Merge lock has its own TTL (5 min). Workspace reconciliation in Step 1b handles stale merge locks. |
| Multiple invocations for same task | The detector iterates all `running` invocations. Each is checked independently. Recovery is idempotent (force release is a DELETE, task reset uses WHERE status guard). |
| Runner alive but frozen (not crashing) | PID check says alive → no cleanup. Existing hanging-invocation detector (with activity heartbeat) handles this case after its timeout. |
| `runner_id` column is NULL in invocation | Change 1 skips it (no runner to verify). Change 3's PID check doesn't apply. The time-based sanitiser path cleans these up after the 30-minute threshold as before. |

## Non-Goals

- **Lock heartbeat renewal (Option 5 from analysis):** Over-engineered for this problem. PID detection is sufficient.
- **RAII on unregister (Option 3 from analysis):** Would require refactoring `unregisterRunner()` to be project-aware and wait for process death confirmation. Future improvement, not needed now.
- **Cross-DB JOIN in task-selector (Option 4 from analysis):** Architecturally messy. Fix the state, don't work around dirty state.
- **Reducing lock TTL below 60 minutes:** Not needed once PID-based recovery is the primary mechanism. The TTL is just backup.

## Cross-Provider Review

### Round 1 (2026-02-27)

Adversarial reviews by both Codex (gpt-5.3-codex) and Claude (claude-sonnet-4-6).

#### Codex Findings

| # | Class | Finding | Assessment |
|---|---|---|---|
| 1 | BLOCKER | Missing runner row is not a safe death signal — session teardown deletes runner row before process exits, risking double execution | **Non-issue.** Session teardown marks `task_invocations.status='failed'` BEFORE deleting the runner row. Change 1's query filters `WHERE i.status='running'`, which naturally excludes tasks mid-session-teardown. Added race-safety note to Change 1. |
| 2 | BLOCKER | `global-db-sessions.ts` cleanup leaves lock intentionally, Change 2 doesn't touch that path → task stays locked for 1hr even after reset to pending | **Valid.** Addressed by adding Change 0 (`listTaskLocks` filter). Once expired locks are transparent to task selection, the intentional lock preservation in session teardown becomes a short-lived safety guard that expires naturally. |
| 3 | BLOCKER | Multiple invocations per task bump `failure_count` → premature escalation to `skipped` | **Partly valid.** Recovery already deduplicates via `handledTaskIds` set. Added explicit deduplication requirement to Change 1 (track emitted task IDs across all detection blocks). |
| 4 | CONCERN | Sanitiser query doesn't select `runner_id` | **Valid.** Added implementation note to Change 2 to update the SELECT. |
| 5 | CONCERN | PID reuse handling too weak for stated SLA | **Acceptable.** PID reuse causes false negative (no cleanup), but Change 0 ensures the 1hr TTL backup works. Updated edge case table. |
| 6 | CONCERN | No existing wakeup-sanitise tests | **Valid.** Added to implementation order. |
| 7 | NIT | "Single source of truth" claim diluted — adds more PID checks instead of consolidating | **Fair.** Both detector and sanitiser use the same pattern (`process.kill(pid, 0)`). Could extract to shared helper in future, but not needed for this scope. |

#### Claude Findings

| # | Class | Finding | Assessment |
|---|---|---|---|
| 1 | BLOCKER | `listTaskLocks()` returns ALL locks including expired — task selection blocked even after TTL expires. The "safety net" doesn't work. | **Valid and critical.** Added Change 0 to fix `listTaskLocks`. This is a pre-existing bug that this design depends on being absent. |
| 2 | CONCERN | Change 3 code uses `row.runner_id` but the SQL query doesn't select it | **Valid.** Same as Codex #4. Addressed. |
| 3 | CONCERN | Change 1 underspecified — where does the new sweep go, how to avoid double-emission | **Valid.** Updated Change 1 with specific SQL query, placement (after line 462), and deduplication requirement. |
| 4 | CONCERN | PID recycling window is larger than acknowledged; compounds with BLOCKER | **Addressed.** Change 0 eliminates the compound risk. Updated edge case table. |
| 5 | CONCERN | Race between sanitiser and recovery is benign but undocumented | **Acknowledged.** Both run synchronously in same process with same SQLite connection. Benign. |
| 6 | CONCERN | `hasActiveMergeLock` vs `hasActiveParallelRunner` not distinguished in Change 3 | **Valid.** Updated Change 3 to separate merge-lock (hard skip) from parallel-runner (PID-checked). |
| 7 | NIT | Existing test at line 110-131 validates the gap behavior and must be updated | **Valid.** Added to test plan. |
| 8 | NIT | Test schema missing `runner_id` column | **Valid.** Added to test plan. |
| 9 | NIT | Design should mention both section-blocking mechanisms | **Noted.** `selectTaskBatch` line 177 (`active_count > 0`) and `hasDependenciesMet` both contribute. Recovery fixes both by resetting to `pending` + releasing lock. |

### Design Changes After Round 1

1. **Added Change 0:** Fix `listTaskLocks()` to filter expired locks — pre-existing bug critical for TTL safety net
2. **Updated Change 1:** Added specific SQL, placement, deduplication requirement, race-safety note
3. **Updated Change 2:** Added `runner_id` to SELECT, lock cleanup in reject-recovery branch
4. **Updated Change 3:** Split `hasActiveParallelContext` into `hasActiveMergeLock` (hard skip) and `hasActiveParallelRunner` (PID-checked)
5. **Updated edge cases:** PID recycling compound risk eliminated by Change 0
6. **Updated test plan:** Explicit about schema updates and test case changes

### Round 2 (2026-02-27)

Second round of adversarial reviews to verify Round 1 changes introduced no new issues.

#### Codex Findings (Round 2)

| # | Class | Finding | Assessment |
|---|---|---|---|
| 1 | BLOCKER | ISO/SQLite datetime format mismatch: `expires_at` stored via `toISOString()` as `2026-02-27T10:00:00.000Z` but compared against `datetime('now')` which produces `2026-02-27 10:00:00`. Since `'T' > ' '`, the comparison `expires_at < datetime('now')` **never returns true** for same-day locks. This breaks Change 0's filter AND all existing lock expiry operations. Verified with actual SQLite test. | **Valid and critical.** Expanded Change 0 to fix ALL `datetime('now')` comparisons across the file using `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` to match ISO format. This is a pre-existing bug affecting all lock operations, not just the new filter. |
| 2 | CONCERN | Other code paths that delete runner rows before process exit could create brief false-positive windows | **Non-issue.** Same mitigation as Round 1 Codex #1: the `WHERE i.status = 'running'` filter excludes tasks mid-teardown because invocations are marked `failed` before runner row deletion. |
| 3 | CONCERN | Recovery deduplication is brittle — `handledTaskIds` set could be missed if detection blocks are reordered | **Acceptable.** The deduplication is explicit in the design (Change 1 specifies "track emitted task IDs across all detection blocks"). Implementation will use the existing `handledTaskIds` pattern. Reordering detection blocks would be a code change that should update the dedup logic. |
| 4 | NIT | `locks list` CLI command (`src/commands/locks.ts`) will show fewer locks after Change 0 — behavior change not documented | **Valid.** Minor UX change. The CLI should show active locks only (expired locks are noise). No documentation update needed — it's a bug fix, not a feature change. |

#### Claude Findings (Round 2)

| # | Class | Finding | Assessment |
|---|---|---|---|
| 1 | — | No blockers found. Confirmed Change 1 is the PRIMARY fix (recovery within one wakeup cycle). Changes 0/2/3 are defence-in-depth. | **Agreed.** Change 1 (dead-owner detection) is the critical path. Changes 0/2/3 fix secondary issues and provide safety nets. |
| 2 | CONCERN | Edge case table says "Skip the invocation (no runner to verify)" for NULL `runner_id`, but Change 3 code skips only when `hasActiveParallelRunner && row.runner_id` — if `hasActiveParallelRunner` is false and `runner_id` is null, the invocation falls through to cleanup normally (which is correct, but inconsistent with the edge case table description) | **Valid.** Updated edge case table wording: NULL `runner_id` invocations are cleaned up normally by the time-based path when they exceed the 30-minute threshold, regardless of parallel runner state. The Change 3 PID check simply doesn't apply to them. |
| 3 | NIT | `locks list` CLI would benefit from an `--all` flag to show expired locks too | **Deferred.** Nice-to-have, not in scope. |
| 4 | NIT | PID check pattern (`process.kill(pid, 0)` + try/catch) used in both detector and sanitiser could be extracted to a shared utility | **Deferred.** Both uses are small (3-4 lines). Shared utility is warranted if a third use appears. |
| 5 | — | Provided end-to-end trace of the docgen failure scenario through all 4 changes, confirming recovery would complete in one wakeup cycle | **Validates the design.** |

### Design Changes After Round 2

1. **Expanded Change 0:** Added datetime format mismatch fix (`strftime` instead of `datetime`) — affects ALL lock expiry operations, not just `listTaskLocks`
2. **Updated edge case table:** Clarified NULL `runner_id` handling (time-based cleanup, not skipped)
3. **Confirmed priority:** Change 1 is PRIMARY, Changes 0/2/3 are defence-in-depth
