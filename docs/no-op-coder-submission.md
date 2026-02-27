# Design: No-op Coder Submission — Forward to Reviewer

**Status:** Approved for implementation (rev 4 — post fourth review round)
**Files touched:** `src/workspace/git-helpers.ts`, `src/workspace/git-lifecycle.ts`, `src/commands/loop-phases-coder.ts`, `src/orchestrator/reviewer.ts`, `src/commands/loop-phases-reviewer.ts`, `src/prompts/reviewer.ts`, `tests/`

---

## Problem Statement

When a pool-workspace coder correctly identifies that a task's work **already pre-exists** (added by a prior task or commit), it outputs `STATUS: REVIEW` without making any new commits. The post-coder gate returns `No changes detected` and silently retries the coder — forever. We observed 145 consecutive retries (each 3–10 s) before manual intervention.

---

## Current Behavior

```
coder exits → postCoderGate → git log startingSha..HEAD = empty
           → ok: false, reason: 'No changes detected'
           → addAuditEntry([retry]) → return
           → loop picks up in_progress task again → resume coder → repeat
```

No exit: no failure counter incremented, no coordinator threshold hit, no timeout.

---

## Desired Behavior

```
coder exits → postCoderGate → no new commits
           → refresh lease
           → set slot awaiting_review
           → set task review with [NO_OP_SUBMISSION] marker in notes + poolStartingSha as SHA
           → invokeReviewer reads marker BEFORE running LLM, sets isNoOp=true in result
           → reviewer LLM runs: sees [NO_OP_SUBMISSION] rule, verifies pre-existing work
             → APPROVE: approveTask directly, releaseSlot (no merge)
             → REJECT: normal rejection path, coder gets notes on what's missing
```

**Side effect (documented):** True no-work submissions now consume a reviewer invocation and, on rejection, increment `rejection_count`. This replaces the prior behavior of infinite silent retries and is intentional.

---

## Design

### Step 1 — Typed gate result (`src/workspace/git-helpers.ts` + `src/workspace/git-lifecycle.ts`)

**1a — Change `getLogOneline` to return `string | null`** (`src/workspace/git-helpers.ts`):

Currently `getLogOneline` always returns `string` via `|| ''`, making git errors indistinguishable from no-commit output. Change to return `null` on failure:

```typescript
// Before:
export function getLogOneline(cwd: string, range: string): string {
  return execGit(cwd, ['log', range, '--oneline'], { tolerateFailure: true }) || '';
}

// After:
export function getLogOneline(cwd: string, range: string): string | null {
  return execGit(cwd, ['log', range, '--oneline'], { tolerateFailure: true });
}
```

`mergeToBase` at line 292 already uses `if (!log || log.trim().length === 0)` — `!null` is truthy, so no change needed there.

**1b — Add `reasonCode` to `PostCoderResult`** (`src/workspace/git-lifecycle.ts`):

```typescript
export type PostCoderResult =
  | { ok: true; autoCommitted: boolean }
  | { ok: false; reasonCode: 'no_new_commits' | 'git_error'; reason: string };
```

`postCoderGate` distinguishes `git_error` from `no_new_commits` now that `getLogOneline` returns `string | null`:

```typescript
const log = getLogOneline(slotPath, `${startingSha}..HEAD`);
if (log === null) {
  return { ok: false, reasonCode: 'git_error', reason: 'git log failed' };
}
if (log.trim().length === 0) {
  return { ok: false, reasonCode: 'no_new_commits', reason: 'No changes detected' };
}
return { ok: true, autoCommitted };
```

**Implementation note:** The three changes to `git-lifecycle.ts` (1a — `getLogOneline` return type, 1b — `PostCoderResult` type, 1b — `postCoderGate` body) must be applied atomically in the same commit. A partial apply where `getLogOneline` returns `string | null` but `postCoderGate` still uses the old single-path `!log || ...` check would compile and silently treat git errors as no-op submissions.

### Step 2 — Gate handler with lease guard and `[NO_OP_SUBMISSION]` marker (`src/commands/loop-phases-coder.ts`)

When `reasonCode === 'no_new_commits'`, forward to review with an explicit marker. Use `poolStartingSha` as the submission SHA fallback — it is always defined at this point (we are inside the `if (poolSlotContext && poolStartingSha)` block).

**Implementation note:** The snippet below replaces `loop-phases-coder.ts` lines 181–190 in their entirety (the existing single-path `if (!gateResult.ok)` block). It is a replacement, not an augmentation.

```typescript
if (!gateResult.ok) {
  if (gateResult.reasonCode === 'no_new_commits') {
    // Refresh lease before any status mutation (mirrors normal decision path)
    if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
      if (!jsonMode) console.log('\n↺ Lease lost before no-op forward; skipping.');
      return;
    }
    // poolStartingSha is always defined here (we are inside poolSlotContext && poolStartingSha guard)
    updateSlotStatus(poolSlotContext.globalDb, poolSlotContext.slot.id, 'awaiting_review');
    updateTaskStatus(
      db, task.id, 'review', 'orchestrator',
      '[NO_OP_SUBMISSION] No new commits in pool workspace — reviewer to verify pre-existing work',
      poolStartingSha   // always defined; reviewer resolves this SHA from the project repo
    );
    if (!jsonMode) console.log('\n→ No changes detected, forwarding to reviewer.');
    return;
  }
  // All other gate failures: audit + retry (existing behaviour)
  addAuditEntry(db, task.id, task.status, task.status, 'orchestrator', {
    actorType: 'orchestrator',
    notes: `[retry] Post-coder gate: ${gateResult.reason}`,
  });
  return;
}
```

`updateTaskStatus` must be added to the import from `'../database/queries.js'`.

### Step 3 — No-op flag via ReviewerResult (`src/orchestrator/reviewer.ts` + `src/commands/loop-phases-reviewer.ts`)

**Key design decision from Round 3:** do NOT call `getLatestSubmissionNotes` inside the `approve` case in `loop-phases-reviewer.ts`. The reason: STEP 5 in `runReviewerPhase` (line 338) writes an audit entry with `to_status = task.status = 'review'` before the approve case executes. Since `getLatestSubmissionNotes` queries `audit WHERE to_status = 'review' ORDER BY created_at DESC`, that orchestrator decision row — written after the `[NO_OP_SUBMISSION]` submission note — would shadow the original marker, causing `isNoOp = false` when it should be `true`.

**Fix:** Capture `isNoOp` in `ReviewerRunner.runTask()` from the `submissionNotes` already read at line 218 (before the reviewer LLM runs), and propagate it through `ReviewerResult`.

#### 3a — `ReviewerResult` type (in `src/orchestrator/reviewer.ts`)

```typescript
export interface ReviewerResult extends BaseRunnerResult {
  decision?: 'approve' | 'reject' | 'dispute' | 'skip';
  notes?: string;
  provider?: string;
  model?: string;
  isNoOp?: boolean;   // true when submission marker is [NO_OP_SUBMISSION]
}
```

#### 3b — Set `isNoOp` in `ReviewerRunner.runTask()` and `invokeReviewers` (in `src/orchestrator/reviewer.ts`)

`submissionNotes` is already read at line 218. Add `isNoOp` to the single return statement at the end of `runTask()` (covers both the normal path and the session-not-found retry path):

```typescript
return {
  ...baseResult,
  decision,
  notes,
  provider: providerName,
  model: modelName,
  isNoOp: submissionNotes?.startsWith('[NO_OP_SUBMISSION]') ?? false,
};
```

Also add `isNoOp: false` to the synthetic error result in `invokeReviewers` (the `Promise.allSettled` rejection branch), for type completeness. While the error path returns early in `loop-phases-reviewer.ts` before the approve case is reached (making the missing field harmless), explicit `false` keeps the interface self-documenting:

```typescript
// In invokeReviewers, the rejection fallback branch:
return {
  success: false,
  exitCode: 1,
  stdout: '',
  stderr: r.reason?.message || String(r.reason),
  duration: 0,
  timedOut: false,
  provider: reviewerConfigs[i].provider,
  model: reviewerConfigs[i].model,
  isNoOp: false,  // add this
};
```

#### 3c — Use `isNoOp` in approve path (`src/commands/loop-phases-reviewer.ts`)

No new imports needed. `reviewerResult` already carries the flag:

```typescript
case 'approve':
  if (poolSlotContext) {
    postReviewGate(effectiveProjectPath);

    const freshSlot = getSlot(poolSlotContext.globalDb, poolSlotContext.slot.id);
    if (!freshSlot) {
      if (!jsonMode) console.log('\n✗ Pool slot disappeared during review');
      return;
    }

    // No-op submission: coder made no new commits, work pre-existed.
    // isNoOp captured before reviewer ran (from submission notes); safe from audit shadow.
    const isNoOp = reviewerResult?.isNoOp ?? false;

    if (isNoOp) {
      approveTask(db, task.id, 'orchestrator', decision.notes, commitSha);
      releaseSlot(poolSlotContext.globalDb, poolSlotContext.slot.id);
      if (!jsonMode) console.log('\n✓ Task APPROVED (pre-existing work confirmed by reviewer, no merge needed)');
      await checkSectionCompletionAndPR(db, projectPath, task.section_id, phaseConfig);
      return;
    }

    const mergeResult = mergeToBase(poolSlotContext.globalDb, freshSlot, task.id);
    // ... existing merge path unchanged ...
  }
```

For multi-reviewer mode, `reviewerResult = reviewerResults[0]` (line 232). All reviewers read the same task state, so all `isNoOp` values are identical — using index 0 is correct.

### Step 4 — Reviewer prompt (`src/prompts/reviewer.ts`)

Add an explicit rule for `[NO_OP_SUBMISSION]` in the reviewer prompt so the reviewer knows to verify pre-existing work rather than looking for a new diff. The rule must be added to **both** `generateReviewerPrompt` AND `generateResumingReviewerDeltaPrompt`:

```
## No-op Submissions

If the submission notes begin with [NO_OP_SUBMISSION], the coder made no new commits
because it determined the work already existed. Your job is to verify whether the
pre-existing code actually satisfies the task specification fully.

- APPROVE if the existing code satisfies all acceptance criteria
- REJECT with specific missing items if it does not
- Do NOT reject solely because there is no new diff — the absence of a diff is expected
```

### Step 5 — Tests

| Test | Assertion |
|------|-----------|
| `postCoderGate` with no new commits returns `{ ok: false, reasonCode: 'no_new_commits' }` | type |
| `postCoderGate` with getLogOneline returning null returns `{ ok: false, reasonCode: 'git_error' }` | type |
| Gate handler: sets task `review` with `[NO_OP_SUBMISSION]` notes + `poolStartingSha` as SHA, slot `awaiting_review`, lease refreshed | integration |
| `ReviewerRunner.runTask()` with `[NO_OP_SUBMISSION]` submission notes: `ReviewerResult.isNoOp === true` | unit |
| Reviewer approve with `isNoOp = true`: `mergeToBase` NOT called, task approved, slot released, no `failure_count` increment | integration |
| Reviewer reject with `isNoOp = true`: normal rejection path, `mergeToBase` NOT called, task back to coder | integration |
| Reviewer approve with `isNoOp = false` and `starting_sha..HEAD` non-empty: `mergeToBase` IS called (regression) | regression |
| Gate handler with `reasonCode: 'git_error'`: retry path, task stays `in_progress` (no forward to review) | regression |
| `starting_sha` missing from fresh slot + `isNoOp = false`: `mergeToBase` is called, failure handled normally | safety |

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Reviewer rejects no-op submission | Normal rejection path — `rejection_count` incremented, task back to `in_progress` (coder gets concrete notes). Pool slot released by the runner's `finally` block in `orchestrator-loop.ts` (same behavior as normal rejection; pre-existing). |
| Lease lost before no-op forward | `refreshParallelWorkstreamLease` returns false → return without status change; next wakeup picks up |
| `commitSha` unresolvable in reviewer for no-op | `resolveSubmissionCommitWithRecovery` uses `poolStartingSha` (written to audit by gate). This SHA is always locally reachable in the pool slot clone (it was HEAD at `prepareForTask` time) — no fetch required. |
| `git_error` gate failure | Existing retry path unchanged; no infinite loop fix for this case (pre-existing, out of scope) |
| `starting_sha` null in fresh slot (metadata corruption) | `isNoOp = false`; normal `mergeToBase` call proceeds, which will fail and invoke `handleMergeFailure` as before — correct |
| `wakeup-sanitise` stale reviewer invocation for no-op task | Sanitise approve-recovery calls `approveTask` directly, bypassing `mergeToBase` (correct for no-op). It does NOT call `releaseSlot` — same as for all recovery paths (pre-existing behavior). The slot is reclaimed by the normal wakeup reconciliation on next cycle. |
| No-op reviewer diff is empty | For no-op submissions, the reviewer's diff view shows nothing new (no commits since `poolStartingSha`). The `[NO_OP_SUBMISSION]` prompt rule directs the reviewer to inspect pre-existing files, not a diff. Agentic providers (Codex/Claude) can read files on demand — this is the expected reviewer type. |
| Multi-reviewer mode with no-op submission | `reviewerResult = reviewerResults[0]`; all reviewers see same task state; `isNoOp` from index 0 is correct. If any reviewer fails, the error handler returns early before the approve case — `isNoOp: false` on the synthetic error result is never accessed. |
| Audit timestamp nondeterminism (same-second writes) | Moot — `isNoOp` is computed from `submissionNotes` captured before the reviewer runs, not from a DB query in the approve path |

---

## Non-Goals

- Fixing infinite loops for `git_error` gate failures (pre-existing, separate issue)
- Pre-flight task assignment checks (detecting stale tasks before assignment)
- Changing reviewer prompt logic for normal (non-no-op) submissions

---

## Cross-Provider Review

### Round 1 — Codex (adversarial), 2026-02-27

| Finding | Severity | Assessment | Decision |
|---------|----------|------------|----------|
| Approve path fails for zero-commit tasks via `mergeToBase` (git-lifecycle.ts:291) | Critical | Correct — `mergeToBase` hard-rejects empty log | **Adopt** — Step 3 adds no-op approve path |
| String-matching on `'No changes detected'` is brittle | High | Correct — free-text is a refactor trap | **Adopt** — Step 1 adds typed `reasonCode` |
| Missing lease refresh before new `updateTaskStatus` | High | Correct — normal path always guards with lease refresh | **Adopt** — Step 2 adds the guard |
| Non-no-op gate failures bypass global retry cap | Medium | Valid but pre-existing, not introduced by this change | **Defer** |
| Lazy coder abuse risk | Medium | Reviewer is a reasonable gate; `[NO_OP_SUBMISSION]` marker gives reviewer context | **Accept** |

### Round 2 — Codex (adversarial), 2026-02-27

| Finding | Severity | Assessment | Decision |
|---------|----------|------------|----------|
| Step 3 snippet not compile-correct: `getLogOneline` not imported/exported in reviewer | Critical | Correct — `getLogOneline` is internal to git-lifecycle.ts | **Adopt** — replaced git re-check with `[NO_OP_SUBMISSION]` marker |
| `starting_sha..HEAD` check in reviewer can falsely approve if HEAD moved off task_branch | Critical | Correct — git state at review time is not reliable | **Adopt** — same fix: marker-based detection |
| `!freshSlot.starting_sha` guard treats metadata corruption as no-op | High | Correct — null `starting_sha` is a failure, not a success | **Adopt** — guard removed; `mergeToBase` handles failure path |
| `getCurrentCommitSha` null → reviewer resolves wrong commit | High | Correct — use `poolStartingSha` (always defined in this scope) | **Adopt** — Step 2 now uses `poolStartingSha` |
| `[no_op]` note is free-text and ambiguous in reviewer prompt | Medium | Correct — formal marker contract is more deterministic | **Adopt** — `[NO_OP_SUBMISSION]` prefix + explicit prompt rule (Step 4) |
| Missing test cases for HEAD-off-branch, null starting_sha, unresolvable SHA | Medium | Valid | **Adopt** — test table expanded in Step 5 |
| Non-goals incomplete: behavior change from retry to review cycle should be documented | Medium | Valid | **Adopt** — documented as Side Effect above |

### Round 3 — Codex (adversarial), 2026-02-27

| Finding | Severity | Assessment | Decision |
|---------|----------|------------|----------|
| `getLatestSubmissionNotes` in approve path reads wrong audit row: STEP 5 writes `to_status='review'` decision entry BEFORE approve case runs, shadowing the `[NO_OP_SUBMISSION]` submission note | Critical | Correct — confirmed by reading queries.ts (query: `WHERE to_status='review' ORDER BY created_at DESC`) and loop-phases-reviewer.ts line 338 | **Adopt** — Step 3 redesigned: `isNoOp` captured in `ReviewerRunner.runTask()` before LLM runs, propagated via `ReviewerResult.isNoOp` |
| `getLatestSubmissionNotes` timestamp nondeterminism for same-second audit writes | High | Valid — same root cause as above | **Adopt** — moot after architectural fix (no DB query at approve time) |
| Doc incorrectly claims `getLatestSubmissionNotes` is already imported in `loop-phases-reviewer.ts` | High | Correct — confirmed by reading file imports (lines 1–57) | **Adopt** — Step 3 redesigned to avoid this import entirely |
| `git_error` reasonCode unreachable: `getLogOneline` returns `''` on failure, same as no-commit | Medium | Correct — `null` vs `''` distinction enables clean separation | **Adopt** — Step 1 updated to explicitly check `log === null` for git_error vs empty string for no_new_commits |
| Prompt rule must be added to both `generateReviewerPrompt` AND `generateResumingReviewerDeltaPrompt` | Medium | Correct | **Adopt** — Step 4 explicitly covers both variants |

### Round 4 — Codex + Claude (adversarial), 2026-02-27

| Finding | Severity | Assessment | Decision |
|---------|----------|------------|----------|
| `postCoderGate` body change and type changes must be applied atomically; partial apply silently treats git errors as no-op submissions | Critical | Correct — but this is an implementation concern, not a design flaw; the doc now has an explicit atomicity note | **Adopt** — atomicity note added to Step 1b |
| Step 2 snippet REPLACES lines 181–190 of `loop-phases-coder.ts`, not augments — doc didn't say so | Critical | Correct — implementer could double-patch without this note | **Adopt** — "replaces lines 181–190 in their entirety" added to Step 2 |
| `isNoOp` missing from synthetic error result in `invokeReviewers` rejection fallback | High | Valid — harmless since error path returns early before approve case, but makes interface incomplete | **Adopt** — `isNoOp: false` added to synthetic error result in Step 3b |
| Wakeup-sanitise edge case claim "no new interaction" is inaccurate: sanitiser doesn't call `releaseSlot` | High | Correct — pre-existing behavior; doc wording was misleading | **Adopt** — edge case row corrected with accurate description |
| Reject path leaves slot `review_active`; not documented | High | Correct — pre-existing behavior; slot released by runner `finally` block | **Adopt** — edge case row updated with explicit slot release note |
| No-op reviewer sees empty diff; reviewer must inspect files directly | Medium | Valid — agentic providers (Codex/Claude) can read files; no change to design, but edge case documented | **Accept** — edge case added to table; no design change needed |
| Doc says "back to pending" but `rejectTask` sets task to `in_progress` | Low | Correct — wording error | **Adopt** — edge case corrected to `in_progress` |
