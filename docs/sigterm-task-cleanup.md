# Design: Fix Orphaned Task State After Sibling Runner SIGTERM

## Problem Statement

When a parallel session fails (e.g. merge failure), `updateParallelSessionStatus('failed')` in
`global-db-sessions.ts` sends SIGTERM to all sibling runners. The SIGTERM handler in `daemon.ts`
calls `shutdown()` which closes the DB and exits — but does NOT clean up:

- `task_invocations` row stays `status='running'`
- `tasks` row stays `status='in_progress'`
- `task_locks` row stays (until expiry ~1hr later)

**Compound effect:** `task-selector.ts` skips sections where `active_count > 0` (counts
`in_progress` and `review` tasks). A stuck `in_progress` task blocks ALL other pending tasks
in the same section, not just itself.

Recovery only happens when `wakeup-sanitise.ts` detects a stale invocation (~30 min gap). Even
then, sanitise closes the invocation but does NOT reset `tasks.status` to `pending`, so the task
stays `in_progress` until a runner happens to pick it up via `task-selector` (which accepts
`in_progress` tasks), which may never happen cleanly.

## Current Behavior (file references)

- Kill sender: `src/runners/global-db-sessions.ts` lines 46–62 — queries runners by session,
  sends `SIGTERM`, deletes runner rows
- Shutdown handler: `src/runners/daemon.ts` `shutdown()` lines 211–234 — calls
  `unregisterRunner()` + exits, no task cleanup
- Sanitise gap: `src/runners/wakeup-sanitise.ts` lines 260–274 — marks invocation `failed`,
  but does NOT reset `tasks.status`
- Section blocker: `src/orchestrator/task-selector.ts` line 177 — skips sections with
  `active_count > 0`

## Why daemon.ts Is the Wrong Fix Location

`daemon.ts` `shutdown()` has `effectiveProjectPath` in scope but NOT `currentTaskId`. The runner
only tracks `currentTaskId` in the global DB via `updateRunnerCurrentTask()`. By the time
`shutdown()` runs, the global DB runner row is already deleted by the session terminator.
Fixing in `daemon.ts` would require adding a new in-memory variable to the closure, and still
relies on the dying process being cooperative — SIGKILL or crash bypass it entirely.

## Fix — Two Parts

### Part 1: Fix `global-db-sessions.ts` (primary — cleanup BEFORE SIGTERM)

The session terminator already has full context: it queries runner rows which contain `id`, `pid`,
`current_task_id`, and `project_path` (the clone workspace where the project DB lives). Extending
the SELECT and doing project DB cleanup synchronously before SIGTERM is the minimal, reliable fix.

**What to do for each runner with a `current_task_id`:**
1. Open the project DB (at `runner.project_path`)
2. Mark the running `task_invocations` row as `failed` (closes the invocation)
3. Reset `tasks.status` to `'pending'` for that task (removes section blocker)
4. Do NOT delete `task_locks` — leave the lock to expire naturally

**Why not delete the lock?** Deleting the lock before SIGTERM creates a double-execution window:
the dying runner could still write task state (LLM response arriving between SIGTERM and
`process.exit`), while a new runner acquires the lock and starts the same task. By keeping the
lock, new runners cannot re-acquire it until it expires (60 min max) or sanitise cleans it.
The task shows as `pending` (unblocking the section) while the lock silently guards against
double pickup.

### Part 2: Fix `wakeup-sanitise.ts` (defense-in-depth — covers SIGKILL and crashes)

In the `else` branch (lines 260–274) that closes stale `running` invocations, also reset
`tasks.status` to `'pending'`. This costs 2 lines and covers:

- SIGKILL (Part 1 doesn't fire)
- Process crashes / OOM kills (Part 1 doesn't fire)
- Any case where Part 1 runs but the task status write races with the dying runner

The stale invocation timeout is 1800 seconds (30 min), so this is the last-resort fallback, not
the primary path. Sanitise already deletes expired locks (`DELETE FROM task_locks WHERE
expires_at <= datetime('now')`), so no extra lock cleanup needed here.

## Double-Execution Analysis

With Part 1 cleaning up BEFORE SIGTERM:

1. Task set to `pending`, invocation set to `failed` — lock left in place
2. SIGTERM sent to runner
3. A new runner sees task as `pending` but cannot acquire the lock (not expired) → skips it
4. Dying runner receives SIGTERM → `process.exit(0)` → all async I/O abandoned
5. Lock expires (60 min) or sanitise removes it (next 5-min interval after 30-min detection)
6. New runner acquires lock and processes task normally

If the dying runner's LLM response arrives in the narrow SIGTERM→exit window and writes back
`in_progress`, Part 2 (sanitise) will reset it again at the 30-min sanitise detection point.
This race is vanishingly small and Part 2 covers it.

## Files Changed

1. `src/runners/global-db-sessions.ts` — extend SELECT + add project DB cleanup before SIGTERM
2. `src/runners/wakeup-sanitise.ts` — add task reset in the stale invocation else branch

## Non-Goals

- Does not change when or why SIGTERM is sent
- Does not add retry logic or fallback layers
- Does not change task selection logic
- Does not add new tables, columns, config, or env vars
- Does not modify daemon.ts

## Cross-Provider Review Summary

**Claude (from source reading):** Option B (global-db-sessions.ts) is the right fix location.
`daemon.ts` lacks `currentTaskId` in closure. NOT deleting the lock prevents double-execution.
Part 2 is justified as defense-in-depth.

**Codex (round 3, verified source):** "Option A = INVALID as primary fix... Option B fixes at
the kill authority where pid, project_path, and current_task_id are already available." Confirmed
double-execution risk is real; confirmed Part 2 is valid; confirmed the section blocker is the
same fix as the task reset.

**Decision:** Both agree. Implement as described above.
