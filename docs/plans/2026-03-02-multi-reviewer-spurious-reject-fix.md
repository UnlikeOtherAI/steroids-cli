# Multi-Reviewer Spurious Reject Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the bug where all-approve multi-reviewer consensus is incorrectly converted to REJECT by a misrouted orchestrator call.

**Architecture:** One conditional restructure in `loop-phases-reviewer-resolution.ts`: when `needsMerge` is false, skip the orchestrator entirely and build the decision directly from `finalDecision`. The multi-reviewer orchestrator is ONLY for merging conflicting reject notes.

**Tech Stack:** TypeScript, Node.js

---

## Problem Statement

When two configured reviewers both output `DECISION: APPROVE`, `resolveDecision()` returns `{ decision: 'approve', needsMerge: false }`. The code then enters an `else` branch labelled "No merge needed" but still calls `invokeMultiReviewerOrchestrator`. That orchestrator prompt (`buildMultiReviewerOrchestratorPrompt`) unconditionally instructs the LLM: *"The DECISION is already REJECT. Your job is to MERGE THE NOTES."* It also hardcodes `DECISION: REJECT` in its required-output template. The LLM sees APPROVE inputs but follows the REJECT template, producing output like:

```
DECISION: REJECT
NOTES:
## Merged Review Findings
Both reviewers approved this submission. There are no blocking issues to report.
CONFIDENCE: HIGH
```

`SignalParser` reads `DECISION: REJECT` and sends the task back to the coder. **Every single multi-reviewer approve cycle causes one spurious rejection.**

Confirmed in production: docgen project task `11449dcb` had 5/6 rejections caused by this bug.

## Current Behavior

File: `src/commands/loop-phases-reviewer-resolution.ts`

```typescript
if (needsMerge) {
  // Invoke multi-reviewer orchestrator to merge notes (correct path)
  const orchestratorOutput = await invokeMultiReviewerOrchestrator(...);
  decision = handler.parseReviewerOutput(orchestratorOutput);
} else {
  // BUG: orchestrator is still called even when needsMerge = false
  try {
    const orchestratorOutput = await invokeMultiReviewerOrchestrator(...);  // ← wrong
    decision = handler.parseReviewerOutput(orchestratorOutput);
  } catch (error) {
    // Fallback (only reached on throw): correctly builds decision from finalDecision
    if (isUnanimousConsensus) {
      decision = { decision: finalDecision, ... };  // ← correct logic, wrong place
    }
  }
}
```

The catch-block fallback already contains the correct logic — it just never runs on the happy path.

## Desired Behavior

When `needsMerge = false`, bypass the orchestrator entirely. Build the decision directly from `finalDecision` and the primary reviewer's notes. The orchestrator is ONLY for merging multiple reject-note checklists into one.

```
needsMerge = true  → call invokeMultiReviewerOrchestrator (existing, unchanged)
needsMerge = false → build decision from finalDecision directly (no LLM call)
```

## Design

### Change to `resolveReviewerDecision` in `loop-phases-reviewer-resolution.ts`

Replace the `else` branch with a direct decision builder. No new functions needed — promote the fallback logic to the primary path.

```typescript
if (needsMerge) {
  // Two or more reviewers rejected with notes: merge their checklists
  try {
    const orchestratorOutput = await invokeMultiReviewerOrchestrator(multiContext, projectPath);
    const handler = new OrchestrationFallbackHandler();
    decision = handler.parseReviewerOutput(orchestratorOutput);
  } catch (error) {
    console.error('Multi-reviewer orchestrator failed:', error);
    decision = {
      decision: 'unclear',
      reasoning: 'FALLBACK: Multi-reviewer orchestrator failed',
      notes: 'Review unclear, retrying',
      next_status: 'review',
      rejection_count: task.rejection_count,
      confidence: 'low',
      push_to_remote: false,
      repeated_issue: false,
    };
  }
} else {
  // All reviewers agreed (approve / dispute / skip) — no orchestrator needed
  const primaryResult =
    reviewerResults.find(r => r.decision === finalDecision) || reviewerResults[0];
  decision = {
    decision: finalDecision as ReviewerOrchestrationResult['decision'],
    reasoning: `Multi-reviewer consensus: ${finalDecision} (${reviewerResults.length} reviewers)`,
    notes: primaryResult?.notes || primaryResult?.stdout || '',
    next_status:
      finalDecision === 'approve'  ? 'completed'  :
      finalDecision === 'reject'   ? 'in_progress':
      finalDecision === 'dispute'  ? 'disputed'   :
      finalDecision === 'skip'     ? 'skipped'    : 'review',
    rejection_count: task.rejection_count,
    confidence: 'high',
    push_to_remote: ['approve', 'dispute', 'skip'].includes(finalDecision),
    repeated_issue: false,
  };
}
```

### What is NOT changed

- `resolveDecision()` in `reviewer.ts` — untouched
- `buildMultiReviewerOrchestratorPrompt` — untouched (still correct for the merge path)
- `buildPostReviewerPrompt` — untouched (single-reviewer path)
- `SignalParser` — untouched
- All other reviewer plumbing — untouched

### Edge case: `finalDecision === 'unclear'`

`resolveDecision()` returns `needsMerge: false` with `finalDecision: 'unclear'` in two cases:
- No results
- Mix of approve + skip

The new `else` branch handles this correctly: `next_status` falls through to `'review'` (retry), and `decision: 'unclear'` is surfaced to the caller which already has a retry loop for unclear decisions.

### Edge case: `finalDecision === 'reject'` with `needsMerge: false`

This cannot happen. `resolveDecision()` only sets `needsMerge: false` on the reject path when there is ≤1 rejector with notes. In that case `finalDecision` is still `'reject'` but `needsMerge` is `false`. The new else-branch code path assigns `next_status: 'in_progress'` for `reject` — correct. The primary reviewer's notes are preserved as-is (no merge needed since only one rejector).

## Implementation Order

### Task 1: Write the failing test

**Files:**
- Modify: `tests/loop-phases-reviewer-resolution.test.ts` (create if not exists)

Write a test that:
1. Creates two reviewer results both with `decision: 'approve'`
2. Calls `resolveReviewerDecision` with these results and `effectiveMultiReviewEnabled: true`
3. Asserts the returned decision is `approve`, NOT `reject`
4. Asserts `invokeMultiReviewerOrchestrator` was NOT called (mock it to throw if called)

**Step 1: Check if test file exists**
```bash
ls tests/loop-phases-reviewer-resolution.test.ts 2>/dev/null || echo "does not exist"
```

**Step 2: Write the failing test**

```typescript
import { resolveReviewerDecision } from '../src/commands/loop-phases-reviewer-resolution.js';
import * as invoke from '../src/orchestrator/invoke.js';

jest.mock('../src/orchestrator/invoke.js');

describe('resolveReviewerDecision — multi-reviewer consensus', () => {
  const task = { id: 'test-task-id', title: 'Test task', rejection_count: 0 };
  const gitContext = { commit_sha: 'abc123', files_changed: [], additions: 0, deletions: 0 };
  const approveResult = {
    success: true, exitCode: 0, stdout: 'DECISION: APPROVE\nNOTES: Looks good',
    stderr: '', duration: 5000, timedOut: false,
    decision: 'approve' as const, notes: 'Looks good', provider: 'codex', model: 'gpt-5.3',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns approve without calling orchestrator when both reviewers approve', async () => {
    const mockOrchestrator = jest.spyOn(invoke, 'invokeMultiReviewerOrchestrator')
      .mockRejectedValue(new Error('orchestrator should not be called'));

    const result = await resolveReviewerDecision(
      task, '/fake/path',
      approveResult,
      [approveResult, { ...approveResult, provider: 'claude' }],
      true,
      gitContext
    );

    expect(result.decision).toBe('approve');
    expect(mockOrchestrator).not.toHaveBeenCalled();
  });

  it('returns reject and calls orchestrator when both reviewers reject', async () => {
    const rejectResult = {
      ...approveResult, decision: 'reject' as const,
      stdout: 'DECISION: REJECT\n- [ ] Fix bug in foo.ts',
      notes: '- [ ] Fix bug in foo.ts',
    };
    jest.spyOn(invoke, 'invokeMultiReviewerOrchestrator')
      .mockResolvedValue('DECISION: REJECT\nNOTES:\n- [ ] Fix bug in foo.ts\nCONFIDENCE: HIGH');

    const result = await resolveReviewerDecision(
      task, '/fake/path',
      rejectResult, [rejectResult, { ...rejectResult, provider: 'claude' }],
      true, gitContext
    );

    expect(result.decision).toBe('reject');
    expect(invoke.invokeMultiReviewerOrchestrator).toHaveBeenCalledTimes(1);
  });
});
```

**Step 3: Run test to verify it fails**
```bash
npm run build && npx jest loop-phases-reviewer-resolution --no-coverage 2>&1 | tail -20
```
Expected: FAIL — `approveResult.decision` is `approve` but test assertions will fail once we confirm the current code calls the orchestrator.

**Step 4: Commit test**
```bash
git add tests/loop-phases-reviewer-resolution.test.ts
git commit -m "test: add failing test for multi-reviewer approve consensus bypassing orchestrator"
```

---

### Task 2: Apply the fix

**Files:**
- Modify: `src/commands/loop-phases-reviewer-resolution.ts` lines 84-131

**Step 1: Apply the change**

Replace lines 84–131 in `resolveReviewerDecision` (the entire `else` branch) with the new direct-decision builder shown in the Design section above.

**Step 2: Run tests**
```bash
npm run build && npx jest loop-phases-reviewer-resolution --no-coverage 2>&1 | tail -20
```
Expected: PASS

**Step 3: Run full test suite**
```bash
npm run build && npm test 2>&1 | tail -30
```
Expected: All previously passing tests still pass.

**Step 4: Commit**
```bash
git add src/commands/loop-phases-reviewer-resolution.ts
git commit -m "fix: bypass multi-reviewer orchestrator on unanimous approve/skip/dispute consensus

When all reviewers agree (approve/skip/dispute), resolveDecision() returns
needsMerge=false. The previous code still called invokeMultiReviewerOrchestrator
whose prompt unconditionally says 'The DECISION is already REJECT', causing the
LLM to output DECISION: REJECT even when reviewer notes said 'Both approved'.

The fix promotes the catch-block fallback logic to the primary path:
when needsMerge=false, build the decision directly from finalDecision
without any LLM call. The orchestrator is now only invoked for the
needsMerge=true path (merging two or more reject checklists)."
```

---

## Edge Cases

| Scenario | `resolveDecision()` output | New behavior |
|---|---|---|
| Both reviewers APPROVE | `approve, needsMerge:false` | Direct approve, no orchestrator |
| Both reviewers REJECT with notes | `reject, needsMerge:true` | Orchestrator merges notes (unchanged) |
| One REJECT, one APPROVE | `reject, needsMerge:false` | Direct reject, primary reviewer notes preserved |
| Both DISPUTE | `dispute, needsMerge:false` | Direct dispute, no orchestrator |
| One APPROVE, one SKIP | `unclear, needsMerge:false` | Direct unclear → retry |
| All SKIP | `skip, needsMerge:false` | Direct skip, no orchestrator |
| Empty results | `unclear, needsMerge:false` | Direct unclear → retry |

## Non-Goals

- Fixing the AdGoes coder regression issue (separate problem: task scope too large, Codex unstable on large features)
- Modifying the orchestrator prompt for the reject-merge path
- Changing how single-reviewer decisions are processed
- Changing `resolveDecision()` logic

## Cross-Provider Review

### Reviewer 1 (Claude sonnet-4-6) — adversarial

| Finding | Severity | Decision |
|---|---|---|
| `notes: primaryResult?.notes \|\| primaryResult?.stdout` — on APPROVE, `notes` is always `undefined` (parser only sets it on reject), so the full raw stdout gets stored in the audit log | Critical | **ADOPT** — guard: for approve/skip/dispute, use `primaryResult?.notes \|\| ''`; for reject, use `primaryResult?.notes \|\| 'See reviewer output for details'`; never fall through to raw stdout |
| `confidence: 'high'` on empty-results path (zero reviewers → unclear) is false | Important | **ADOPT** — set `confidence: 'low'` when `finalDecision === 'unclear'` |
| `confidence: 'high'` on single-rejector minority-reject path is overstated | Important | **ADOPT** — set `confidence: 'medium'` when `finalDecision === 'reject'` and `needsMerge: false` |
| `follow_up_tasks` silently dropped on consensus approve | Important | **DEFER** — `ReviewerResult` does not carry follow-up tasks; the orchestrator path synthesizes them from LLM output. The direct path cannot populate what isn't there. Add a comment. |
| `finalDecision as ReviewerOrchestrationResult['decision']` — safe today, future-hostile | Low | **ADOPT** — replace cast with explicit ternary/exhaustiveness check |
| `isUnanimousConsensus` check removal | Suggestion | **ACCEPT** — no longer needed; we are not calling the orchestrator so there is no failure to fall back from |

### Reviewer 2 (Codex gpt-5.3) — adversarial

| Finding | Severity | Decision |
|---|---|---|
| `needsMerge: false` ≠ consensus — also true for unclear (approve+skip mix) and single-rejector. Branch comment says "all reviewers agreed" but that's wrong | High | **ADOPT** — fix branch comment and `confidence` values to reflect actual semantics (see above) |
| Multi-reject with both `notes` undefined → `needsMerge: false` → direct path drops second reviewer's stdout | High | **DEFER** — `parseReviewerDecision` always sets `notes` for reject (fallback `'See reviewer output for details'`), so `rejectorsWithNotes` is always non-empty when there are rejectors. This case is theoretical given current parsing code. |
| `notes \|\| stdout` bloat — stdout written to DB rejection notes untruncated | Medium | **ADOPT** — covered by raw stdout fix above |
| Type cast future-hostile | Low | **ADOPT** — same as Claude finding |
| Missing tests: `approve+approve`, `approve+skip→unclear`, `reject+approve single`, `reject+reject no-notes` | Serious | **ADOPT** — update test spec in Task 1 to cover all four cases |

### Round 2 Findings

| Finding | Reviewer | Severity | Decision |
|---|---|---|---|
| `primaryResult.find()` never matches when `finalDecision==='unclear'` (ReviewerResult.decision has no 'unclear' value); fallback to `reviewerResults[0]` silently triggers | Both | Critical | **ADOPT** — add explicit `unclear` guard at top of `else` block |
| `reasoning` string says "Multi-reviewer consensus" for unclear, single-rejector-reject, and any-dispute paths where there is no consensus | Both | Important | **ADOPT** — differentiate reasoning strings per outcome |
| `confidence: 'high'` for dispute: `resolveDecision` returns dispute if ANY single reviewer disputes (not all), so it's not high-confidence | Codex | Medium | **ADOPT** — dispute → `'medium'` |
| For the single-rejector reject case, `primaryResult.notes` is a weak single-line extraction (regex on `notes:/reason:` line); coder gets useless placeholder instead of actual checklist | Codex | High | **ADOPT** — for reject, fall back to `stdout.slice(-3000)` when notes is absent/placeholder |
| `push_to_remote: true` for `skip` conflicts with runtime (skip case in loop-phases-reviewer.ts does not push); field is currently dead/unused but misleading | Codex | Low | **ADOPT** — skip → `false` for accuracy |
| Empty notes string for `unclear` + empty reviewerResults is poor for observability | Claude | Low | **ADOPT** — explicit unclear guard sets a descriptive notes string |

### Final Implementation

```typescript
} else {
  // finalDecision is the deterministic result from resolveDecision().
  // needsMerge:false covers: consensus (approve/skip), any-dispute, single-rejector, unclear.
  // Note: this path does NOT populate follow_up_tasks — ReviewerResult doesn't carry them.

  // Explicit unclear guard — resolveDecision returns unclear when: empty results,
  // approve+skip mix, or undefined-decision mix. ReviewerResult.decision never includes
  // 'unclear', so .find() below would always miss it.
  if (finalDecision === 'unclear') {
    decision = {
      decision: 'unclear',
      reasoning: `Multi-reviewer result is ambiguous (${reviewerResults.length} reviewers, no decisive outcome)`,
      notes: '',
      next_status: 'review',
      rejection_count: task.rejection_count,
      confidence: 'low',
      push_to_remote: false,
      repeated_issue: false,
    };
  } else {
    const primaryResult =
      reviewerResults.find(r => r.decision === finalDecision) ?? reviewerResults[0];

    // For reject: parsed notes are often a weak single-line extraction; fall back to raw
    // stdout (capped) so the coder gets the actual rejection checklist.
    // For approve/skip/dispute: short notes or empty string is fine.
    const notesForDecision =
      finalDecision === 'reject'
        ? (primaryResult?.notes && primaryResult.notes !== 'See reviewer output for details'
            ? primaryResult.notes
            : (primaryResult?.stdout?.slice(-3000) ?? 'See reviewer output for details'))
        : (primaryResult?.notes ?? '');

    // approve/skip = full consensus → high
    // dispute = any-one-disputes (not all), reject = single-rejector → both medium
    const confidenceForDecision: 'high' | 'medium' | 'low' =
      finalDecision === 'approve' || finalDecision === 'skip' ? 'high' : 'medium';

    const reasoningForDecision =
      finalDecision === 'approve' || finalDecision === 'skip'
        ? `All ${reviewerResults.length} reviewers agreed: ${finalDecision}`
        : finalDecision === 'dispute'
        ? `Reviewer escalated to dispute (${reviewerResults.length} reviewers)`
        : `Single-rejector reject, needsMerge=false (${reviewerResults.length} reviewers)`;

    const nextStatusForDecision: ReviewerOrchestrationResult['next_status'] =
      finalDecision === 'approve' ? 'completed'   :
      finalDecision === 'reject'  ? 'in_progress' :
      finalDecision === 'dispute' ? 'disputed'     :
      finalDecision === 'skip'    ? 'skipped'      : 'review';

    decision = {
      decision: finalDecision,
      reasoning: reasoningForDecision,
      notes: notesForDecision,
      next_status: nextStatusForDecision,
      rejection_count: task.rejection_count,
      confidence: confidenceForDecision,
      // skip does not push in the runtime switch-case; field is currently unused but set accurately
      push_to_remote: finalDecision === 'approve' || finalDecision === 'dispute',
      repeated_issue: false,
    };
  }
}
```
