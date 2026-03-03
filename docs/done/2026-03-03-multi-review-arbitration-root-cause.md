# Multi-Review Arbitration Root-Cause Plan

**Status:** Implemented and Verified  
**Date:** 2026-03-03  
**Scope:** Ensure reviewer disagreements are resolved deterministically by explicit arbitration flow, not by unclear-retry escalation

## 1. Problem Statement

Task `6abd2a15-ab91-4af5-a95a-96138c9cdcb5` escalated to `disputed` even when reviewers produced explicit but conflicting decisions.

Root causes:

1. Decision parsing drift across call sites produced inconsistent reviewer decisions.
2. Multi-review resolution treated some disagreement sets as `unclear` instead of arbitration-required.
3. Retry escalation (`unclear` counter) converted disagreement into dispute instead of forcing a final arbitration outcome.

## 2. Current Behavior (Before Fix)

- Reviewer decision parsing existed in multiple incompatible forms:
  - `src/orchestrator/reviewer.ts`
  - `src/orchestrator/signal-parser.ts`
  - `src/runners/wakeup-sanitise.ts`
- Multi-review routing depended on `needsMerge`, which missed disagreement states.
- Approve/reject conflict could enter unclear retry loops.
- Wakeup sanitise used brittle log parsing heuristics.

## 3. Desired Behavior

1. One canonical reviewer decision parser across all call sites.
2. Explicit multi-review routing matrix (`direct`, `local_reject_merge`, `arbitrate`).
3. Disagreement states always route to arbitration, never generic unclear retries.
4. Arbitration contract violations trigger bounded retries then deterministic fallback.
5. Wakeup sanitise recovers stale reviewer invocations using robust log decoding.

## 4. Design

### Canonical Decision Parser

- Added `src/orchestrator/reviewer-decision-parser.ts`.
- Rules:
  - parse explicit `DECISION: ...` / `DECISION - ...`
  - case-insensitive
  - last explicit token wins
  - ignore fenced code blocks and markdown quote lines
  - no first-line bare-token fallback

### Multi-Review Routing

- `resolveDecision()` now returns `{ decision, needsMerge, route }`.
- Routes:
  - `direct`: unanimous-safe states
  - `local_reject_merge`: multi-reject deterministic merge without LLM
  - `arbitrate`: all disagreement/ambiguous sets

### Arbitration Contract Enforcement

- Added `getArbitrationContractViolation()` in `src/commands/loop-phases-reviewer-resolution.ts`.
- Enforced violations:
  - no decision token
  - `SKIP` not allowed from arbitrator
  - dispute emitted when no reviewer disputed (with reject pressure)
  - non-`HIGH` approve when disagreement exists (`reject`/`dispute`/`skip` present)
  - empty-note reject
- Arbitration is bounded (`MAX_MULTI_REVIEW_ARBITRATION_ATTEMPTS = 2`), then deterministic fallback:
  - reject fallback when reject-pressure exists and no dispute
  - otherwise dispute with `ARBITRATION_FAILED` marker

### Wakeup Sanitise Robustness

- Added `parseReviewerDecisionFromInvocationLogContent()` in `src/runners/wakeup-sanitise.ts`.
- Parses invocation NDJSON output events (`type=output`, `stream=stdout`, `msg`) and then runs canonical decision parser.
- Falls back to raw content parsing for legacy/non-JSON logs.

### Prompt Parity

- Resume reviewer delta prompt now includes sibling-task and instruction sections for policy parity with full prompt.

## 5. Implementation Order (Executed)

1. Implement canonical parser + unit tests.
2. Migrate parser call sites (`reviewer.ts`, `signal-parser.ts`, `wakeup-sanitise.ts`).
3. Refactor multi-review routing and arbitration contract handling.
4. Add deterministic local reject merge path.
5. Add arbitration retry bounds and fallback policy.
6. Fix wakeup sanitise log-parsing regression from structured invocation logs.
7. Add targeted tests for routing, parser, arbitration contract, and sanitise parsing.

## 6. Edge Cases

| Scenario | Handling |
|---|---|
| `approve + reject` | route `arbitrate` |
| `approve + dispute` | route `arbitrate` |
| `approve + skip` | route `arbitrate` |
| `reject + undefined` | route `arbitrate` |
| `reject + reject` | `local_reject_merge` |
| all `approve` | direct approve |
| all `skip` | direct skip |
| all `dispute` | direct dispute |
| arbitrator returns `SKIP` | contract violation + retry/fallback |
| arbitrator returns low-confidence approve during disagreement | contract violation + retry/fallback |
| stale reviewer invocation NDJSON log with decision in `msg` | recovered via structured log parsing |

## 7. Non-Goals

- Redesigning task-selector/dependency gating.
- Changing TaskStatus semantics outside reviewer-decision flow.
- Replacing orchestrator provider stack.

## 8. Cross-Provider Review

### Planning + Implementation Reviews (Adversarial)

- **Review A (Gemini):** no blocking findings; recommended minor follow-ups.
- **Review B (Codex):** identified blocking issues that were adopted and fixed:
  1. `reject + undefined` misclassified as unanimous reject.
  2. Arbitration accepted `SKIP` and could fail open.
  3. `approve + skip` fail-open policy risk.
  4. Weak approval confidence checks under disagreement.
  5. Missing confidence gate when disagreement included `undefined` reviewer decisions.
- **Verification pass (Gemini):** no blocking findings after safety-gate fixes.

### Decisions

- **Adopted:** all blocking findings above.
- **Rejected:** “remove arbitration for mixed votes” (would conflict with requirement that orchestrator resolves disagreements).
- **Deferred (non-blocking):** optional payload-size caps for reject note bodies.

### Verification Evidence

- Targeted tests passing:
  - `tests/multi-reviewer.test.ts`
  - `tests/reviewer-arbitration-contract.test.ts`
  - `tests/reviewer-decision-parser.test.ts`
  - `tests/signal-parser.test.ts`
  - `tests/reviewer-prompt-parity.test.ts`
  - `tests/wakeup-sanitise-decision-parser.test.ts`
- `npm run build` passes.
