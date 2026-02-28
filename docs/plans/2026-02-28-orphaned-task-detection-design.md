# Orphaned Task Detection & Reset Design

**Date:** 2026-02-28
**Status:** Revised after cross-provider review

## Problem Statement

When a runner crashes or is stopped while a task is `in_progress`, the task becomes orphaned — stuck with no runner to advance it. This state is currently invisible in the project issues section and the reset button does not handle it, leaving users with no in-UI recovery path.

## Current Behavior

- `project.runner` is `null` when no standalone runner is active for a project
- `project.stats.in_progress` counts tasks currently in progress
- The issues section surfaces `failed_retries` and `stale` — but not orphaned tasks
- `canResetProject` only enables the reset button for `isBlocked || failed > 0 || disputed > 0 || skipped > 0`
- `POST /api/projects/reset` calls `tasks reset --all` which flips failed/disputed → pending but does not touch `in_progress` tasks

## Desired Behavior

- Orphaned tasks (in_progress, no active runner) appear as a named issue in the project issues section
- The reset button is enabled when orphaned tasks exist
- Clicking reset flips orphaned tasks to `pending` and triggers a wakeup so a runner picks them up immediately

## Design (Revised)

### Detection (Server-side — single source of truth)

Orphaned detection MUST be server-side. `project.runner` only reflects standalone runners; parallel/pool runners are tracked through `parallel_sessions` under workspace clone paths — not visible via simple `project_path` equality. The existing helpers in `src/runners/wakeup-checks.ts` (`hasActiveRunnerForProject` + `hasActiveParallelSessionForProject`) are the canonical active-runner check and must be reused.

The API project response (`GET /api/projects` and `GET /api/projects/status`) gains a new field:

```ts
orphaned_in_progress: number  // count of in_progress tasks when no active runner/session exists
```

Computed per-project as:
- If `hasActiveRunnerForProject(path) || hasActiveParallelSessionForProject(path)` → `orphaned_in_progress = 0`
- Otherwise → `orphaned_in_progress = stats.in_progress`

The UI reads `project.orphaned_in_progress` directly — no client-side derivation.

### UI: Issues Section

Add a new issue row in `ProjectDetailPage.tsx` alongside existing `failed_retries` and `stale` rows:

- Icon: `fa-circle-pause`
- Label: "Orphaned tasks"
- Badge: `project.orphaned_in_progress`
- Click: navigates to task list filtered to `status=in_progress` for this project

### UI: canResetProject

```ts
const canResetProject = Boolean(
  project?.isBlocked ||
  (project?.stats?.failed ?? 0) > 0 ||
  (project?.stats?.disputed ?? 0) > 0 ||
  (project?.stats?.skipped ?? 0) > 0 ||
  (project?.orphaned_in_progress ?? 0) > 0   // new
);
```

### Detection computation (server-side, read-only)

`orphaned_in_progress` is computed in `GET /api/projects` using the already-open global DB — no extra connections, no write side effects:

```ts
// Using the already-open globalDb from the route's outer scope:
const hasStandaloneRunner = globalDb.prepare(
  `SELECT 1 FROM runners WHERE project_path = ? AND status != 'stopped'
   AND heartbeat_at > datetime('now', '-5 minutes') AND parallel_session_id IS NULL`
).get(project.path) !== undefined;

const hasParallelSession = hasActiveParallelSessionForProjectDb(globalDb, project.path);
// ^^ read-only variant — does NOT call closeStaleParallelSessions

const orphanedInProgress = (hasStandaloneRunner || hasParallelSession)
  ? 0
  : (projectStats.stats.in_progress ?? 0);
```

`hasActiveParallelSessionForProjectDb` (from `src/runners/parallel-session-state.ts`) is used directly — not `hasActiveParallelSessionForProject` — because the latter calls `closeStaleParallelSessions()` which performs writes, making it unsafe for read endpoints that run on every poll cycle.

### API: Reset Endpoint

`POST /api/projects/reset` gains two additions after the existing CLI call:

1. **Guard + reset orphaned tasks + clear locks** — uses the same read-only inline queries as detection:
   ```ts
   const hasActiveRunner = globalDb.prepare(
     `SELECT 1 FROM runners WHERE project_path = ? AND status != 'stopped'
      AND heartbeat_at > datetime('now', '-5 minutes') AND parallel_session_id IS NULL`
   ).get(projectPath) !== undefined;
   const hasParallelSession = hasActiveParallelSessionForProjectDb(globalDb, projectPath);

   if (!hasActiveRunner && !hasParallelSession) {
     // open project DB writable, in one transaction:
     // DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')
     // UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'
   }
   ```
   Lock cleanup is required — 60-min TTL would block new runner pickup otherwise.

2. **No wakeup call.** Reset's job is to reset tasks. Runner pickup is the daemon/cron's job. The cron picks up newly-pending tasks on the next cycle. Calling `wakeup()` from a per-project reset would run the full sweep across all registered projects (cleanup, recovery, reconciliation, runner spawns) — unacceptable blast radius for a scoped user action.

## Files Changed

| File | Change |
|------|--------|
| `API/src/routes/projects.ts` | Add `orphaned_in_progress` to project list + status responses; add lock+task reset in reset endpoint; add `orphaned_in_progress: 0` to register response |
| `WebUI/src/types/index.ts` | Add `orphaned_in_progress?: number` to `Project` type |
| `WebUI/src/pages/ProjectDetailPage.tsx` | Read `project.orphaned_in_progress`, new issue row, update `canResetProject` |

## Non-Goals

- No changes to orchestrator, loop, or runner pickup logic
- No changes to `src/runners/wakeup.ts` or `src/runners/wakeup-checks.ts`
- No changes to the `tasks reset` CLI command
- No wakeup call from the reset endpoint

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Runner starts between UI load and reset button click | Guard re-checks at reset time; skips if now active |
| Pool/parallel mode | `hasActiveParallelSessionForProjectDb` (read-only) catches active sessions |
| Project has both orphaned and failed tasks | Both contribute to `canResetProject`; reset handles all in one click |
| No in_progress tasks | `orphaned_in_progress = 0`, issue row hidden |
| Task has active lock from dead runner | Lock cleared in transaction before status flip |
| Tasks not picked up immediately after reset | Cron picks them up on next cycle; user can also hit "Start Daemon" for immediate wakeup |

---

## Cross-Provider Review (Codex adversarial pass)

Reviewed by: Codex (gpt-5.3-codex), 2026-02-28

### Finding 1 — CRITICAL: Parallel mode misclassification
**Codex:** `project.runner === null` (frontend heuristic) uses `SELECT ... FROM runners WHERE project_path = ?`, which only matches standalone runners. Parallel runners are tracked via `parallel_sessions` joined on workspace clone paths. A pool-mode project with active parallel sessions would falsely appear orphaned.

**Assessment:** Valid. Confirmed in `wakeup-checks.ts` — `hasActiveRunnerForProject` explicitly filters `parallel_session_id IS NULL` and `hasActiveParallelSessionForProject` handles the parallel case separately.

**Decision: Adopt.** Moved detection to server-side. API response gains `orphaned_in_progress` field computed using both helpers. UI reads this field directly.

---

### Finding 2 — CRITICAL: API guard weaker than existing active-runner logic
**Codex:** Planned guard (`SELECT ... WHERE status = 'running'`) missed heartbeat freshness (5-min window) and parallel sessions — inconsistent with wakeup's own checks.

**Assessment:** Valid. Reusing `hasActiveRunnerForProject() || hasActiveParallelSessionForProject()` from `wakeup-checks.ts` is the correct single source of truth.

**Decision: Adopt.** Reset endpoint now uses these helpers directly.

---

### Finding 3 — HIGH: Lock cleanup missing from reset SQL
**Codex:** The bare `UPDATE tasks SET status='pending'` doesn't clear `task_locks`. Dead-runner locks have a 60-min TTL; new runners can't acquire a lock on a task that still has one. `tasks-reset.ts:150` always deletes locks for each reset task.

**Assessment:** Valid. Without lock cleanup, the reset would appear to work (task goes to `pending`) but the next runner would skip the task for up to 60 minutes.

**Decision: Adopt.** Added `DELETE FROM task_locks WHERE task_id IN (...)` in same DB transaction before the status UPDATE.

---

### Finding 4 — HIGH: Three divergent orphan definitions
**Codex:** UI heuristic, API guard, and `stuck-task-detector.ts` all defined "orphaned" differently and could disagree.

**Assessment:** Valid — root cause of #1 and #2. Resolved by the server-side single-source fix.

**Decision: Adopt (resolved by #1 and #2).**

---

### Finding 5 — MEDIUM: Design overstated what `tasks reset --all` does
**Codex:** Design said CLI resets "failed/disputed/stale" but `tasks-reset.ts` only handles failed/disputed. "Stale" is incident-based.

**Assessment:** Valid — documentation error.

**Decision: Adopt.** Updated Current Behavior section to say "failed/disputed → pending".

---

### Finding 6 — MEDIUM: Wakeup may be a no-op if daemon is paused
**Codex:** `wakeup()` exits early when daemon is paused. Design promised "immediate pickup."

**Assessment:** Valid but acceptable. We can't force daemon unpause from the reset path (and shouldn't try).

**Decision: Adopt as wording fix.** Response and edge cases now say "wakeup attempted" not "immediate pickup."

---

### Finding 7 — MEDIUM: Insufficient test coverage for recovery path
**Codex:** No automated tests for parallel-session false positives, lock cleanup, or guard correctness.

**Assessment:** Partially valid. Given the two critical bugs found, the lock cleanup path and active-runner guard warrant at least one unit test each.

**Decision: Partially adopt.** Implementation plan updated to include a test for lock cleanup behavior.

---

### Finding 8 — LOW: Type safety — non-null assertions and raw casts
**Codex:** `validation.path!` and `as { id: string } | undefined` bypass type safety.

**Assessment:** Valid but minor. The validated path can be extracted once to avoid repeated `!` assertions.

**Decision: Adopt.** Implementation plan updated accordingly.

---

## Cross-Provider Review (Claude + Codex parallel adversarial pass)

Reviewed by: Claude (claude-sonnet-4-6) and Codex (gpt-5.3-codex) simultaneously, 2026-02-28

Both reviewers worked from the same design (revised after Round 1).

### Finding R2-1 — CRITICAL: `wakeup()` has global blast radius
**Both reviewers:** `wakeup()` iterates ALL registered projects (cleanup, recovery, reconciliation, runner spawns). Calling it from a per-project reset is an unacceptable global side effect for a scoped user action.

**Assessment:** Valid. `wakeup()` is designed as a system-wide sweep, not a per-project trigger.

**Decision: Adopt.** Removed `wakeup()` entirely from the reset endpoint. Runner pickup relies on the cron's next cycle. Users who want immediate pickup can use "Start Daemon." Non-goals section updated.

---

### Finding R2-2 — HIGH: `hasActiveParallelSessionForProject()` has write side effects
**Both reviewers:** `hasActiveParallelSessionForProject()` (from `wakeup-checks.ts`) internally calls `closeStaleParallelSessions()`, which writes to `parallel_sessions` and `workstreams`. Calling this from GET endpoints that run on every poll cycle introduces write side effects in read paths.

**Assessment:** Valid. `src/runners/parallel-session-state.ts` exports `hasActiveParallelSessionForProjectDb(db, path)` — a read-only variant that takes an existing DB connection without calling `closeStaleParallelSessions`.

**Decision: Adopt.** Detection computation now uses `hasActiveParallelSessionForProjectDb(globalDb, path)` directly. The reset guard uses the same.

---

### Finding R2-3 — HIGH: N×extra DB connections from helper imports
**Both reviewers:** `hasActiveRunnerForProject()` opens its own global DB connection. Called per-project in a loop on every poll cycle, this creates N extra DB connections.

**Assessment:** Valid. The global DB is already open in the route's outer scope.

**Decision: Adopt.** Standalone runner detection is now an inline SQL query against the already-open `globalDb`. Only `hasActiveParallelSessionForProjectDb(globalDb, path)` is called — it takes the existing connection, so no extra DB opens.

---

### Finding R2-4 — MEDIUM: Missing `POST /api/projects` (register) coverage
**Codex:** The register endpoint returns a project object without `orphaned_in_progress`, causing a type mismatch.

**Assessment:** Valid. Register returns a project object and should include the field.

**Decision: Adopt.** Register endpoint includes `orphaned_in_progress: 0` (a newly registered project has no tasks).

---

### Finding R2-5 — MEDIUM: TOCTOU between CLI call and orphaned guard
**Claude:** Between the CLI `tasks reset --all` call and the orphaned guard check, a runner could start and pick up tasks, causing a double-reset.

**Assessment:** Low-risk in practice. The window is milliseconds. Resetting already-pending tasks is idempotent. Fixing this requires locking that exceeds scope.

**Decision: Defer.** Acceptable risk. Idempotent operations mean the worst case is a no-op double reset.

---

### Finding R2-6 — LOW: Raw `new Database()` without WAL pragma
**Codex:** Opening the project DB with bare `new Database(dbPath)` defaults to DELETE journal mode while other readers use WAL.

**Assessment:** Not a real risk. WAL mode is a property of the DB file, set by its first opener (runner/CLI). A subsequent opener inherits it. The brief write-only connection in reset is safe.

**Decision: Reject.** No change needed.
