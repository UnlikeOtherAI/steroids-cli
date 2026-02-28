# Orphaned Task Detection & Reset Design

**Date:** 2026-02-28
**Status:** Approved

## Problem Statement

When a runner crashes or is stopped while a task is `in_progress`, the task becomes orphaned — stuck with no runner to advance it. This state is currently invisible in the project issues section and the reset button does not handle it, leaving users with no in-UI recovery path.

## Current Behavior

- `project.runner` is `null` when no runner is active for a project
- `project.stats.in_progress` counts tasks currently in progress
- The issues section surfaces `failed_retries` and `stale` — but not orphaned tasks
- `canResetProject` only enables the reset button for `isBlocked || failed > 0 || disputed > 0 || skipped > 0`
- `POST /api/projects/reset` calls `tasks reset --all` which flips failed/disputed/stale → pending but does not touch `in_progress` tasks

## Desired Behavior

- Orphaned tasks (in_progress, no active runner) appear as a named issue in the project issues section
- The reset button is enabled when orphaned tasks exist
- Clicking reset flips orphaned tasks to `pending` and triggers a wakeup so a runner picks them up immediately

## Design

### Detection (Frontend Only)

Orphaned count is derived entirely from existing project data — no new API endpoint needed:

```ts
const orphanedCount = !project?.runner && (project?.stats?.in_progress ?? 0) > 0
  ? (project.stats.in_progress ?? 0)
  : 0;
```

This is safe: if any runner is active (`project.runner !== null`), `orphanedCount` is 0 regardless of in_progress count.

### UI: Issues Section

Add a new issue row in `ProjectDetailPage.tsx` alongside existing `failed_retries` and `stale` rows:

- Icon: `fa-circle-pause` (or similar "no runner" indicator)
- Label: "Orphaned tasks"
- Badge: count
- Click: navigates to task list filtered to `status=in_progress` for this project

### UI: canResetProject

```ts
const canResetProject = Boolean(
  project?.isBlocked ||
  (project?.stats?.failed ?? 0) > 0 ||
  (project?.stats?.disputed ?? 0) > 0 ||
  (project?.stats?.skipped ?? 0) > 0 ||
  orphanedCount > 0   // new
);
```

### API: Reset Endpoint

`POST /api/projects/reset` (`API/src/routes/projects.ts`) gains two additions after the existing `tasks reset --all` call:

1. **Reset orphaned tasks** — direct SQL on the project DB:
   ```sql
   UPDATE tasks SET status = 'pending', updated_at = datetime('now')
   WHERE status = 'in_progress'
   ```
   Only runs when the project has no active runner (verified server-side before executing).

2. **Trigger wakeup** — call the existing `wakeup({ quiet: true })` function (same call already used in `POST /api/runners/cron/start`). No changes to wakeup logic.

## Files Changed

| File | Change |
|------|--------|
| `WebUI/src/pages/ProjectDetailPage.tsx` | Add `orphanedCount` derivation, new issue row, update `canResetProject` |
| `API/src/routes/projects.ts` | Add orphaned SQL reset + wakeup call in reset endpoint |

## Non-Goals

- No changes to orchestrator, loop, or runner pickup logic
- No changes to `src/runners/wakeup.ts`
- No changes to the `tasks reset` CLI command
- No new API endpoints for detection

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Runner starts between UI load and reset button click | Server-side guard: check for active runner before SQL update; if runner now active, skip SQL update, still call wakeup |
| Project has both orphaned and failed tasks | Both conditions contribute to `canResetProject`; reset handles all in one click |
| Pool/parallel mode (e.g., workspace clones) | `wakeup()` already handles parallel projects; no special casing needed |
| No tasks in_progress but runner is null | `orphanedCount = 0`, issue row hidden, no change to reset button |
