# WebUI Project Reset And Last Active Task

## Problem Statement

Operators can hit blocked, failed, or disputed work in the WebUI without having a clear whole-project recovery action in the pages where they are looking at the problem. The existing project reset flow is buried inside the Project Detail page, while task and project-task pages only expose per-task restart or no reset action at all.

Stopped projects also lose the identity of the last task that was actively running. In the live `switcher` project on March 26, 2026, the Project Detail page showed `No Runner`, but the newest invocation rows still pointed to task `0e0a16a5-75a4-46f2-b494-8799947c0338`. When a project is stopped in the middle of work, operators need to see which task was last active and whether it has dependents before deciding to reset.

## Current Behavior

- [API/src/routes/projects.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/projects.ts) exposes project stats, current runner info, and a project reset endpoint.
- `POST /api/projects/reset` calls `steroids tasks reset --all`, which resets failed, disputed, and blocked tasks, then clears orphaned `in_progress` rows when no live runner exists.
- [WebUI/src/pages/ProjectDetailPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/ProjectDetailPage.tsx) shows a `Reset Project` button only inside the `Issues` panel.
- [WebUI/src/pages/ProjectTasksPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/ProjectTasksPage.tsx) does not expose whole-project reset.
- [WebUI/src/pages/TaskDetailPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/TaskDetailPage.tsx) only exposes per-task restart.
- Project API responses only expose `runner.current_task_id` while a runner is live. Once the runner stops, the UI falls back to `No Runner` and loses the last active task identity.

## Desired Behavior

- Any page focused on broken work should expose a clear whole-project reset action.
- The reset action must mean whole-project reset, not single-task restart.
- Operators must be able to see the last active task for a project even when there is no active runner.
- The last active task summary must include enough context to judge dependency risk:
  - task id
  - task title
  - task status
  - last active role
  - last activity timestamp
  - dependent task count
- Project reset must stay dependency-safe by reusing the existing CLI reset path rather than inventing a second reset implementation.

## Design

### 1. Add a project recovery summary API

Add a focused recovery endpoint in [API/src/routes/project-recovery.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/project-recovery.ts):

- `GET /api/projects/recovery?path=...`

```ts
interface ProjectRecoverySummary {
  can_reset_project: boolean;
  reset_reason_counts: {
    failed: number;
    disputed: number;
    skipped: number;
    blocked_error: number;
    blocked_conflict: number;
    orphaned_in_progress: number;
  };
  last_active_task: {
    id: string;
    title: string;
    status: string;
    role: string | null;
    last_activity_at: string;
    dependent_task_count: number;
  } | null;
}
```

Rules:

- `can_reset_project` must come from one shared helper inside the recovery route so the endpoint and UI rendering read the same resettable-state calculation.
- The helper must count the same resettable states the current reset flow covers: `failed`, `disputed`, `blocked_error`, `blocked_conflict`, `skipped`, and `orphaned_in_progress`.
- `last_active_task` selection order:
  1. newest open invocation (`status = running`) by `COALESCE(last_activity_at_ms, started_at_ms)`
  2. newest finished invocation by `COALESCE(last_activity_at_ms, completed_at_ms, started_at_ms)`
  3. active runner `current_task_id`, only as a final fallback when invocation history cannot identify a task
- `last_active_task` must be resolved by joining `task_invocations` to `tasks` so the API never returns a dangling task id that would 404 in the UI.
- `dependent_task_count` must come from `task_dependencies WHERE depends_on_task_id = last_active_task.id`.
- `dependent_task_count` is advisory UI context only. It does not answer whether dependents are runnable or blocked by section-level gates.

This keeps the source of truth in the API instead of asking each page to reconstruct task history differently.

### 2. Make whole-project reset visible on failure-focused pages

Add a shared project recovery panel component for:

- [WebUI/src/pages/ProjectDetailPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/ProjectDetailPage.tsx)
- [WebUI/src/pages/ProjectTasksPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/ProjectTasksPage.tsx)
- [WebUI/src/pages/TaskDetailPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/TaskDetailPage.tsx)

Behavior:

- show `Reset Project` when `recovery.can_reset_project` is true
- disable it while submitting
- require explicit confirmation that the action is project-wide and list the resettable counts in the confirmation text
- after success, reload the affected page data
- on Task Detail, keep `Restart Task` separate from `Reset Project`
- on Project Tasks, show the panel above the list so blocked/failed views expose the action immediately

The button should always be labeled `Reset Project`, never `Restart`, to avoid conflating project-wide recovery with single-task retry.

### 3. Surface last active task context

Show the `last_active_task` summary in the shared recovery panel and on Project Detail near runner status.

Presentation:

- label: `Last active task`
- link to `/task/:id?project=<path>`
- show status badge and last active role
- show relative or local timestamp
- if `dependent_task_count > 0`, show a warning line such as `2 tasks depend on this task`
- if the API response is older and does not include `recovery`, the UI must degrade by hiding the new panel instead of throwing

This gives operators the missing dependency-risk context after the runner is gone.

### 4. Keep reset semantics unchanged

Do not invent a new reset implementation.

- Keep `POST /api/projects/reset` as the execution path.
- Reuse the existing CLI reset contract so blocked/failed/disputed handling stays centralized in [src/commands/tasks-reset.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/commands/tasks-reset.ts).
- Update the UI copy in Project Detail to match reality if current endpoint behavior differs from the text.

## Implementation Order

1. Extend `ProjectResponse` in the projects API with `recovery`.
2. Add the API query helper that derives `last_active_task` and dependent count from the project DB.
3. Update WebUI project types and API client types.
4. Add a reusable project recovery panel component.
5. Wire the panel into Project Detail, Project Tasks, and Task Detail pages.
6. Add targeted tests for API summary derivation and WebUI rendering/actions.
7. Verify the live `switcher` project in Playwright:
   - stopped project shows last active task
   - whole-project reset is visible from task/project-task pages when resettable conditions exist

## Edge Cases

| Scenario | Expected handling |
| --- | --- |
| No runner and no invocation history | `last_active_task = null`; UI shows no summary |
| Runner active but `current_task_id` is null | fall back to invocation history |
| Multiple stale running invocations exist | pick the newest by `COALESCE(last_activity_at_ms, started_at_ms)` |
| Parallel mode has several active tasks | summary shows the single most recently active task across invocation history |
| Last active task no longer exists in `tasks` | return `null` rather than dangling ID |
| Last active task has dependents | show dependent count in UI |
| Project has only review/pending tasks and no resettable states | `Reset Project` remains hidden/disabled |
| Task Detail page for a healthy task | still show per-task restart rules; do not show project reset unless project recovery says reset is warranted |

## Non-Goals

- Changing task selector or dependency gating behavior
- Changing the semantics of `tasks reset --all`
- Adding automatic reset on page load
- Adding monitor-driven or first-responder-driven resets

## Cross-Provider Review

### Gemini

1. Finding: `can_reset_project` could drift from the real reset contract if it duplicates status logic.
Decision: adopt.
Change: build one shared helper inside the projects route module and use it for both project endpoints and UI-facing summary data.

2. Finding: choosing the newest running invocation by raw start time is wrong.
Decision: adopt.
Change: order running invocations by `COALESCE(last_activity_at_ms, started_at_ms)`.

3. Finding: a project-wide reset button on Task Detail needs explicit scope confirmation.
Decision: adopt.
Change: require a confirmation step that lists the project-wide counts affected.

4. Finding: `last_active_task` must join against `tasks` to avoid dangling task links.
Decision: adopt.
Change: resolve summary rows only through joined task records.

5. Finding: WebUI must tolerate older API responses that do not yet include `recovery`.
Decision: adopt.
Change: make the new panel conditional on `project.recovery` being present.

### Codex

1. Finding: relying on a single runner row is already lossy for projects that can have parallel-session runners.
Decision: adopt.
Change: make invocation history the primary source for `last_active_task`; use `runner.current_task_id` only as fallback.

2. Finding: a raw dependent-task count can be misread as a full dependency-state verdict.
Decision: adopt.
Change: keep it as advisory context only and avoid using it for gating or warnings stronger than “tasks depend on this task”.
