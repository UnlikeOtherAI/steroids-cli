# Reviewer Approval Outcome Unification

## 1. Problem Statement

The 2026-03-25 fixes closed concrete bugs in reviewer approval recovery, but they did not fully satisfy `AGENTS.md`'s `Root-Cause First` and `Simplification First` rules. The approval invariant is still split across multiple paths:

- Live reviewer approval in `src/commands/loop-phases-reviewer.ts:345-402`
- Reviewer prompt/no-op setup in `src/orchestrator/reviewer.ts:200-218` and `src/orchestrator/reviewer.ts:356-363`
- Stale reviewer recovery in `src/runners/wakeup-sanitise-recovery.ts:133-227`

Those paths still answer the same questions separately:

1. What is the latest active submission for this task?
2. Is that submission a no-op approval or a merge-queue approval?
3. Which SHA is actually approval-safe, not just audit-trusted?
4. How do we apply the approved outcome?

The split is not harmless duplication. It already produced one real recovery bug, and it still leaves two structural gaps:

- `getLatestSubmissionNotes()` in `src/database/queries.ts:1209-1224` is not scoped to the latest active lifecycle and only orders by `created_at`, while the stronger submission-chain logic already scopes to the latest attempt and breaks ties with `id` in `getSubmissionCommitShas()` (`src/database/queries.ts:1254-1277`).
- The direct-approval path and the recovered-approval path still encode completion vs. merge-queue transitions separately, so future fixes can drift again.
- Direct completion still updates task status before one-shot approval side effects, but those side effects are not durably queued or retried. A crash between `completed` and `runAutomatedApprovalEffects()` can strand intake/section follow-up or replay it unsafely.

Worst-case consequence if this invariant drifts again: a reviewer approval can mark a task `completed` or `merge_pending` from the wrong submission record, wrongly close a section, fire intake approval effects from stale state, or queue the merge queue against a SHA that preflight itself would reject.

## 2. Current Behavior

### Submission durability and preflight are already stronger than approval application

`submitForReviewWithDurableRef()` in `src/commands/submission-transition.ts:11-88` writes a durable ref plus metadata (`submission_sequence`, `durable_ref`, `durable_ref_sha`) on each `review` transition.

`runReviewerSubmissionPreflight()` in `src/commands/reviewer-preflight.ts:17-109` already uses the stronger model:

- `getSubmissionCommitShas()` scopes commit history to the latest active lifecycle.
- The latest review audit row is read with `ORDER BY created_at DESC, id DESC`.
- The durable ref is only trusted when it matches both the latest audit row and the active submission head.

That is already the correct trust model. The problem is that approval application does not share it.

### Reviewer prompt/no-op setup still reads a weaker source

`ReviewerRunner.runTask()` in `src/orchestrator/reviewer.ts:200-218` still reads submission notes via `getLatestSubmissionNotes()`, not via the scoped submission chain. It then derives `isNoOp` from that note in `src/orchestrator/reviewer.ts:356-363`.

Today that usually works, but it is a weaker source than the active submission chain used by preflight. It also keeps reviewer prompt composition and approval recovery on different definitions of "latest submission".

### Live approval applies outcomes inline

`runReviewerPhase()` in `src/commands/loop-phases-reviewer.ts:345-402` applies approval inline:

- No-op approval calls `approveTask()` and `runAutomatedApprovalEffects()`.
- Merge approval writes `merge_pending`, updates `merge_phase` / `approved_sha`, and appends a queue audit row.
- The merge path optionally prefers the remote task-branch head over the submission SHA.

This path is correct in spirit, but it is its own implementation of the approval outcome invariant.

### Recovery reconstructs the same invariant separately

`resolveRecoveredApprovalState()` in `src/runners/wakeup-sanitise-recovery.ts:133-156` separately decides:

- latest scoped submission SHA via `getSubmissionCommitShas()[0]`
- durable ref trust via `readDurableSubmissionRef()`
- no-op detection via `getLatestSubmissionNotes()`

`recoverOrphanedInvocation()` in `src/runners/wakeup-sanitise-recovery.ts:183-227` then separately applies:

- direct completion plus `runAutomatedApprovalEffects()`
- or `merge_pending` plus `merge_phase` / `approved_sha`
- or `blocked_error` if no trusted SHA is available

This is the exact duplication that made the previous fix feel patchy.

## 3. Desired Behavior

The system should have one deterministic source of truth for reviewer-approved submission context and one shared implementation for applying approved outcomes.

Specifically:

- "Latest active submission" must mean the same thing in reviewer prompt setup, reviewer preflight, stale recovery, and any coordinator context that references submission notes.
- No-op vs. merge-queue classification must come from that same submission context, not from ad hoc audit queries.
- "Approval-safe SHA" must also mean one thing. If preflight would reject a submission because the latest commit is missing or only an older submission is reachable, recovery must reject it too.
- Direct completion vs. merge-queue transition must be applied by one shared helper, not open-coded in multiple files.
- `approved_sha` must keep the one shared approval-safe meaning. The live reviewer path must not replace it with a different remote-head SHA after the safety gate has run.
- Direct-completion side effects must become durable at-least-once with idempotent replay. A task must never be left permanently `completed` while intake/section side effects are silently skipped.
- Recovery must fail closed when no approval-safe SHA exists; it must never infer approval from an untrusted ref, an out-of-scope note, or a stale older submission.

## 4. Design

### 4.1 Add one shared submission-context module

Create `src/orchestrator/submission-context.ts`.

Responsibility: "Read the latest active review submission for a task and resolve the raw submission context."

This module should replace reviewer-facing uses of `getLatestSubmissionNotes()` with a scoped reader that uses the same attempt boundary as `getSubmissionCommitShas()`.

Proposed shape:

```ts
export interface SubmissionContext {
  latestReviewAuditId: number | null;
  latestReviewNotes: string | null;
  latestReviewCommitSha: string | null;
  approvalCandidateShas: string[]; // newest -> oldest, latest active lifecycle only
  latestExpectedSha: string | null;
  isNoOp: boolean;
  durableRefTrusted: boolean;
}

export function loadSubmissionContext(
  db: Database.Database,
  projectPath: string,
  taskId: string,
): SubmissionContext;
```

Rules:

- Scope the latest review audit row to the latest active lifecycle using the same `pending -> in_progress` boundary as `getSubmissionCommitShas()`.
- Order latest-row reads by `created_at DESC, id DESC`.
- Reuse the same durable-ref trust rule already present in `runReviewerSubmissionPreflight()`: durable ref only wins when it matches both the latest active audit record and the active submission head.
- Derive `isNoOp` from the scoped latest review notes, not from an unscoped audit query.
- Build `approvalCandidateShas` with the same durable-ref precedence preflight already uses today: when the durable ref is trusted, put it first and de-duplicate it from the remaining active submission history.
- Set `latestExpectedSha` to the newest approval candidate. This is the SHA that must remain reachable for approval to be considered safe.

This is the simplification step. It replaces one weak helper with one context object that all approval code can share.

### 4.2 Add one shared approval-safety resolver

`SubmissionContext` is only the raw, lifecycle-scoped audit/durable-ref view. Approval application must also share the same git-reachability gate that preflight enforces today.

Create a shared resolver alongside `SubmissionContext`:

```ts
export type ApprovalSafetyResult =
  | { ok: true; approvalSha: string }
  | {
      ok: false;
      reason:
        | 'missing_latest_submission'
        | 'all_submissions_unreachable'
        | 'latest_missing_with_older_reachable';
      attempts: string[];
    };

export function resolveApprovalSafety(
  projectPath: string,
  submissionContext: SubmissionContext,
): ApprovalSafetyResult;
```

Rules:

- Run `resolveSubmissionCommitWithRecovery()` against `submissionContext.approvalCandidateShas`.
- `ok: true` only when the resolved SHA is exactly `submissionContext.latestExpectedSha`.
- If only an older submission is reachable, return `latest_missing_with_older_reachable`; do not silently fall back.
- If no candidate is reachable, return `all_submissions_unreachable`.

That makes "approval-safe SHA" a first-class shared invariant instead of a preflight-only detail.

### 4.3 Make reviewer preflight and recovery consume the same approval-safety result

`runReviewerSubmissionPreflight()` should stop reimplementing both "latest active submission + durable ref trust" and git-reachability gating locally. It should load `SubmissionContext`, then call `resolveApprovalSafety()`.

That keeps one source of truth for:

- latest active lifecycle boundary
- durable ref trust
- no-op notes
- deterministic latest-row ordering
- approval-safe SHA versus stale older fallback

Preflight keeps its current responsibility of deciding whether the submission chain is healthy enough to proceed.

Sketch:

```ts
const submissionContext = loadSubmissionContext(db, effectiveProjectPath, task.id);
const approvalSafety = resolveApprovalSafety(effectiveProjectPath, submissionContext);
```

Also extract preflight's unhealthy-submission transition logic into a shared helper:

```ts
export function handleUnsafeApprovalSubmission(
  db: Database.Database,
  task: Task,
  failure: Extract<ApprovalSafetyResult, { ok: false }>,
  options: { jsonMode: boolean },
): { ok: false };
```

Recovery should use the same helper instead of inventing a separate `blocked_error` path. That preserves current `commit_recovery` semantics and avoids making a transient recovery miss look section-terminal.

### 4.4 Make reviewer prompt setup consume the same context

`ReviewerRunner.runTask()` should use `loadSubmissionContext()` instead of `getLatestSubmissionNotes()`.

That gives the prompt and the returned `ReviewerResult.isNoOp` the same definition of latest submission that preflight and recovery use.

Sketch:

```ts
const submissionContext = loadSubmissionContext(db, projectPath, task.id);
submissionNotes = submissionContext.latestReviewNotes;

return {
  ...baseResult,
  decision,
  notes,
  provider,
  model,
  isNoOp: submissionContext.isNoOp,
};
```

`src/commands/loop-phases-coder-decision.ts:98` should also move to `loadSubmissionContext().latestReviewNotes` so coordinator escalations talk about the same active submission, not a stale one.

### 4.5 Add one shared approval-outcome module

Create `src/orchestrator/reviewer-approval-outcome.ts`.

Responsibility: "Turn a trusted reviewer approval into either direct completion or merge-queue entry."

Proposed shape:

```ts
export type ApprovedOutcome =
  | { kind: 'complete'; commitSha: string }
  | { kind: 'queue_merge'; approvedSha: string }
  | { kind: 'unsafe_submission' };

export function deriveApprovedOutcome(
  submissionContext: SubmissionContext,
  approvalSafety: Extract<ApprovalSafetyResult, { ok: true }>,
): ApprovedOutcome;

export async function applyApprovedOutcome(
  db: Database.Database,
  task: Pick<Task, 'id' | 'title' | 'source_file' | 'section_id'>,
  outcome: Exclude<ApprovedOutcome, { kind: 'unsafe_submission' }>,
  options: {
    actor: string;
    notes: string;
    config: SteroidsConfig;
    projectPath: string;
    intakeProjectPath?: string;
  },
): Promise<void>;
```

Rules:

- `isNoOp && approvalSafety.ok` => `complete`
- `!isNoOp && approvalSafety.ok` => `queue_merge`
- any `ApprovalSafetyResult.ok === false` => `unsafe_submission`

`applyApprovedOutcome()` owns the duplicated mutations currently split across `loop-phases-reviewer.ts` and `wakeup-sanitise-recovery.ts`:

- direct completion via `approveTask(..., commitSha)` and `runAutomatedApprovalEffects()`
- merge-queue entry via `updateTaskStatus(..., 'merge_pending', ...)`, `merge_phase = 'queued'`, `approved_sha = ?`, plus the queue audit entry
- queue-time persistence of immutable approval replay input for merge-approved tasks, so merge completion can later finish approval effects without re-reading mutable workspace files

The existing `src/orchestrator/automated-approval-effects.ts` helper remains the shared side-effect hook for direct completion, but it needs one more durability layer described below.

### 4.6 Remove the live-path SHA override

The current live reviewer path in `src/commands/loop-phases-reviewer.ts:366-382` can replace the reviewed submission SHA with the current remote task-branch head. That is exactly the kind of second meaning this refactor is meant to remove.

The revised rule should be:

- derive `approved_sha` from `ApprovalSafetyResult` only
- do not replace it in the live reviewer path
- let the merge queue remain the only place that compares `approved_sha` with the fetched remote branch head and bounces the task back to review on mismatch

That preserves one meaning for `approved_sha`: the reviewer-approved, approval-safe submission SHA. Remote-branch drift remains detectable later without mutating the meaning of the field at approval time.

### 4.7 Make direct-completion effects durable and replayable

Centralizing the call site is not enough. Today a task can become `completed` before intake/section effects are durably recorded. The refactor should tighten that too.

Extend `src/orchestrator/automated-approval-effects.ts` so it owns a durable pending/applied marker in `audit` for post-approval effects:

```ts
export interface ApprovalEffectsReplayInput {
  version: 1;
  intakeTransition?: SerializedIntakeTransition;
}

export function markApprovalEffectsPending(
  db: Database.Database,
  taskId: string,
  actor: string,
  replayInput: ApprovalEffectsReplayInput,
): void;

export async function runPendingApprovalEffects(
  db: Database.Database,
  task: AutomatedApprovalTask,
  options: AutomatedApprovalEffectOptions,
  replayInput: ApprovalEffectsReplayInput,
): Promise<void>;
```

Rules:

- Direct completion paths write `completed` and an `approval_effects_pending` audit marker in the same transaction.
- Merge-approved tasks must persist their immutable `ApprovalEffectsReplayInput` before they enter `merge_pending` so the later `merge_pending -> completed` path can create the same pending marker without consulting the old workspace again.
- The pending marker must persist immutable replay input for any effect that currently depends on workspace-local files. For intake tasks that means serializing the already-parsed intake transition, or equivalent immutable input, at approval time instead of re-reading `intake-result.json` during replay.
- `ApprovalEffectsReplayInput` must be versioned. Replay logic must reject unknown versions with a specific monitored error rather than silently skipping or guessing.
- `runPendingApprovalEffects()` is retriable and records `approval_effects_applied` only after success.
- `handleIntakeTaskApproval()` must become idempotent before this is safe. Re-running it for the same task must not create duplicate successor tasks if the report already advanced or resolved on an earlier attempt, and replay must consume the persisted transition input instead of re-reading mutable workspace state.
- The idempotency contract must be explicit:
  - intake replay first reads the current intake report by `(source, externalId)`
  - if the report is already resolved, or already linked to a successor task matching the persisted target phase/decision, replay is a no-op
  - if the report still links to the currently completed task, replay may create exactly one successor task and then atomically move `linked_task_id`
  - hooks and other completion effects must likewise use per-task effect markers so retries do not re-fire already-applied effects
- A startup/wakeup reconciliation pass should scan for completed tasks with pending-but-not-applied approval-effect markers and replay them.
- The deployment plan must also handle legacy completed tasks created before `approval_effects_pending` existed. On first startup after rollout, scan recent approval-completed tasks lacking both pending/applied markers. For non-intake tasks, backfill a pending marker and replay safely. For intake tasks, only backfill when immutable replay input can be reconstructed deterministically; otherwise emit a dedicated migration anomaly instead of silently assuming success.

Concrete handoff rule for merge-approved tasks:

- when `applyApprovedOutcome(..., queue_merge)` runs, serialize `ApprovalEffectsReplayInput` into the `merge_pending` transition metadata (or an equivalent task-bound durable field)
- when `completeMergePendingTask()` later marks the task `completed`, it must read that stored replay input, write `approval_effects_pending`, and then run/replay effects from the stored input
- the replay design is not complete until this `review -> merge_pending -> completed` handoff is explicit

This is durable at-least-once delivery with idempotent replay, not distributed exactly-once. That is the right claim for this system.

### 4.8 Unify section-completion semantics before replay relies on them

Approval effects call `checkSectionCompletionAndPR()`, and manual task approval still runs its own section-done check in `src/commands/tasks.ts:1096-1143`. Today those checks do not match the status-set commentary in `src/database/queries.ts:38-50`.

Before durable replay is enabled, extract one shared helper for section completion, for example:

```ts
export interface SectionCompletionState {
  done: boolean;
  completedCount: number;
  activeCount: number;
}

export function getSectionCompletionState(
  tasks: Array<Pick<Task, 'status'>>,
): SectionCompletionState;
```

Rules:

- Choose one terminal/active status set for the question "is this section done?"
- Use that helper from `src/git/section-pr.ts` and `src/commands/tasks.ts`
- Align the chosen set with the documented single source of truth, or update that source of truth in the same change if the current documentation is wrong

This keeps approval-effect replay from cementing another split invariant while touching section-completion logic.

### 4.9 Bring manual approval onto the same completion contract

`steroids tasks approve` in `src/commands/tasks.ts:1186-1245` is a supported approval entry point. It cannot stay outside the shared approval-effects runner if this design claims approval-outcome unification.

The revised rule should be:

- manual approval stops calling `approveTask()` as a one-off bypass
- it instead uses the same shared "complete approved task" helper as reviewer no-op completion and merge-queue completion
- if the task is an intake task, manual approval captures immutable replay input from the current project path before completion and then routes through the same durable pending/applied flow
- manual approval also stops owning a private copy of completion side effects from `src/commands/tasks.ts` such as `triggerTaskCompleted`, section-completion hooks, and project-completion checks; those must move behind the shared completion-effects contract too
- if the team wants a reduced-semantics manual bypass, that must be documented explicitly as a non-default expert-only path, not left as the main `tasks approve` behavior

### 4.10 Make sanitise recovery consume the same outcome and unsafe-submission helpers

`recoverOrphanedInvocation()` should stop calling `resolveRecoveredApprovalState()` entirely.

Instead:

1. load `SubmissionContext`
2. resolve `ApprovalSafetyResult`
3. if unsafe, route through `handleUnsafeApprovalSubmission()`
4. otherwise derive `ApprovedOutcome`
5. apply it through `applyApprovedOutcome()`

That deletes the patchy local reconstruction logic and makes recovery a thin orchestrator around shared primitives.

### 4.11 Retire the weak helper from reviewer-facing paths

After the above, `getLatestSubmissionNotes()` should no longer be used by:

- `src/orchestrator/reviewer.ts`
- `src/runners/wakeup-sanitise-recovery.ts`
- `src/commands/loop-phases-coder-decision.ts`

It can either be deleted if unused or explicitly documented as a legacy/raw audit helper that is not valid for approval semantics. The preferred outcome is deletion.

## 5. Implementation Order

1. Add `src/orchestrator/submission-context.ts` and move the latest-active-submission query plus durable-ref trust rule into it.
2. In the same phase, add `resolveApprovalSafety()` plus `handleUnsafeApprovalSubmission()`, then convert `src/commands/reviewer-preflight.ts`, `src/orchestrator/reviewer.ts`, `src/commands/loop-phases-reviewer.ts`, and `src/runners/wakeup-sanitise-recovery.ts` together so approval classification and approval safety cannot drift in an intermediate commit.
3. Convert `src/commands/loop-phases-coder-decision.ts` to read scoped latest review notes from `SubmissionContext`.
4. Add `src/orchestrator/reviewer-approval-outcome.ts` and move the direct-complete / merge-pending mutations into it if that did not already happen in step 2.
5. Extend `src/orchestrator/automated-approval-effects.ts` with pending/applied markers, persist immutable intake replay input at approval time, and make `src/intake/reviewer-approval.ts` consume persisted transition data idempotently.
6. Extract one shared section-completion predicate and route `src/git/section-pr.ts` plus `src/commands/tasks.ts` through it before durable replay depends on those semantics.
7. Route direct reviewer completion, `src/orchestrator/merge-queue-completion.ts`, and `src/commands/tasks.ts` manual approval through the same durable completion-effects path, including approval replay, task-completed hooks, section-completed hooks/PR checks, and project-completion checks.
8. Add wakeup/startup reconciliation for pending approval effects on already-completed tasks plus a one-time legacy backfill path for approval-completed tasks created before the new markers existed.
9. Remove `getLatestSubmissionNotes()` if no callers remain and delete `resolveRecoveredApprovalState()` when recovery has been moved fully to shared helpers.
10. Add targeted regression tests before cleanup, including replay-input version handling, intake idempotency, and legacy-marker backfill.

## 6. Edge Cases

| Scenario | Handling |
|----------|----------|
| Two review submissions land in the same second | Latest-row reads use `ORDER BY created_at DESC, id DESC`; tie handling is deterministic. |
| Task was reset and an older lifecycle contains `[NO_OP_SUBMISSION]` | `SubmissionContext` scopes to the latest active lifecycle only; old notes cannot classify the current attempt. |
| Durable ref exists but points at a stale SHA | `durableRefTrusted = false`; fall back to the active submission chain and never complete/queue from the stale ref. |
| Latest submission is missing but an older submission is still reachable | `resolveApprovalSafety()` returns `latest_missing_with_older_reachable`; both preflight and recovery route through the shared `commit_recovery` path instead of silently approving the older SHA. |
| Reviewer approval is recovered but no approval-safe SHA exists | Recovery uses the same unsafe-submission helper as preflight; it does not invent a separate `blocked_error` terminal path. |
| Task branch advances after reviewer approval | `approved_sha` stays on the shared approval-safe SHA; the merge queue detects branch drift later instead of rewriting the meaning of the field during approval. |
| Process dies after task becomes `completed` but before intake/section effects finish | The task still has `approval_effects_pending`, so wakeup/startup reconciliation can replay idempotent effects later. |
| Process dies after merge-queue completion but before intake replay | Replay uses immutable input captured before `merge_pending` and handed forward into the completion marker, not whatever `intake-result.json` happens to contain later. |
| A completed task predates the new pending/applied markers | Startup migration scans for legacy approval-completed tasks and backfills replay safely when deterministic, otherwise records a migration anomaly instead of silently dropping effects. |
| No-op submission reaches approval with an approval-safe SHA | Outcome is direct completion, then durable approval effects are attempted immediately and retried until applied. |
| Merge-required submission reaches approval with an approval-safe SHA | Outcome is `merge_pending`, `merge_phase='queued'`, and the merge queue remains the only component that performs the actual merge. |
| A user runs `steroids tasks approve` on an intake task | Manual approval uses the same durable completion helper, replay-input capture path, and completion hooks/checks as automated approval, so observable completion semantics do not drift. |
| Approval replay re-checks whether a section is done | The replay path uses the shared section-completion helper, so manual approval, auto-PR creation, and approval replay answer the same question. |
| Coordinator escalation needs submission notes after several retries | It reads `SubmissionContext.latestReviewNotes`, so it references the same active submission seen by reviewer and recovery flows. |

## 7. Non-Goals

- Changing the `[NO_OP_SUBMISSION]` marker format or reviewer prompt policy
- Reworking merge-queue mechanics beyond routing its completion path through the same durable approval-effects runner
- Moving broad query logic out of `src/database/queries.ts` beyond the submission-context and approval-outcome responsibilities needed here
- Adding recovery commands or manual operator workflows; the goal is to remove drift, not add new escape hatches

## 8. Cross-Provider Review

### Round 1

| Source | Finding | Decision |
|--------|---------|----------|
| Codex | The first draft still separated audit-trusted SHA from approval-safe SHA; recovery could still approve a SHA that preflight would reject. | Adopt. Added `resolveApprovalSafety()` and shared unsafe-submission handling so preflight and recovery use the same gate. |
| Codex | The first draft overclaimed direct-completion effects as exactly-once even though `completed` can still race ahead of intake/section side effects. | Adopt. Replaced that with a durable pending/applied approval-effects plan plus idempotent replay requirements. |
| Codex | Using `blocked_error` for recovered approval misses is not workflow-safe because it is section-terminal. | Adopt. Replaced the fallback with the shared `commit_recovery` path. |
| Codex | The first implementation order allowed an intermediate commit where reader paths were unified but live/recovery writers still used old logic. | Adopt. Reordered the implementation so preflight, reviewer, live approval, and recovery move together. |
| Gemini | No high or medium issues in the original direction; the shared submission context and narrow live-path override were directionally sound. | Keep. The revised design preserves that direction while tightening the unsafe-SHA and side-effect durability gaps. |
| Claude | Review blocked: `claude -p` returned `401 authentication_error` even though `claude auth status` reported a local login. | Document. Retry after provider auth is repaired; do not treat missing Claude output as a successful review. |

### Round 2

| Source | Finding | Decision |
|--------|---------|----------|
| Codex | Allowing a live-path remote-head override still created a second meaning for `approved_sha`. | Adopt. Removed the override from the design; `approved_sha` stays on the shared approval-safe SHA and branch drift is detected later by the merge queue. |
| Codex | Durable replay needs immutable intake replay input, not just a task-id marker. | Adopt. Added persisted replay metadata for intake effects so replay does not re-read mutable workspace files. |
| Codex | Section completion is still a split invariant between `section-pr.ts`, `tasks.ts`, and the documented status sets. | Adopt. Added a shared section-completion helper to the design before replay relies on section-done answers. |
| Gemini | No issues above low priority remained after the second revision. | Keep. Remaining Gemini comments were implementation-order/document clarity nits only. |
| Claude | Retry still blocked with `401 authentication_error` from `claude -p`. | Document. Claude review remains environment-blocked, not completed. |

### Round 3

| Source | Finding | Decision |
|--------|---------|----------|
| Codex | Merge-path replay still lacked an explicit handoff for immutable intake replay input across `review -> merge_pending -> completed`. | Adopt. Added queue-time replay-input persistence and explicit merge-completion handoff requirements. |
| Codex | `steroids tasks approve` was still outside the shared approval-effects contract. | Adopt. Brought manual approval onto the same durable completion helper in the design. |
| Gemini | No issues above low priority remained in the latest reviewed revision. | Keep. Latest Gemini pass stayed at low-only comments. |
| Claude | Still blocked by `401 authentication_error`; no completed review available. | Document. Remains an environment blocker. |

### Round 4

| Source | Finding | Decision |
|--------|---------|----------|
| Gemini | Legacy completed tasks created before the new markers would otherwise bypass replay reconciliation. | Adopt. Added an explicit legacy-marker backfill / migration-anomaly strategy. |
| Gemini | Replay input needed versioning and a stricter idempotency contract for intake/hook effects. | Adopt. Added `ApprovalEffectsReplayInput.version`, explicit replay version handling, and a concrete report-based idempotency contract. |

### Round 5

| Source | Finding | Decision |
|--------|---------|----------|
| Gemini | No issues above low priority in the implemented diff after local typecheck and the targeted Jest verification slice. | Keep. Verification pass clean. |
| Codex | The verification pass did not surface a concrete medium/high finding while tracing the implemented diff, but the CLI remained in extended read mode and did not emit a short final verdict before stalling. | Document. No actionable finding was produced; keep the local validation plus Gemini verdict as the decisive verification evidence for this implementation. |
| Claude | Retry still blocked with `401 authentication_error` from `claude -p`. | Document. Environment blocker remains unresolved. |
