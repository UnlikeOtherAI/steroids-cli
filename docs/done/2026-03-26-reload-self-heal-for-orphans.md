# Reload Self-Heal For Orphaned Runners And Tasks

## Problem Statement

The system currently leaves obvious stale state visible in the dashboard:

- abandoned runner rows can remain in the global DB indefinitely
- orphaned tasks can remain until the next wakeup cycle, or longer if wakeup is not running

This breaks the operator contract. Reloading the dashboard should be enough to make the system seek and repair deterministic stale state, even when the scheduled wakeup loop is not active.

The defect is not just "cleanup did not happen once." Two separate invariants are broken:

1. **Visibility gap:** monitor scanning can miss abandoned global runner rows that do not resolve back to an enabled project.
2. **Trigger gap:** dashboard reload paths only read state; they do not schedule any deterministic self-heal pass.

As a result, orphaned runners and orphaned tasks can sit in the UI unchanged until a human manually forces wakeup or restarts a task. That is not acceptable.

## Current Behavior

### Recovery Logic Exists, But It Is Trapped Inside Wakeup

`wakeup()` in [src/runners/wakeup.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/runners/wakeup.ts) already runs:

- global cleanup via [src/runners/wakeup-global-cleanup.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/runners/wakeup-global-cleanup.ts)
- stuck-task recovery via [src/health/stuck-task-recovery.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/health/stuck-task-recovery.ts) through [src/runners/wakeup-project.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/runners/wakeup-project.ts)

That means the system already knows how to clean stale runners and recover orphaned tasks. The problem is that this logic is only reached from wakeup.

### Reload Paths Are Read-Only

The pages that surfaced the bug only hit read routes:

- [API/src/routes/runners.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/runners.ts)
- [API/src/routes/tasks.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/tasks.ts)

The Runners page in [WebUI/src/pages/RunnersPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/RunnersPage.tsx) polls `GET /api/runners` every 5 seconds. The task page in [WebUI/src/pages/TaskDetailPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/TaskDetailPage.tsx) reloads task details from `GET /api/tasks/:taskId`.

Those routes currently return data only. They do not schedule any deterministic repair pass. That means a browser reload can refresh stale state forever without nudging the system to repair it.

### Monitor Cannot See Every Abandoned Runner Row

The monitor scanner in [src/monitor/scanner.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/scanner.ts) iterates enabled projects and reuses `detectStuckTasks()` from [src/health/stuck-task-detector.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/health/stuck-task-detector.ts).

That works for runners and tasks that still map back to a project, but it misses global garbage rows such as:

- dead idle runner rows
- rows with a bogus `parallel_session_id`
- rows whose stored `project_path` is not a registered project

Those rows are still cleanable by wakeup, but they are not always detectable by monitor.

### Concrete Root Cause Seen In Production

The live system exposed two runner rows with:

- `status = idle`
- dead `pid`
- `heartbeat_at` older than one day
- `project_path = /tmp/parallel-project`
- `parallel_session_id = session-1` with no matching `parallel_sessions` row

At the same time:

- `GET /api/runners/cron` reported `installed = false`
- `last_wakeup_at` was stale from the previous day

So the failure was a combination of:

1. no scheduled wakeup cycle to run existing cleanup
2. no reload-triggered fallback
3. no monitor visibility for unresolved global runner rows

## Desired Behavior

The system should enforce these rules:

1. Reloading the dashboard or a task view must schedule a deterministic self-heal sweep in the background.
2. The self-heal sweep must reuse the existing wakeup recovery logic, not invent a second definition of "orphaned runner/task recovery."
3. The sweep must be safe for frequent reloads:
   - single-process deduped
   - non-blocking for API reads
   - bounded by a short cooldown
4. Monitor scanning must detect abandoned global runner rows even when they do not map to an enabled project.
5. Any stale runner row or orphaned task that the system knows how to recover must become both:
   - detectable
   - recoverable from the reload-triggered sweep

## Design

### 1. Extract A Shared Abandoned-Runner Primitive

Create a shared runner-health helper under `src/runners/abandoned-runners.ts`.

It will own one source of truth for:

- `findAbandonedRunners(globalDb)`
- `cleanupAbandonedRunners(globalDb, options)`

The selection logic must match the cleanup invariant already implied by [src/runners/wakeup-global-cleanup.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/runners/wakeup-global-cleanup.ts):

- stale heartbeat rows
- dead-PID rows
- idle rows count too, not only `status = running`
- rows with missing or broken `parallel_session_id` mapping are still eligible

`wakeup-global-cleanup.ts` and the monitor scanner will both import this helper. That removes the current split where cleanup and detection answer different questions.

Sketch:

```ts
export interface AbandonedRunnerRow {
  id: string;
  pid: number | null;
  status: string;
  heartbeat_at: string;
  current_task_id: string | null;
  project_path: string | null;
  raw_project_path: string | null;
  parallel_session_id: string | null;
  project_resolved: boolean;
  reason: 'dead_pid' | 'stale_heartbeat';
}

export function findAbandonedRunners(globalDb: Database): AbandonedRunnerRow[] {}

export function cleanupAbandonedRunners(
  globalDb: Database,
  options: { dryRun: boolean; log: WakeupLogger }
): WakeupResult[] {}
```

### 2. Add A Shared Reload Self-Heal Sweep

Create a new module under `src/self-heal/reload-sweep.ts`.

Responsibility:

- schedule and run a deterministic, reload-safe maintenance pass
- do not spawn normal runners
- do not call LLMs
- do not depend on manual commands

The sweep will:

1. clean abandoned runner rows globally using the shared helper
2. run `recoverStuckTasks()` for enabled projects so orphaned tasks and hanging invocations are repaired
3. optionally scope to a single project when the reload clearly targets one project, but still always clean global runner rows

The reload sweep is intentionally narrower than `wakeup()`:

- it does **not** poll intake
- it does **not** sync GitHub intake gates
- it does **not** start runners
- it does **not** run monitor first responders

That keeps it deterministic and cheap enough for read-triggered use.

Sketch:

```ts
export interface ReloadSelfHealOptions {
  source: 'api:runners' | 'api:task' | 'api:project-tasks';
  projectPath?: string;
}

export function scheduleReloadSelfHeal(options: ReloadSelfHealOptions): void {}
export async function runReloadSelfHealNow(options: ReloadSelfHealOptions): Promise<void> {}
```

### 3. Debounce And Concurrency Rules

The reload-triggered sweep must be resilient to polling pages.

Rules:

- only one in-process sweep may run at a time
- if a sweep completed within the last 5 seconds, a new request may skip scheduling
- if a sweep is already running, additional reloads do nothing
- API read routes must never await the sweep

This preserves the user-visible behavior:

- every reload attempts to seek repair
- the system does not spin on 5-second polling loops

### 4. Trigger The Sweep Explicitly On Reload

Do **not** mutate state from `GET` routes.

Instead, add an explicit background trigger endpoint such as:

- `POST /api/self-heal/reload`

Request body:

```json
{
  "source": "runners_page" | "task_page" | "project_tasks_page",
  "projectPath": "/abs/path/optional"
}
```

Behavior:

- enqueue or schedule the deterministic sweep
- return immediately with `202 Accepted` style semantics
- do not block the page render

The WebUI will call this endpoint on page mount for:

- [WebUI/src/pages/RunnersPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/RunnersPage.tsx)
- [WebUI/src/pages/TaskDetailPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/TaskDetailPage.tsx)
- the page that owns project task-list reloads, such as [WebUI/src/pages/ProjectTasksPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/ProjectTasksPage.tsx) or its shared parent

This keeps HTTP semantics clean while still meeting the user-level requirement that a reload seeks repair.

### 5. Make Monitor Detect Global Abandoned Runner Rows

Extend [src/monitor/scanner.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/scanner.ts) to emit anomalies for abandoned runner rows returned by the shared helper when they were not already covered by project-level `detectStuckTasks()`.

Rules:

- use the shared abandoned-runner finder
- de-duplicate by `runnerId`
- preserve existing project-scoped zombie/dead anomalies
- add unresolved global rows as critical anomalies with the best available `projectPath`

This closes the visibility gap without adding a second runner-health query.

### 6. Tests

Add direct tests under `tests/`:

1. Unit tests in `tests/abandoned-runners.test.ts`
   - stale idle row is found
   - dead-PID row is found
   - broken `parallel_session_id` still resolves as abandoned
   - cleanup deletes row and clears workstream ownership

2. Unit tests in `tests/reload-self-heal.test.ts`
   - reload sweep cleans abandoned global runners
   - reload sweep recovers an orphaned task in an enabled project
   - concurrent schedule requests collapse to one run
   - cooldown suppresses hot-loop re-entry

3. Unit tests in `tests/monitor-scanner.test.ts` or extend existing monitor tests
   - unresolved abandoned runner row appears as anomaly even when no enabled project maps to it

4. API route unit tests
   - `POST /api/self-heal/reload` schedules a global sweep
   - `POST /api/self-heal/reload` with `projectPath` schedules project-scoped recovery
   - invalid body is rejected without scheduling

5. Mock-style integration tests in `tests/reload-self-heal.integration.test.ts`
   - real SQLite temp DBs with stale global runner rows survive the initial read, then disappear after the scheduled sweep
   - real project DB with an orphaned task is repaired after the reload-triggered sweep
   - combined case proves one reload can clean a global runner row and recover a project task in the same pass
   - debounced polling does not launch overlapping sweeps
   - one project throwing during recovery does not stop healthy projects or global runner cleanup

The tests must not use a self-derived oracle. Expected cleanup and anomaly assertions belong in each suite, not in a shared scenario table.

This change is not complete without both layers:

- unit tests for the selection and scheduling logic
- mock-style integration tests that exercise the real DB shape and route-triggered flow

## Implementation Order

1. Extract abandoned-runner detection and cleanup into a shared module.
2. Update wakeup global cleanup to use the shared module.
3. Update monitor scanner to use the shared module for unresolved global runner anomalies.
4. Add the reload self-heal scheduler and runner.
5. Add the explicit `POST /api/self-heal/reload` trigger route.
6. Call that route from the relevant WebUI reload surfaces.
7. Add unit tests for shared helper, scanner visibility, scheduler, route triggers, and bad input.
8. Add mock-style integration tests for reload-triggered repair on real temp DBs, including partial project failure isolation.
9. Move this doc to `docs/done/` when implementation is complete.

## Edge Cases

| Scenario | Handling |
|---|---|
| cron is installed and running normally | reload sweep is still safe; debounce prevents noisy duplicate work |
| reload hits every 5 seconds from Runners page polling | scheduler cooldown collapses repeated requests |
| runner row has dead PID but no `project_path` | cleanup still deletes runner row; monitor anomaly uses fallback project label |
| orphaned task belongs to disabled project | reload sweep does not mutate it in first pass; this remains wakeup-owned behavior |
| project DB missing or corrupt | reload sweep skips project recovery but still cleans global runner rows |
| sweep throws during one project | each project recovery call is wrapped individually so failure is isolated and global cleanup still proceeds |
| multiple API requests arrive at once | in-process mutex prevents concurrent duplicate sweeps |
| user reloads a task page for one project | global runner cleanup always runs; project recovery can be scoped to that project |

## Non-Goals

- replacing scheduled wakeup with reload-triggered maintenance
- auto-starting runners from reload-triggered routes
- running intake pollers or GitHub gate sync from read routes
- adding any LLM-driven monitor behavior to a reload-triggered path
- changing monitor response-mode policy

## Cross-Provider Review

### Gemini

1. Finding: scheduling repair from `GET` routes is an architectural regression because `GET` must stay side-effect free.
   Assessment: valid.
   Decision: adopt.

2. Finding: the design claimed project-failure isolation but did not require per-project `try/catch` in the sweep implementation or test it.
   Assessment: valid.
   Decision: adopt.

3. Finding: unresolved abandoned runner anomalies should not pretend to have a valid project path.
   Assessment: valid, with a simpler fix than inventing a whole new anomaly family.
   Decision: adopt by requiring explicit unresolved context and raw-path reporting for the existing critical runner anomaly.

4. Finding: the test plan was missing the "one project throws, others still recover" case.
   Assessment: valid.
   Decision: adopt.

### Codex

Attempted twice via `codex exec`, but both runs stalled after loading repo context and did not emit a final review. No adopted finding came back from Codex in usable form, so implementation will proceed from the Gemini review plus direct code inspection.
