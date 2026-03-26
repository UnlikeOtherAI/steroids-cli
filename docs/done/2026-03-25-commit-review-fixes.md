# Commit Review Fixes

## Problem Statement

A review of commits from March 23-25, 2026 found six real gaps that should be fixed in-repo instead of left as process debt:

1. `feat: add delete subcommand for tasks and sections` introduced destructive CLI paths that delete project DB rows without cleaning corresponding global runner/workspace state.
2. `fix(merge-queue): use stored remote_url when runner CWD is wrong repo` fixed a real merge-queue defect but landed without regression coverage for the new `workspace_pool_slots.remote_url` lookup.
3. `feat(merge-queue): phase 2+3 code — merge gate pipeline` dropped automated post-approval side effects on the normal merge path: intake approval transitions and section auto-PR checks no longer run when a task completes through the merge queue.
4. `fix: address Phase 4 cross-provider review findings` still leaves stale reviewer-approval recovery broken: recovered approve decisions do not preserve no-op-vs-merge semantics and can move a task to `merge_pending` without a valid `approved_sha`, which deterministically sends the merge queue into `blocked_error`.
5. The merge queue completion path writes `completed` directly instead of using the shared completion updater, so operational counters can survive a successful merge.
6. Recent user-facing CLI additions (`steroids tasks delete`, `steroids sections delete`, `steroids ai run`, `steroids ai proxy`) are still absent from `README.md`.

These are not cosmetic issues. Items 3-5 are core-engine regressions in the merge/refactor work and violate the repo’s stated invariants around self-healing, single sources of truth, and intake-pipeline consistency.

## Current Behavior

### Delete commands leave runtime state behind

Commit `43044fa0e4a74742cc7036618a04c2353b8952b4` added delete flows in:

- `src/commands/tasks-reset.ts`
- `src/commands/sections-delete.ts`
- `src/database/queries.ts`

The new delete path removes project DB rows but does not reliably:

- revoke workstream leases in the global DB,
- remove runner rows for the deleted task,
- release `workspace_pool_slots` still bound to the task,
- share cleanup logic with reset.

`resetTaskCmd()` already contains partial runtime cleanup logic, so reset/delete now answer the same invariant question through different code paths.

It also leaves out merge-lock ownership. A force-deleted `merge_pending` task can still own a `workspace_merge_locks` row through its runner/slot, so cleanup that only revokes workstreams and releases slots is still incomplete.

### Merge-queue remote URL fix has no regression coverage

Commit `ea46ae7a0e4878e58f49b695eecee80669f64d0e` changed `handleRebasePhase()` in `src/orchestrator/merge-queue.ts` to prefer `workspace_pool_slots.remote_url` over `resolveRemoteUrl(sourceProjectPath)`.

That logic is correct, but there is no test proving:

- stored slot metadata wins over an incorrect repo CWD, and
- the fallback still uses `resolveRemoteUrl()` when no stored remote exists.

### Merge-queue completion lost automated approval side effects

Before commit `4018ea79606fa1f9f0ff88380bc92f4c73d3d8af`, normal reviewer approval paths in `src/commands/loop-phases-reviewer.ts` called:

- `handleIntakeTaskApproval(...)`
- `checkSectionCompletionAndPR(...)`

The refactor preserved those calls only on the no-op approval path. The normal approval path now moves tasks to `merge_pending`, and `src/orchestrator/merge-queue.ts` later marks them `completed` without running the lost side effects.

Concrete consequence:

- intake tasks approved through the merge queue no longer advance the intake pipeline,
- section auto-PR creation no longer runs when the section-finishing task completes through the merge queue.

### Stale reviewer approval recovery loses approval semantics and queues tasks without `approved_sha`

`src/runners/wakeup-sanitise-recovery.ts` recovers a stale reviewer invocation with an approve token by:

- marking the invocation completed,
- transitioning the task from `review` to `merge_pending`,
- setting `merge_phase = 'queued'`,
- not setting `approved_sha`,
- not distinguishing `[NO_OP_SUBMISSION]` approvals, which the normal reviewer path completes directly.

`src/orchestrator/merge-queue.ts` then explicitly blocks:

- `handleMergeAttempt()` requires `task.approved_sha`,
- missing SHA transitions the task to `blocked_error` with `[merge_queue] No approved_sha`.

So the recovery path is not self-healing. It can both strand a merge-required task and mis-handle a no-op approval by routing it through the merge queue instead of completing it directly.

### Merge-queue completion bypasses shared completed-state cleanup

`markCompleted()` in `src/orchestrator/merge-queue.ts` does a direct `UPDATE tasks SET status = 'completed', ...`.

That bypasses `updateTaskStatus(..., 'completed', ...)` in `src/database/queries.ts`, which is the shared path that clears operational counters on successful completion:

- `failure_count`
- `rejection_count`
- `merge_failure_count`
- `last_failure_at`

This regresses the invariant restored earlier by commit `cbf8663`.

### README drift

The current `README.md` does not mention the following commands added in the reviewed commit window:

- `steroids tasks delete`
- `steroids sections delete`
- `steroids ai run`
- `steroids ai proxy`

That violates the “Documentation Alignment (CRITICAL)” rule in `AGENTS.md`.

### Confirmed non-issue: `partial` is intentionally active for section completion

While reviewing the core refactor, one apparent inconsistency surfaced around `partial`:

- dependency gating treats `partial` as terminal,
- section completion / auto-PR checks treat `partial` as active.

This is intentional and already documented in `docs/plans/2026-02-27-branch-targeting-design.md`: section completion for PR purposes excludes `partial`. No semantic change to `partial` belongs in this patch.

## Desired Behavior

1. Deleting a task or force-deleting a section must clean global runtime state before project DB rows are removed.
2. Reset/delete runtime cleanup must use one shared cleanup path.
3. Merge-queue completion must preserve the pre-refactor automated approval side effects for intake transitions and section PR checks.
4. Stale reviewer approval recovery must preserve no-op-vs-merge semantics and either reconstruct a valid scoped `approved_sha` from durable local state or fail closed immediately, not enqueue a null-SHA merge.
5. Merge-queue completion must reuse the shared completed-status logic so counters are cleared consistently.
6. Merge-queue remote selection must have targeted regression coverage.
7. `README.md` must document the recent user-facing CLI additions.

## Design

### 1. Centralize destructive task runtime cleanup

Add a shared helper in `src/commands/task-runtime-cleanup.ts` that:

- finds runner rows for the task in the global DB,
- kills a live Steroids runner process when one still owns the task,
- revokes any leased workstream and unblocks the parallel session if needed,
- removes the runner row,
- releases `workspace_pool_slots` currently bound to the task for the project,
- releases any `workspace_merge_locks` still owned by the task-bound runner/slot.

Use that helper from:

- `resetTaskCmd()`
- `deleteTaskCmd()`
- `deleteSectionCmd()` for each task included in a force delete

This keeps “task runtime cleanup” as one concern with one implementation.

### 2. Make delete paths explicit about force semantics

For task deletion:

- require `--force` for runtime-owned states, not only `in_progress`,
- treat `review` and `merge_pending` as force-required because they can still own runner/slot state,
- run runtime cleanup before deletion when `--force` is used.

For section deletion:

- enumerate section tasks first,
- on `--force`, run shared runtime cleanup for each task,
- then perform the project DB delete.

### 3. Restore automated post-approval side effects through one helper

Create a small helper for automated approval completion effects, responsible for:

- `handleIntakeTaskApproval(...)`
- `checkSectionCompletionAndPR(...)`

Use it in exactly two places:

- the existing reviewer no-op approval path,
- merge-queue completion after the task is actually marked `completed`.

This restores pre-refactor behavior without reintroducing direct merge logic into reviewer phase code.

Do not expand this helper to manual CLI hooks in this patch. Manual `steroids tasks approve` has separate `--no-hooks` behavior and is a different entrypoint.

### 4. Recover stale reviewer approvals with the same durable submission source reviewer preflight trusts

In `src/runners/wakeup-sanitise-recovery.ts`, when a stale reviewer invocation is recovered as approve:

- first inspect the latest scoped review submission notes to determine whether this was a `[NO_OP_SUBMISSION]`,
- if it was no-op, recover directly to `completed` through the same automated completion helper used by the live reviewer no-op path,
- otherwise resolve `approved_sha` from the same scoped durable submission chain reviewer preflight already trusts,
- use that scoped SHA when moving to `merge_pending`.

The source must not be a raw “latest review audit row” lookup. This repo already scopes submission history to the latest active lifecycle in `getSubmissionCommitShas(...)` to avoid stale review-chain contamination. Recovery should reuse that same scoped source of truth, and only prefer the durable-ref SHA when it matches the scoped submission head.

If no such SHA exists, do not enqueue `merge_pending` with a null `approved_sha`. Fail closed immediately with an explicit `blocked_error`/audit note at recovery time.

### 5. Route merge completion through shared completion logic

Replace the direct-completion write in `src/orchestrator/merge-queue.ts` with a helper that:

- uses `updateTaskStatus(..., 'completed', ...)` so operational counters are cleared,
- clears merge-specific fields (`merge_phase`, `approved_sha`, `rebase_attempts`) in the same completion path,
- then runs the automated approval side effects helper from Design item 3.

Use that path for:

- normal merge success,
- already-merged idempotent completion,
- local-only completion,
- rebase-path local-only completion.

### 6. Add targeted regression tests

Add tests that prove:

- force-deleting a task releases task-bound workspace slots and clears runner/workstream state,
- force-deleting a section cleans runtime state for included tasks before deletion,
- stale reviewer-approval recovery records a usable `approved_sha` from the scoped durable submission chain,
- stale reviewer-approval recovery preserves `[NO_OP_SUBMISSION]` by completing directly instead of routing through merge,
- stale reviewer-approval recovery fails closed immediately when no durable SHA exists,
- merge-queue completion clears operational counters through the shared completed-status path,
- merge-queue completion still runs intake approval and section-PR side effects,
- merge-queue remote resolution prefers stored `workspace_pool_slots.remote_url`,
- merge-queue remote resolution falls back to repo remote lookup when slot metadata is absent.

Prefer deterministic unit/integration coverage over full CLI end-to-end tests.

### 7. Repair README drift

Update `README.md` with short entries for:

- destructive delete commands,
- `steroids ai run`,
- `steroids ai proxy`.

Keep it concise and aligned with existing command tables.

## Implementation Order

1. Finish the shared runtime-cleanup helper and wire reset/delete/section-delete through it.
2. Add the automated approval completion helper.
3. Route merge-queue completion through the shared completed-status updater plus the completion helper.
4. Fix stale reviewer approval recovery to restore `approved_sha` from durable audit state.
5. Add regression tests for delete cleanup, merge completion, stale approval recovery, and remote URL resolution.
6. Update `README.md`.
7. Run targeted tests for the modified areas.

## Edge Cases

| Scenario | Handling |
|---|---|
| Task has no runner row but still owns a pool slot | Cleanup scans `workspace_pool_slots` by `task_id` and releases matching slots anyway. |
| Runner PID is already gone | Cleanup still clears global DB rows and leases; `ESRCH` stays non-fatal. |
| Section contains a mix of idle and active tasks | Force-delete cleanup runs per task before the project-local delete. |
| Task history points at a runner that no longer owns the task | Cleanup only trusts `task_invocations.runner_id` rows still marked `status = 'running'`; completed historical invocations do not justify killing/unregistering an idle runner. |
| Recovered reviewer approval was a no-op submission | Recovery completes directly through the automated completion helper; it does not route through merge queue. |
| Recovered reviewer approval has no durable submission SHA | Recovery fails closed immediately with explicit audit/status, not a null-SHA merge queue handoff. |
| Merge queue completes a local-only task | Completion still goes through the shared completed-status updater and post-approval side effects helper. |
| Section has `partial` tasks | No semantic change in this patch. `partial` remains active for section completion / auto-PR checks by design. |

## Non-Goals

- Redesigning delete command UX beyond fixing the runtime invariant.
- Reworking manual `tasks approve` / hook behavior.
- Changing the documented `partial` semantics for section completion.
- Auditing every non-core commit from the review window for stylistic issues.

## Cross-Provider Review

### Gemini

1. Finding: delete paths strand runner, workstream, and workspace-slot state outside the project DB.
Assessment: valid. This is the primary destructive-command correctness bug.
Decision: adopt.

2. Finding: merge-queue remote selection fix lacks regression coverage.
Assessment: valid. This touches core-engine behavior and currently has no focused test.
Decision: adopt.

3. Finding: reset/delete runtime cleanup is inconsistent and should share one implementation.
Assessment: valid. This matches the repo’s single-source-of-truth rule.
Decision: adopt.

4. Finding: `README.md` is missing the recent CLI additions.
Assessment: valid. This is a direct `AGENTS.md` conformance gap.
Decision: adopt.

### Codex

1. Finding: the current `tasks delete` guard is too narrow because `review` and `merge_pending` can still own runtime state, so checking only `in_progress` is insufficient.
Assessment: valid. The fix must treat runtime-owned states consistently, not just plain coder execution.
Decision: adopt.

2. Finding: sharing the existing reset helper alone is insufficient because it currently revokes leases partially and discovers runners too narrowly.
Assessment: valid. The implementation should replace that partial helper with a stronger shared cleanup path rather than merely reusing it unchanged.
Decision: adopt.

3. Finding: avoid deepening `src/database/queries.ts`, which is already far above the architectural size signal.
Assessment: valid. The implementation will keep query-layer edits minimal and place new runtime/completion logic outside the monolithic query file.
Decision: adopt.

### Verification Phase

#### Gemini

1. Finding: no blocking issues in the final merge-queue/recovery/delete patch.
Assessment: accepted. Gemini verified the final code paths and found the completion, recovery, cleanup, and test changes internally consistent.
Decision: accept.

2. Finding: `cleanupTaskRuntimeState()` uses direct `SIGKILL`, which is aggressive, and `tasks-reset.ts` still has a stray `REFACTOR_MANUAL` comment.
Assessment: non-blocking. The signal comment is pre-existing repo hygiene, and direct `SIGKILL` is acceptable for explicit force-cleanup paths in this patch.
Decision: defer.

#### Codex

1. Finding: `cleanupTaskRuntimeState()` still overreached on runner ownership because it trusted any historical `task_invocations.runner_id`, so deleting/resetting an old task could kill or unregister an idle runner that no longer owned that task.
Assessment: valid. Runtime cleanup must be task-scoped, not “last runner ever seen for this task.”
Decision: adopt.

2. Resolution: tighten candidate runner discovery to `task_invocations.status = 'running'` only, and add a regression test proving completed historical invocations do not remove an unrelated idle runner.
Assessment: implemented and validated locally.
Decision: adopt.

### Local Verification

- `pnpm exec tsc --noEmit`
- `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --modulePathIgnorePatterns=.worktrees/merge-queue --runTestsByPath tests/merge-queue-gate.test.ts tests/merge-queue-completion.test.ts tests/wakeup-sanitise-recovery.test.ts tests/task-runtime-cleanup.test.ts tests/loop-phases-reviewer-intake.test.ts`
