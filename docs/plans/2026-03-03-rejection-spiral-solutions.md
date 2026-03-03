# Preventing Unreachable Submission SHAs and Rejection Spirals

## 1. Problem Statement
Tasks can enter deterministic rejection spirals when submission commit SHAs stored in audit history become unreachable in the review workspace. In that state, reviewer logic falls back to older reachable history, which can contain out-of-scope changes and trigger repeated mandatory rejects.

Impact:
- wasted runner cycles and provider credits
- inflated rejection counts and false task failure risk
- user-visible confusion ("same rejection forever")

## 2. Current Behavior (Relevant Paths)
- Submission SHAs are recorded in task audit rows (`to_status='review'`).
- Reviewer resolution scans historical submission SHAs and chooses reachable commits.
- No-op submissions can anchor review using pool start SHA.
- Pool slots are reset/rebranched aggressively (`reset --hard`, `checkout -B`), so unanchored commits can be orphaned.

Key files:
- `src/commands/loop-phases-coder.ts`
- `src/commands/loop-phases-reviewer.ts`
- `src/git/submission-resolution.ts`
- `src/workspace/git-lifecycle.ts`
- `src/orchestrator/reviewer.ts`

## 3. Desired Behavior
- Submission SHAs used for review remain reachable by design.
- Reviewer never relies on stale contaminated history when current submission lineage is broken.
- Recovery loops terminate deterministically.
- Existing decision invariants remain unchanged:
  - `[OUT_OF_SCOPE] => REJECT`
  - decision priority `reject > dispute > approve > skip`

## 4. Design

### 4.1 Primary Fix: Submission Durability Contract
At submission time, make SHAs durable and lineage-checkable.

Changes:
1. On each transition to review with `commit_sha`, write/update a durable task-scoped git ref:
   - `refs/steroids/submissions/<task_id>/latest`
2. Record ref + sequence metadata in audit metadata for integrity checks.
3. Enforce atomicity contract:
   - audit submission record and durable ref update must succeed together for submission to be accepted.
   - perform both under a single task-scoped critical section; fail submission transition if either write fails.
4. Enforce monotonic update:
   - only advance `latest` when incoming submission sequence is newer (CAS-style update prevents parallel overwrite rollback).
5. Reviewer resolution prefers durable ref only when lineage check passes:
   - durable ref SHA must match latest review-transition audit SHA for that task.
   - if mismatch, emit integrity event and fall back to existing resolution logic.
6. Reject stale replay:
   - bind durable ref updates to invocation/session token so late old results cannot overwrite newer lineage.

### 4.2 Secondary Containment: Deterministic Commit-Recovery Gate
When lineage cannot be resolved safely, short-circuit review.

Checks:
- `latest_missing_with_older_reachable`
- `all_submissions_unreachable`

Behavior:
1. Before reviewer fan-out, run a single central preflight.
   - this is a runtime precondition, not a reviewer decision override.
2. If unhealthy, skip reviewer invocation and set task back to `in_progress` with `[commit_recovery]` instruction.
3. Track consecutive recovery attempts (persisted) and escalate to `disputed` at cap (e.g. 3).
   - increment for each gated recovery transition on same task lineage
   - reset only after healthy submission reaches review
4. Recovery transitions do not increment rejection count.

### 4.3 Secondary Hardening: No-Op Anchoring Guard
Prevent no-op submissions from reusing stale pool baseline in unresolved-history states.

Behavior:
- If unresolved submission history exists, `[NO_OP_SUBMISSION]` cannot anchor to pool-start SHA.
- Require explicit reachable `SUBMISSION_COMMIT` for no-op forward-to-review.
- If unresolved history persists through recovery cap, escalate to `disputed` (no infinite no-op loop).

### 4.4 Operational Hygiene for Durable Refs
Define lifecycle to avoid leaks and stale influence.

Policy:
1. Keep only `latest` in phase 1 (no ring refs yet).
2. Cleanup durable refs for terminal tasks after retention window.
3. Resolver ignores expired/invalid refs deterministically.
4. Mark stale durable refs from abandoned/killed invocations so they do not block task/section progress.

## 5. Implementation Order
1. Add durable ref write + audit metadata + lineage validator (primary fix).
2. Add reviewer preflight health check + deterministic recovery gate.
3. Add persisted recovery-attempt counter + escalation rule.
4. Add no-op anchoring guard tied to same health predicate.
5. Add durable ref cleanup job/command and retention config.
6. Add metrics/events:
   - durable-ref write failures
   - lineage mismatch
   - recovery gate triggers
   - recovery escalations
   - stale ref cleanup actions
   - stale invocation replay rejections

## 6. Edge Cases
| Scenario | Required handling |
|---|---|
| Latest submission SHA unreachable, older reachable exists | trigger commit-recovery gate before reviewer invocation |
| All submission SHAs unreachable | commit-recovery gate, then escalate after cap |
| Parallel submission race on same task | monotonic durable-ref update; older write cannot overwrite newer |
| Durable ref exists but mismatches latest audit SHA | integrity event + fallback resolver path |
| Runner killed mid-flow leaves stale durable ref | stale marker/cleanup excludes ref from blocking logic |
| Late old invocation result arrives after newer submission | rejected by invocation token/sequence guard |
| No-op with clean, healthy lineage | unchanged behavior; allow review |
| No-op with unresolved lineage | require explicit reachable `SUBMISSION_COMMIT` |

## 7. Non-Goals
- Changing reviewer decision semantics
- Automatic semantic file-ownership inference
- Removing human dispute workflow

## 8. Regression Safety Requirements
Must remain unchanged:
- dependency gating and task selection behavior
- section completion checks
- reviewer decision priority and out-of-scope rejection semantics

Required tests:
1. clean reachable chain: behavior unchanged
2. partial-unreachable chain: reviewer preflight triggers recovery
3. all-unreachable chain: recovery + escalation after cap
4. no-op healthy lineage: unchanged
5. no-op unresolved lineage: explicit commit required
6. parallel monotonic durable-ref updates: older submission cannot clobber newer
7. rejection counters unchanged by recovery transitions
8. stale durable refs do not block section-completion checks
9. late invocation replay cannot roll back latest durable lineage

## 9. Final Cross-Provider Review (Single Pass)
Outcome:
- Codex: `BLOCKERS: none; VERDICT: ready` (with non-blocking clarifications on stale-ref lifecycle, CAS telemetry, replay-key retention).
- Claude: `BLOCKERS: none; VERDICT: ready`.

Agreed non-blocking clarifications to include during implementation:
1. Document stale-ref marker lifecycle (creation, TTL, cleanup trigger).
2. Define CAS conflict observability fields/metrics.
3. Define replay-guard key scope and retention window.
