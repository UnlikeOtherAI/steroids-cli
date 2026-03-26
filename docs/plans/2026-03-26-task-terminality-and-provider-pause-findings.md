# Task Terminality And Provider Pause Findings

## Problem Statement

The current system mixes three different questions:

1. Is the task still automatable?
2. Is the task allowed to retry automatically?
3. Is downstream work allowed to start?

That conflation creates unsafe behavior:

- `skipped` is currently treated as "done enough for dependencies" even though it is also used to mean "manual/external work required".
- some provider/environment failures are correctly treated as provider backoff, while others fall through into generic task failure handling
- there is no explicit persisted signal meaning "the first responder or a human confirmed this task is terminal/manual and should not be retried automatically"

This document records the current findings before changing the contract.

The scope now also includes invocation liveness consistency:

- whether a `task_invocations.status='running'` row actually still has a live owner
- whether paused wakeup leaves stale running invocations visible indefinitely
- whether API/WebUI surfaces leak stale invocation rows as "currently running"

## Current Behavior

### 1. No explicit "confirmed terminal/manual" task flag exists

- First responder outcomes are stored in `monitor_runs`, not on the task itself: [src/commands/monitor-respond.ts](../../src/commands/monitor-respond.ts#L175)
- The first responder can mutate task `status` and counters, but there is no dedicated task field for "confirmed manual" or "confirmed unrecoverable": [src/monitor/investigator-actions.ts](../../src/monitor/investigator-actions.ts#L16), [src/monitor/investigator-actions.ts](../../src/monitor/investigator-actions.ts#L240)
- `monitor_suppressions` is temporary and coarse. It is keyed by `(project_path, anomaly_type)`, not by task, and expires: [src/runners/global-db-schema-migrations-v21.ts](../../src/runners/global-db-schema-migrations-v21.ts#L73)

Practical consequence:

- there is no authoritative persisted answer to "this task was investigated and is now intentionally terminal"

### 2. Dependency gating treats `skipped` as met

The single source of truth today is:

- section dependencies consider `completed`, `disputed`, `skipped`, `partial`, `blocked_error`, and `blocked_conflict` terminal/met: [src/database/queries.ts](../../src/database/queries.ts#L38)
- task dependencies consider `completed`, `disputed`, `skipped`, and `partial` terminal/met: [src/database/queries.ts](../../src/database/queries.ts#L691)

The dependency comments explicitly document this:

- `skipped` is considered done because external setup "handles the rest": [src/database/queries.ts](../../src/database/queries.ts#L252)
- `failed` is intentionally blocking because it is retriable: [src/database/queries.ts](../../src/database/queries.ts#L261)

Tests confirm the current contract:

- `skipped` does not block section dependencies: [tests/section-dependencies-base.test.ts](../../tests/section-dependencies-base.test.ts#L168)
- `failed` does block section dependencies: [tests/section-dependencies-base.test.ts](../../tests/section-dependencies-base.test.ts#L312)

Practical consequence:

- downstream work can start after an upstream task is marked `skipped`
- downstream work is blocked after an upstream task is marked `failed`

### 3. Wakeup sanitise auto-retries both `failed` and `skipped`

Periodic sanitise currently resets both `failed` and `skipped` tasks back to `pending` after 30 minutes, up to 3 times: [src/runners/wakeup-sanitise.ts](../../src/runners/wakeup-sanitise.ts#L281)

It also pulls active downstream section tasks back to `pending` if an upstream task is recovered: [src/runners/wakeup-sanitise.ts](../../src/runners/wakeup-sanitise.ts#L345)

Practical consequence:

- even if a task is marked `skipped`, the system may later auto-retry it
- current `skipped` behavior is not a reliable "we are definitely done here" contract

### 4. Credit exhaustion and auth error are already modeled as provider backoff, not task terminality

Provider classification distinguishes:

- `credit_exhaustion`
- `rate_limit`
- `auth_error`
- `context_exceeded`

in the base provider classifier: [src/providers/interface.ts](../../src/providers/interface.ts#L71)

For `credit_exhaustion`, the runner:

- records an incident
- records global provider backoff
- exits without converting the task into a terminal status

See: [src/runners/credit-pause.ts](../../src/runners/credit-pause.ts#L53)

For auth errors, the runner records a 24-hour auth backoff and wakeup later probes the provider for recovery: [src/runners/credit-pause.ts](../../src/runners/credit-pause.ts#L110), [src/runners/wakeup-project.ts](../../src/runners/wakeup-project.ts#L188)

Wakeup consults project-scoped provider backoff before spawning a runner: [src/runners/global-db-backoffs.ts](../../src/runners/global-db-backoffs.ts#L87), [src/runners/wakeup-project.ts](../../src/runners/wakeup-project.ts#L270)

Practical consequence:

- provider exhaustion is already mostly separated from task terminality
- the old "poll every 30 seconds" design is no longer the active runtime path for credit exhaustion

### 5. `context_exceeded` is classified, but not handled as a first-class recovery state

`BaseAIProvider.classifyError()` returns `context_exceeded`: [src/providers/interface.ts](../../src/providers/interface.ts#L150)

But coder/reviewer phase handling only special-cases:

- `credit_exhaustion`
- `rate_limit`
- `auth_error`

See: [src/commands/loop-phases-coder.ts](../../src/commands/loop-phases-coder.ts#L152), [src/commands/loop-phases-reviewer.ts](../../src/commands/loop-phases-reviewer.ts#L136), [src/commands/loop-phases-reviewer.ts](../../src/commands/loop-phases-reviewer.ts#L226)

Practical consequence:

- context-window overflow currently falls through generic provider failure handling
- it does not participate in the same explicit pause/backoff policy as credit/auth problems

### 6. Monitor/first-responder history is diagnostic, not authoritative task-resolution state

The monitor records:

- anomaly scans
- whether first responder was dispatched
- first responder report
- requested actions
- action execution results

See: [src/commands/monitor-respond.ts](../../src/commands/monitor-respond.ts#L178)

This is useful evidence, but it is not the same as a task-level invariant consulted by:

- dependency gating
- wakeup sanitise
- task selection
- UI reset logic

### 7. Running-invocation liveness is not validated at API/UI read time

The current task-detail API returns raw invocation rows for a task without checking whether a `status='running'` row still has a live owner:

- raw invocation list query: [API/src/routes/tasks.ts](../../API/src/routes/tasks.ts#L391)
- live-stream endpoint also trusts any `status='running'` invocation row: [API/src/routes/tasks.ts](../../API/src/routes/tasks.ts#L509)

The task-detail WebUI then renders any invocation with `status === 'running'` as live:

- running badge logic: [WebUI/src/pages/TaskDetailComponents.tsx](../../WebUI/src/pages/TaskDetailComponents.tsx#L167)
- invocation panel renders the full returned list with no liveness filtering: [WebUI/src/pages/TaskDetailComponents.tsx](../../WebUI/src/pages/TaskDetailComponents.tsx#L342)

The new project-recovery summary also uses `task_invocations.status='running'` to determine the "last active task" candidate:

- [API/src/routes/project-recovery.ts](../../API/src/routes/project-recovery.ts#L73)

Practical consequence:

- if stale `running` invocation rows remain after the owning runner is gone, the UI can claim work is still running when there are actually zero live runners
- duplicate stale invocation rows for one task can render as multiple apparent live sessions

### 8. Reload self-heal does not currently reconcile stale running invocations

Reload self-heal currently performs:

- global abandoned-runner cleanup
- project-level `recoverStuckTasks()`

See: [src/self-heal/reload-sweep.ts](../../src/self-heal/reload-sweep.ts#L91)

It does not run the wakeup sanitise orphaned-invocation reconciliation path.

That orphaned-invocation logic lives in wakeup sanitise recovery:

- owner-dead / stale invocation reconciliation: [src/runners/wakeup-sanitise-recovery.ts](../../src/runners/wakeup-sanitise-recovery.ts#L131)

Practical consequence:

- when wakeup is intentionally paused, stale `task_invocations.status='running'` rows can survive indefinitely even though reload self-heal is expected to make the interface safe on refresh

### 9. `recoverStuckTasks()` can move task state without clearing stale running invocations

The reload self-heal path delegates project recovery to `recoverStuckTasks()`: [src/self-heal/reload-sweep.ts](../../src/self-heal/reload-sweep.ts#L66)

But the task-level recovery actions in `recoverStuckTasks()`:

- reset or escalate orphaned tasks: [src/health/stuck-task-recovery.ts](../../src/health/stuck-task-recovery.ts#L187)
- reset or escalate hanging invocations: [src/health/stuck-task-recovery.ts](../../src/health/stuck-task-recovery.ts#L237)

do not update or close project-local `task_invocations` rows.

Practical consequence:

- self-heal can move a task to `pending` or `skipped` and still leave stale `task_invocations.status='running'` rows behind
- the API/UI can then present contradictory state: terminal or reset task state alongside apparently live agent sessions

### 10. Current live evidence confirms the inconsistency

Observed in the live `switcher` project on 2026-03-26:

- `GET /api/runners` returned zero active runners
- the task detail for `0e0a16a5-75a4-46f2-b494-8799947c0338` still returned two `reviewer` invocations with `status='running'`
- both stale rows referred to the same old runner id, and there was no matching live runner row in the global `runners` table

Practical consequence:

- this is not a hypothetical design concern; the interface is already surfacing stale runtime state as current truth

## Desired Behavior

The system should answer these questions separately and deterministically:

1. Is the task unresolved and still eligible for automatic work?
2. Is the task confirmed manual/unrecoverable, so automatic retry must stop?
3. Is downstream work allowed to proceed without this task's output?
4. Is the failure actually a provider/project execution problem rather than a task-resolution problem?

Minimum contract:

- provider exhaustion, auth failure, and similar environment failures must not be represented as "task done"
- a task should only become "confirmed manual/unrecoverable" through an explicit persisted decision path
- dependency gating must consult that explicit resolution contract, not infer too much from overloaded statuses
- wakeup sanitise must not auto-retry tasks that were explicitly confirmed terminal/manual
- a `running` invocation must not be shown as live unless its owner is still live or it has passed an explicit orphan-recovery check

## Design

This document is findings-first. It does not yet choose the final schema. The minimum acceptable design direction is:

1. Keep provider/project pause separate from task terminality.
   Credit exhaustion, auth failure, and similar execution-environment failures should remain in provider/project backoff state, not in `skipped`.

2. Introduce one authoritative task-resolution contract.
   The system needs one source of truth for whether automatic retry is allowed and whether downstream work is safe to unblock.

3. Stop treating raw `skipped` as sufficient proof that downstream is safe.
   Today `skipped` means both "manual/external" and "safe to continue". Those are not the same invariant.

4. Stop auto-resetting explicitly confirmed manual/unrecoverable tasks.
   Periodic sanitise may retry unresolved/retriable work, but not work that has been deliberately finalized.

5. Add an explicit handling path for `context_exceeded`.
   It should not silently degrade into generic task failure if the intended behavior is "needs model/config/prompt change".

6. Make invocation liveness a first-class invariant.
   API/UI surfaces must not trust raw `task_invocations.status='running'` rows without validating owner liveness or consuming a reconciled source of truth.

Open design choice:

- whether the authoritative contract should be a new task field, a structured task-resolution table, or a stricter status redesign

The wrong design would be:

- adding more special cases around `skipped` and `failed` without a single source of truth

## Implementation Order

1. Write the invariant document for task resolution and downstream gating.
2. Decide the authoritative persisted representation for:
   - retry allowed?
   - downstream allowed?
   - confirmed manual/unrecoverable?
3. Align dependency gating in:
   - `getPendingDependencies`
   - `hasDependenciesMet`
   - `hasTaskDependenciesMet`
   - task selection call sites
4. Align wakeup sanitise with the same source of truth so it does not auto-retry explicitly finalized work.
5. Add explicit `context_exceeded` handling in coder/reviewer loop paths.
6. Decide where stale `running` invocations are reconciled when wakeup is paused:
   - read-time filtering
   - reload self-heal
   - both
7. Align `recoverStuckTasks()` and other deterministic recovery paths so task-state repair and invocation-state repair cannot diverge.
8. Align task-detail API, SSE, recovery summary, and WebUI invocation panels to the same liveness contract.
9. Add WebUI/API surfaces that display the authoritative task-resolution state instead of inferring from `skipped`.
10. Add both unit tests and mock-style integration tests for every adopted scenario.

## Edge Cases

| Scenario | Current behavior | Problem |
|---|---|---|
| Upstream task marked `skipped` | downstream deps treated as met | unsafe if `skipped` really means "manual work still required" |
| Upstream task marked `failed` | downstream deps blocked | consistent with retriable semantics, but not with a future "confirmed unrecoverable" state |
| `failed` or `skipped` sits for 30+ minutes | wakeup sanitise resets it to `pending` | no durable terminal/manual contract |
| credit exhaustion | provider backoff + runner exit | mostly correct; should remain separate from task terminality |
| auth error | 24h provider backoff + wakeup probe | mostly correct; should remain separate from task terminality |
| context window exceeded | classified as `context_exceeded` but falls through generic failure | missing dedicated recovery policy |
| first responder says `report_only` | diagnosis stored in monitor run only | no task-level authoritative resolution |
| monitor suppression | temporary project+anomaly mute | not a task-level permanent decision |
| task has stale `running` invocation rows but zero live runners | task detail can still show “Running” sessions | API/UI trust raw invocation rows instead of validated liveness |
| wakeup paused, page reload self-heal runs | stale running invocations can survive | reload self-heal does not currently reuse orphaned-invocation reconciliation |
| self-heal resets or escalates task state | stale invocation rows can remain `running` | task-state repair and invocation-state repair diverge |
| one task has duplicate stale running invocations | UI can show multiple apparent live sessions | no dedupe or owner validation on read path |

## Non-Goals

- choosing the final schema in this document
- changing behavior in this document
- reworking monitor UI in this document
- solving unrelated project reset/UI issues here

## Cross-Provider Review

### Round 1 — Gemini Findings On The Findings Stage

#### G1. `skipped` is both dependency-terminal and auto-retriable

- **Finding:** `skipped` counts as met in dependency gating, but `wakeup-sanitise` later resets `skipped` tasks to `pending`.
- **Assessment:** Adopt. This is the core contradiction in the current contract.
- **Decision:** Adopt.

#### G2. No durable confirmed-terminal/manual state

- **Finding:** neither first responder nor human action has a persisted task-level state that all automated systems respect as "do not retry automatically".
- **Assessment:** Adopt. This is real and is the main reason monitor/FR, dependency gating, and sanitise can disagree.
- **Decision:** Adopt.

#### G3. `context_exceeded` falls through generic failure handling

- **Finding:** provider classification returns `context_exceeded`, but coder/reviewer phase handling does not branch on it.
- **Assessment:** Adopt. This is a concrete gap and a deterministic waste path.
- **Decision:** Adopt.

#### G4. Duplicate suppression may silence persistent report-only anomalies

- **Finding:** monitor duplicate suppression relies on previous run outcome rather than confirmed state change, so `report_only` first-responder runs can suppress persistent anomalies.
- **Assessment:** Adopt. This matches an existing local lesson and remains relevant to the broader "durable confirmation contract" problem.
- **Decision:** Adopt.

#### G5. `wakeup-sanitise` recovery resets can be lossy

- **Finding:** reset-to-pending recovery clears counters such as `rejection_count`, losing task history during recovery.
- **Assessment:** Partially adopt. Real issue, but secondary to the contract bugs above. Preserve as follow-up unless it becomes necessary for the main redesign.
- **Decision:** Defer as follow-up.

### Round 2 — New Findings To Review

These findings were added from live investigation before the next external review pass:

#### R2-1. Task detail surfaces can present stale running invocations as live work

- **Finding:** task detail API, SSE invocation lookup, and WebUI invocation badges trust raw `task_invocations.status='running'` rows without checking for live runner ownership.
- **Assessment:** Adopt. Claude Opus confirmed the same trust-boundary bug across task detail, SSE, recovery summary, and WebUI rendering.
- **Decision:** Adopt.

#### R2-2. Reload self-heal does not currently repair stale running invocations when wakeup is paused

- **Finding:** reload self-heal runs abandoned-runner cleanup and `recoverStuckTasks()`, but does not execute the orphaned-invocation reconciliation path used by wakeup sanitise.
- **Assessment:** Adopt. Claude Opus confirmed this is an active correctness gap when wakeup is paused.
- **Decision:** Adopt.

#### R2-3. Duplicate stale running invocations on one task can render as multiple live sessions

- **Finding:** the UI counts and renders returned invocation rows directly, so duplicated stale `running` rows on one task appear as separate active sessions.
- **Assessment:** Adopt. This is the UI consequence of the same stale-invocation trust bug.
- **Decision:** Adopt.

#### R2-4. Deterministic self-heal can repair task state without repairing invocation state

- **Finding:** `recoverStuckTasks()` can reset or escalate tasks without closing the associated stale `task_invocations.status='running'` rows, so self-heal can leave contradictory runtime state behind.
- **Assessment:** Adopt. Claude Opus confirmed all current `recoverStuckTasks()` branches mutate task state but never reconcile invocation state.
- **Decision:** Adopt.

### Round 3 — Claude Opus Findings

Claude Opus was asked to do an adversarial findings-stage review focused on invocation liveness, task terminality, dependency gating, paused-wakeup recovery, and provider-pause consistency.

#### C1. `recoverStuckTasks()` never closes stale `task_invocations` rows

- **Finding:** `recoverOrphanedTask`, `recoverHangingInvocation`, and `recoverZombieOrDeadRunner` reset task state and locks, but never update `task_invocations.status='running'`.
- **Assessment:** Adopt. Verified directly in [stuck-task-recovery.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/health/stuck-task-recovery.ts).
- **Decision:** Adopt.

#### C2. Reload self-heal skips orphaned-invocation reconciliation

- **Finding:** `runReloadSelfHealNow()` only runs abandoned-runner cleanup and `recoverStuckTasks()`, not the wakeup sanitise path that repairs orphaned invocations.
- **Assessment:** Adopt. Verified directly in [reload-sweep.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/self-heal/reload-sweep.ts).
- **Decision:** Adopt.

#### C3. API and WebUI surfaces blindly trust stale `running` invocations

- **Finding:** task detail API, SSE running-invocation lookup, recovery summary, and WebUI invocation badges all treat raw `task_invocations.status='running'` as live state.
- **Assessment:** Adopt. Verified directly in [tasks.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/tasks.ts), [project-recovery.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/project-recovery.ts), and [TaskDetailComponents.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/TaskDetailComponents.tsx).
- **Decision:** Adopt.

#### C4. `skipped` is dependency-terminal and auto-retriable

- **Finding:** dependency gates treat `skipped` as terminal, while wakeup sanitise resets old `skipped` tasks to `pending`.
- **Assessment:** Adopt. This matches the existing core contradiction already documented by Gemini.
- **Decision:** Adopt.

#### C5. `disputed` has the same contradiction as `skipped`

- **Finding:** dependency gates treat `disputed` as terminal, while wakeup sanitise resets old `disputed` tasks to `pending`.
- **Assessment:** Adopt. This extends the same terminality problem and should be handled in the same redesign, not as a separate special case.
- **Decision:** Adopt.

#### C6. Abandoned-runner cleanup only resets `in_progress`

- **Finding:** abandoned-runner cleanup closes `running` invocations but only resets the task itself when its status is `in_progress`, leaving dead-runner `review` and `merge_pending` tasks behind.
- **Assessment:** Adopt. Verified directly in [abandoned-runners.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/runners/abandoned-runners.ts).
- **Decision:** Adopt.

#### C7. `context_exceeded` is classified but not handled

- **Finding:** provider classification produces `context_exceeded`, but coder/reviewer pause handling only branches on credit, rate-limit, and auth errors.
- **Assessment:** Adopt. This matches the existing Gemini finding and direct grep results.
- **Decision:** Adopt.

#### C8. Manual task restart does not close stale invocations

- **Finding:** `POST /api/tasks/:taskId/restart` resets the task row but leaves any stale `running` invocations in place.
- **Assessment:** Adopt. Verified directly in [tasks.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/tasks.ts).
- **Decision:** Adopt.

#### C9. Batch task selection does not filter skipped sections

- **Finding:** `selectTaskBatch()` looks for pending tasks by section and dependency readiness, but does not exclude skipped sections the way `findNextTask()` does.
- **Assessment:** Adopt. Verified directly in [task-selector.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/orchestrator/task-selector.ts).
- **Decision:** Adopt.

#### C10. `project-recovery.ts` mixes `dist/` and `src/` imports

- **Finding:** the route imports most runtime dependencies from `dist/` but imports `PROJECT_RESETTABLE_STATUSES` from `src/`.
- **Assessment:** Defer pending implementation review. This is suspicious and likely wrong in compiled runtime, but it is a build/runtime wiring issue rather than part of the core terminality design.
- **Decision:** Defer as follow-up unless it blocks the implementation.

#### C11. S4 sanitise resets are lossy

- **Finding:** S4 resets zero `failure_count` and `rejection_count`, which can erase useful recovery history even though audit rows remain.
- **Assessment:** Partially adopt. Real issue, but secondary to the liveness and terminality invariants above.
- **Decision:** Defer as follow-up.

### Pending Post-Implementation Review

For the implementation that comes out of this document, run an aggressive Gemini review after tests pass.

Review instructions:

- be adversarial
- look specifically for gaps in:
  - ticket state reassignment
  - terminality semantics
  - dependency gating
  - wakeup/sanitise retry behavior
  - provider-pause vs task-terminal boundaries
  - downstream tasks starting when they should remain blocked

This review is required before the work is considered complete.

When this turns into an implementation design that changes dependency gating, task selection, runner exit conditions, or task status semantics, it falls under the core-engine review rule in [AGENTS.md](../../AGENTS.md).
