# Second Opinion: Multi-Reviewer System

**Date:** 2026-02-21
**Status:** Draft
**Version:** 0.3

**Cross-provider review:** Vibe (7.5/10), Codex (6.5/10), Gemini (8/10) — feedback incorporated.

---

## Executive Summary

Add support for **multiple independent reviewers** so that code review requires approval from **all configured AI providers** before a task can be completed. Reviewers run in parallel with no awareness of each other. The orchestrator consolidates their outputs into a single unified set of findings for the coder.

**Example configurations:**
```yaml
# Two reviewers
reviewers:
  - provider: codex
  - provider: claude

# Three reviewers
reviewers:
  - provider: codex
  - provider: claude
  - provider: gemini

# Five reviewers — go wild
reviewers:
  - provider: codex
  - provider: claude
  - provider: gemini
  - provider: mistral
  - provider: vibe
```

**Key principle:** ALL reviewers must approve. If any one rejects, the task goes back to the coder — just like GitHub PRs with required reviewers. Disputes are escalated to the orchestrator, which can override only in rare edge cases.

---

## Table of Contents

1. [Motivation](#motivation)
2. [Current Architecture](#current-architecture)
3. [Proposed Architecture](#proposed-architecture)
4. [Configuration](#configuration)
5. [Review Phase Flow](#review-phase-flow)
6. [Orchestrator Consolidation](#orchestrator-consolidation)
7. [Decision Matrix](#decision-matrix)
8. [Strict Mode & Circuit Breakers](#strict-mode--circuit-breakers)
9. [Style Conflict Resolution](#style-conflict-resolution)
10. [Data Model Changes](#data-model-changes)
11. [Prompt Changes](#prompt-changes)
12. [Edge Cases](#edge-cases)
13. [Implementation Plan](#implementation-plan)
14. [Resolved Design Decisions](#resolved-design-decisions)
15. [Open Questions](#open-questions)

---

## Motivation

A single reviewer has blind spots. Different AI providers catch different things. By requiring unanimous approval from multiple independent reviewers, we:

- Catch more issues before code is merged
- Reduce provider-specific biases
- Increase confidence in approved code
- Create a quality gate that mirrors real-world team code review (GitHub required reviewers)

This is **opt-in** — the default remains a single reviewer. Users enable multi-review when they want higher assurance.

---

## Current Architecture

```
Task in Review
      |
      v
invokeReviewer(task, projectPath, guidance?)
      |  (single provider)
      v
ReviewerResult { decision, notes, duration }
      |
      v
invokeReviewerOrchestrator(context)
      |
      v
Post-Reviewer Orchestrator -> JSON decision
      |
      v
Execute: approve | reject | dispute | skip
```

**Key files:**
- `src/orchestrator/reviewer.ts` — invokes one reviewer
- `src/commands/loop-phases.ts` — `runReviewerPhase()`
- `src/orchestrator/post-reviewer.ts` — orchestrator parses single output
- `src/prompts/reviewer.ts` — generates reviewer prompt
- `src/config/loader.ts` — `ai.reviewer` config (single provider)

---

## Proposed Architecture

```
Task in Review
      |
      v
+---------------------------------------------+
|       invokeReviewers() (parallel)           |
|                                              |
|  +----------+  +----------+  +----------+   |
|  | Reviewer 1|  | Reviewer 2|  | Reviewer N|  |
|  | (Codex)   |  | (Claude)  |  | (Gemini)  |  |
|  +-----+----+  +-----+----+  +-----+----+   |
|        |             |             |          |
|        v             v             v          |
|  Result 1       Result 2       Result N       |
+--------+-------------+-------------+---------+
         |             |             |
         v             v             v
   +--------------------------------------+
   | Policy Engine (deterministic)         |
   | - ALL must approve for APPROVE        |
   | - ANY rejection = REJECT              |
   | - Disputes escalated to orchestrator  |
   +------------------+-------------------+
                      |
                      v
   +--------------------------------------+
   | Orchestrator (LLM, only if merging)   |
   | - Groups findings by file/line        |
   | - Preserves original wording          |
   | - Produces single checklist           |
   +------------------+-------------------+
                      |
                      v
   Execute: approve | reject | dispute | skip
```

**All reviewers receive the same context** (git diff, rejection history, section tasks, coordinator guidance). They run independently and in parallel — no awareness of each other.

**Two-stage consolidation:**
1. **Policy engine** — deterministic decision. No LLM needed. Pure code applies the rule: all approve = approve, any reject = reject.
2. **Orchestrator** — only invoked when notes need merging (multiple rejections). Groups findings, deduplicates by file/line proximity, preserves original wording. Acts as a router/grouper, not a judge.

---

## Configuration

### Config Schema (Array-Based)

```yaml
# .steroids/config.yaml
ai:
  # Single reviewer (existing, unchanged -- backward compatible)
  reviewer:
    provider: claude
    model: claude-sonnet-4

  # Multiple reviewers (NEW, optional -- enables multi-review)
  # No cap on array size. Add as many reviewers as you want.
  reviewers:
    - provider: codex
      model: gpt-4.1
    - provider: claude
      model: claude-sonnet-4
    - provider: gemini
      model: gemini-2.5-pro

  # Review policy (NEW, optional)
  review:
    strict: true               # Fail if any reviewer unavailable (default: true)
```

**Backward compatibility:**
- `ai.reviewer` (singular) continues to work exactly as today
- `ai.reviewers` (plural) enables multi-reviewer mode
- If both are set, `reviewers` takes precedence and `reviewer` is ignored
- If only `reviewer` is set, single-reviewer mode (no changes)

### Environment Variables

```bash
# Single reviewer (existing)
STEROIDS_AI_REVIEWER_PROVIDER=claude
STEROIDS_AI_REVIEWER_MODEL=claude-sonnet-4

# Multi-reviewer via env vars (comma-separated shorthand)
STEROIDS_AI_REVIEWERS="codex:gpt-4.1,claude:claude-sonnet-4,gemini:gemini-2.5-pro"

# Review policy
STEROIDS_AI_REVIEW_STRICT=true
```

### TypeScript Config Type

```typescript
interface ReviewerConfig {
  provider?: ProviderName;
  model?: string;
  cli?: string;
}

interface ReviewPolicy {
  strict?: boolean;          // Default: true (fail if any reviewer unavailable)
}

// In SteroidsConfig
ai?: {
  reviewer?: ReviewerConfig;         // Existing single reviewer
  reviewers?: ReviewerConfig[];      // NEW: multi-reviewer array
  review?: ReviewPolicy;             // NEW: review policy
};
```

### Validation Rules

- `reviewers` array must have 2+ entries (use `reviewer` singular for one)
- No two entries may have the same `provider` — using the same provider twice adds no value
- All providers must be available (`provider.isAvailable()`) at loop start — unless `strict: false`

---

## Review Phase Flow

### Updated `runReviewerPhase()`

```
1. Determine review mode:
   |-- reviewers[] configured -> Multi-reviewer flow
   +-- reviewer (singular)   -> Single reviewer (existing flow, unchanged)

2. Build shared context (git diff, rejection history, section tasks, etc.)

3. Pre-flight check:
   - Verify all reviewer providers are available
   - If strict=true and any unavailable -> FAIL (do not proceed)
   - If strict=false and any unavailable -> warn + remove from this cycle

4. Invoke ALL reviewers in parallel:
   - results = await Promise.allSettled(reviewers.map(r => invokeReviewer(..., r)))

5. Classify results:
   - succeeded: ReviewerResult[] (provider responded)
   - failed: { provider, error }[] (timeout/crash/credits)

6. Apply policy engine (deterministic):
   - If strict=true and any failed -> UNCLEAR, retry next cycle
   - ALL succeeded must approve for APPROVE
   - ANY rejection -> REJECT
   - Apply decision matrix for edge cases (dispute, skip)

7. If decision is REJECT with multiple reviewer notes:
   - Invoke orchestrator to merge notes into single checklist

8. Execute decision (same as today: approve/reject/dispute/skip)
```

### Parallel Invocation

```typescript
const results = await Promise.allSettled(
  reviewerConfigs.map(config =>
    invokeReviewer(task, projectPath, guidance, config)
  )
);

const succeeded = results
  .filter(r => r.status === 'fulfilled')
  .map(r => r.value);

const failed = results
  .filter(r => r.status === 'rejected')
  .map((r, i) => ({ provider: reviewerConfigs[i].provider, error: r.reason }));
```

All reviewers share the same timeout (600s). Each runs independently via its own provider CLI.

---

## Provider Model Selection Reference

Each provider CLI has a different mechanism for model selection. This was verified via live testing on 2026-02-21.

### Summary Table

| Provider | CLI | Model Flag | Env Var | Accepts Aliases? | Accepts Full IDs? |
|----------|-----|-----------|---------|-----------------|-------------------|
| **Claude** | `claude` | `--model <model>` | No | `sonnet`, `opus`, `haiku` | `claude-sonnet-4-6` etc. |
| **Codex** | `codex` | `--model <model>` / `-m` | No (`OPENAI_MODEL` ignored) | No | `gpt-4.1`, `gpt-5.3-codex` |
| **Gemini** | `gemini` | `-m <model>` / `--model` | No | `gemini-2.5-pro`, `gemini-2.5-flash` | No (versioned IDs return 404) |
| **Vibe** | `vibe` | **None** | `VIBE_ACTIVE_MODEL` + `VIBE_MODELS` | Via config aliases | Via `VIBE_MODELS` JSON injection |

### Per-Provider Details

**Claude:**
```bash
claude -p "$(cat prompt.txt)" --model sonnet --output-format stream-json --verbose
```
- Aliases: `sonnet`, `opus`, `haiku` (resolve to latest version)
- Full IDs: `claude-sonnet-4-6`, `claude-opus-4-6`, etc.
- Also supports `--fallback-model` for overload scenarios
- Cannot be tested from within a Claude session (nested session protection)

**Codex:**
```bash
cat prompt.txt | codex exec --model gpt-4.1 --skip-git-repo-check -C /path --ephemeral -
```
- Default model: `gpt-5.3-codex` (if no `--model` flag)
- `OPENAI_MODEL` env var does NOT work — completely ignored
- Model availability depends on account type (API vs ChatGPT account)
- Also accepts `-c model="gpt-4.1"` config override syntax

**Gemini:**
```bash
gemini -p "$(cat prompt.txt)" -m gemini-2.5-pro
```
- Both `-m` and `--model` work identically
- Must use short aliases (`gemini-2.5-pro`), not versioned IDs (`gemini-2.5-pro-preview-05-06` returns 404)
- Flag ordering can matter — use `-p` short form to avoid parsing quirks

**Vibe (Mistral):**
```bash
VIBE_ACTIVE_MODEL=mistral-large-latest \
VIBE_MODELS='[{"name":"mistral-large-latest","provider":"mistral","alias":"mistral-large-latest","input_price":0,"output_price":0}]' \
vibe -p "$(cat prompt.txt)" --output text
```
- **No `--model` flag exists** — `--model` causes `error: unrecognized arguments`
- Model selection requires BOTH env vars: `VIBE_ACTIVE_MODEL` (which to use) + `VIBE_MODELS` (model definition)
- `VIBE_ACTIVE_MODEL` alone fails if the model isn't already in `~/.vibe/config.toml`
- `VIBE_MODELS` injects runtime model definitions, bypassing the config file
- Default model: `devstral-2` (alias for `mistral-vibe-cli-latest`)
- Pre-configured models in config: `devstral-2`, `devstral-small`, `local`

### Implementation Note

The `invokeReviewer()` function must handle model passing differently per provider. The current `buildCommand()` template substitution (`{model}` placeholder) works for Claude and Gemini but NOT for Codex or Vibe:

- **Claude/Gemini:** Template includes `{model}` placeholder — direct substitution works
- **Codex:** Template must be updated to include `--model {model}` (currently missing)
- **Vibe:** Model passed via environment variables in the spawn options, not in the command string

---

## Orchestrator Consolidation

### Two-Stage Design

**Stage 1: Policy Engine (deterministic, no LLM)**

Pure TypeScript function. All approve = approve. Any reject = reject. No ambiguity, no LLM call.

```typescript
function resolveDecision(
  results: ReviewerResult[],
  policy: ReviewPolicy
): { decision: FinalDecision; needsMerge: boolean } {
  const decisions = results.map(r => r.decision);

  // Any reject -> REJECT
  if (decisions.some(d => d === 'reject')) {
    const rejectorsWithNotes = results.filter(r => r.decision === 'reject' && r.notes);
    return { decision: 'reject', needsMerge: rejectorsWithNotes.length > 1 };
  }

  // Any dispute (with no rejections) -> DISPUTE
  if (decisions.some(d => d === 'dispute')) {
    return { decision: 'dispute', needsMerge: false };
  }

  // All approve -> APPROVE
  if (decisions.every(d => d === 'approve')) {
    return { decision: 'approve', needsMerge: false };
  }

  // Mix of approve/skip or all skip -> depends
  const approvals = decisions.filter(d => d === 'approve').length;
  if (approvals === 0) return { decision: 'skip', needsMerge: false };

  // Some approve, some skip -> not enough approvals
  return { decision: 'unclear', needsMerge: false };
}
```

**Stage 2: Orchestrator (LLM, only when merging notes)**

Only invoked when multiple reviewers reject and their notes need consolidation. The orchestrator:

1. **Groups** findings by file and line proximity (within 5 lines = same area)
2. **Preserves original wording** — does NOT rephrase, quotes each reviewer's actual text
3. **Orders** by file path, then line number
4. **Produces** a single checklist the coder can work through

**Critical guardrail:** The orchestrator prompt explicitly instructs:
> "Do NOT rewrite findings in your own words. You are a grouper and router, not a reviewer. Quote the original reviewer text. Your job is organization, not judgment. Do NOT drop any finding."

This prevents a weaker orchestrator model from dropping subtle findings during rewording.

### Note Merging Example

**Reviewer 1 (Codex) says:**
```
DECISION: REJECT
- [ ] [NEW] Missing null check on user.email at handler.ts:42
- [ ] [NEW] Off-by-one in pagination at paginate.ts:18
```

**Reviewer 2 (Claude) says:**
```
DECISION: REJECT
- [ ] [NEW] Potential NPE accessing email without guard at handler.ts:42
- [ ] [NEW] User input not sanitized in search.ts:55
- [ ] [NEW] Missing test for formatDate() helper
```

**Orchestrator merged output:**
```
DECISION: REJECT

## handler.ts
- [ ] Missing null/undefined check on `user.email` at line 42
  - Codex: "Missing null check on user.email at handler.ts:42"
  - Claude: "Potential NPE accessing email without guard at handler.ts:42"

## paginate.ts
- [ ] Off-by-one error in pagination logic at line 18 (Codex)

## search.ts
- [ ] Security: user input not sanitized at line 55 (Claude)

## Tests
- [ ] Missing test coverage for `formatDate()` helper (Claude)
```

---

## Decision Matrix

### Core Rule

**ALL must approve. ANY rejection blocks.**

This is the GitHub model: if you have 3 required reviewers and 2 approve but 1 requests changes, the PR is blocked.

### Complete Matrix (N Reviewers)

Rather than enumerate every pair combination, the rules are priority-based:

| Priority | Condition | Final Decision | Action |
|----------|-----------|----------------|--------|
| 1 (highest) | **Any** reviewer REJECTS | **REJECT** | Merge notes from all rejectors |
| 2 | **Any** reviewer DISPUTES (and none reject) | **DISPUTE** | Escalate to orchestrator |
| 3 | **All** reviewers APPROVE | **APPROVE** | Task complete |
| 4 | Mix of APPROVE + SKIP (no reject/dispute) | **UNCLEAR** | Retry — not enough signal |
| 5 | **All** reviewers SKIP | **SKIP** | Task skipped |

This scales to any number of reviewers without a combinatorial explosion of matrix rows.

### Decision Precedence (Highest to Lowest)

1. **REJECT** — concrete bug or issue, always wins. A single reject from any reviewer blocks the task.
2. **DISPUTE** — fundamental spec disagreement, escalated to orchestrator. The orchestrator can override a dispute only in rare cases (the reviewer is clearly wrong about the spec). This should almost never happen.
3. **APPROVE** — only wins when unanimous across all reviewers.
4. **SKIP** — reviewer can't evaluate (treated as absent). Does not count as an approval.

### Dispute Handling

Disputes are rare — they mean a reviewer thinks the task specification itself is wrong or contradictory. The orchestrator handles disputes, but its override power is tightly constrained:

- The orchestrator can dismiss a dispute **only** if the reviewer clearly misunderstood the spec
- If there's any genuine ambiguity, the dispute stands and the task is escalated to human attention
- This is an edge case safety valve, not a regular workflow path

---

## Strict Mode & Circuit Breakers

### Strict Mode (Default)

```yaml
ai:
  review:
    strict: true    # DEFAULT -- all reviewers must respond
```

| Mode | Behavior on Failure | Use Case |
|------|-------------------|----------|
| `strict: true` (default) | UNCLEAR + retry if any reviewer fails | Production, high-assurance |
| `strict: false` | Degrade to available reviewers | Development, experimentation |

**Strict is default** because the whole point of multi-review is requiring multiple opinions. Silently degrading to one undermines the guarantee.

### Degraded Mode Rules (strict: false only)

When `strict: false` and some reviewers fail:

| Succeeded | Failed | Final Decision | Rationale |
|-----------|--------|----------------|-----------|
| Any REJECT | *any failed* | **REJECT** | Rejection always stands |
| Any DISPUTE | *any failed* | **DISPUTE** | Escalation always stands |
| All APPROVE | *some failed* | **APPROVE** | Available reviewers approved |
| All SKIP | *some failed* | **UNCLEAR** | Not enough data |
| *none succeeded* | *all failed* | **UNCLEAR** | Retry next cycle |

### Circuit Breaker

Track consecutive failures per provider. If a provider fails repeatedly, temporarily disable it rather than wasting time:

```typescript
interface CircuitBreaker {
  provider: string;
  consecutive_failures: number;
  last_failure: Date;
  state: 'closed' | 'open' | 'half-open';
}

const OPEN_AFTER = 3;                // Open circuit after 3 consecutive failures
const HALF_OPEN_AFTER_MS = 300_000;  // Try again after 5 minutes
```

**Circuit states:**
- **Closed** (normal) — provider invoked as usual
- **Open** (tripped) — provider skipped, warning logged. If `strict: true`, review pauses until circuit resets
- **Half-open** (testing) — one test invocation. Success closes circuit. Failure re-opens

---

## Style Conflict Resolution

Two providers may have incompatible style preferences:
- Codex: "Use ternary expressions for simple conditionals"
- Claude: "Avoid ternaries, use if/else for clarity"

This creates nit-picking gridlock — the coder satisfies one reviewer, the other rejects.

### Resolution Rules

1. **Bug findings always stand** — all reviewers' bug reports are kept, no exceptions
2. **Style conflicts are flagged** — orchestrator marks them as `[STYLE CONFLICT]`
3. **Primary reviewer wins on style** — the first reviewer in `reviewers[]` is the "primary" voice on purely stylistic matters
4. **Coordinator intervenes on persistent style conflicts** — if the same style disagreement appears in 2+ rejection cycles, the coordinator resolves it by picking one style and instructing all reviewers to accept it

The orchestrator prompt includes:
> "If findings conflict on STYLE (not correctness), mark as [STYLE CONFLICT] and keep only the primary reviewer's preference. Never reject for style when reviewers disagree."

---

## Data Model Changes

### Audit Trail

Each reviewer invocation logs separately. The consolidated decision gets its own audit entry:

```sql
-- Each reviewer logs independently
INSERT INTO audit (task_id, action, actor, notes, ...)
VALUES (123, 'review', 'model:codex/gpt-4.1', 'APPROVE', ...);

INSERT INTO audit (task_id, action, actor, notes, ...)
VALUES (123, 'review', 'model:claude/claude-sonnet-4', 'REJECT: ...', ...);

INSERT INTO audit (task_id, action, actor, notes, ...)
VALUES (123, 'review', 'model:gemini/gemini-2.5-pro', 'APPROVE', ...);

-- Orchestrator consolidated decision
INSERT INTO audit (task_id, action, actor, notes, ...)
VALUES (123, 'reject', 'orchestrator:multi-review', 'Consolidated: 2 approve, 1 reject', ...);
```

### Invocation Logging

Each reviewer invocation is logged via `logInvocation()` with indexed role:

```typescript
reviewerConfigs.forEach((config, i) => {
  logInvocation({
    role: `reviewer:${i}`,
    provider: config.provider,
    model: config.model,
    duration_ms: results[i].duration,
  });
});
```

### No Schema Migration Required

The existing audit and invocation tables handle multi-reviewer data. The `actor` field already contains the model name, and multiple audit entries per review cycle are already supported (coordinator + reviewer entries exist today).

---

## Prompt Changes

### Reviewer Prompt (No Changes)

Each reviewer receives the **same prompt** as today. They are unaware that other reviewers exist. Independence is the entire point.

### Post-Reviewer Orchestrator Prompt (Extended)

The orchestrator prompt adds a multi-reviewer section when merging notes:

```
## Multi-Reviewer Consolidation

You are receiving rejection notes from {N} independent reviewers.
The DECISION is already REJECT. Your job is to MERGE THE NOTES into a single checklist.

{for each reviewer}
### Reviewer {i} ({provider}/{model})
<stdout>
{reviewer_stdout}
</stdout>
{end for}

### Your Task
1. Group findings by file path, then by line proximity (within 5 lines = same area)
2. When multiple reviewers flag the same issue, consolidate and note it was caught by multiple
3. Do NOT rewrite findings -- quote the original reviewer text verbatim
4. Do NOT add your own findings -- you are a grouper, not a reviewer
5. Do NOT drop any finding, even if it seems minor
6. If findings conflict on STYLE (not correctness), mark as [STYLE CONFLICT]
   and keep only the primary reviewer's preference (Reviewer 0 is primary)
7. Order: file path -> line number
8. Use checkbox format: - [ ] Finding text (reviewer name)
```

### Coder Prompt (Minor Addition)

When the coder receives merged rejection feedback:

```
## Review Feedback

This task was reviewed by {N} independent reviewers.
The findings below are consolidated -- address ALL items.
```

The coder does not need to know which specific providers participated. The feedback is just facts: here are the problems, fix them.

---

## Edge Cases

### 1. Same Issue, Different Wording

Two reviewers flag the same issue differently:
- Reviewer 1: "Missing null check on `user.email` at line 42"
- Reviewer 2: "Potential NPE accessing email property without guard at handler.ts:42"

The orchestrator groups by file + line proximity and consolidates, quoting both wordings.

### 2. Conflicting Technical Feedback

One reviewer approves a pattern, another rejects it:
- Reviewer 1: "Good use of early returns"
- Reviewer 2: "Too many early returns, refactor to single exit point"

If **style** → marked `[STYLE CONFLICT]`, primary reviewer wins.
If **correctness** → the rejection stands (conservative).

### 3. Credit Exhaustion Mid-Review

- Provider's `classifyResult()` returns `credit_exhaustion`
- Circuit breaker increments failure count
- If `strict: true` → UNCLEAR, retry next cycle
- If `strict: false` → degrade to available reviewers
- Warning logged

### 4. Vastly Different Review Depths

One reviewer writes 3 lines, another writes 300. Both are valid. A short "APPROVE" is fine. Verbose rejection notes are preserved in full.

### 5. Timeout Asymmetry

`Promise.allSettled()` waits for all reviewers (up to 600s each). The fastest result is held until the slowest completes or times out.

### 6. Coordinator Guidance in Multi-Review Mode

Coordinator guidance flows to **all** reviewers equally. No reviewer gets special treatment.

### 7. Rejection Count

A multi-review rejection counts as **one rejection** (not per-reviewer). The count tracks review cycles. This prevents multi-review from hitting the failure threshold (15) faster than single review.

### 8. Context Window Pressure

The orchestrator ingests all reviewer outputs. Mitigations:
- Use a capable orchestrator model
- Truncate reviewer output beyond 10,000 chars per reviewer (keep decision + first N findings)
- Log a warning if combined input approaches context limits

### 9. Many Reviewers, One Slow Provider

With 5 reviewers, 4 finish in 30s but one takes 9 minutes. `Promise.allSettled()` waits for all. This is acceptable — the user opted into multi-review and the timeout (600s) is the contract. If a provider is consistently slow, the circuit breaker will flag it but not disable it (slowness is not failure).

---

## UI/UX: Managing Reviewers

Reviewers must be manageable from **three surfaces**: the CLI AI setup wizard, the WebUI settings page, and the init wizard. All three need the same capabilities: add reviewers, remove reviewers, reorder reviewers (first = primary for style conflicts).

### Design Principle

At least one reviewer must always exist — the user cannot delete the last reviewer. Additional reviewers can be added or removed freely. The UI must make the array nature obvious: a list of reviewer slots with add/remove controls.

### 1. CLI: `steroids config ai reviewer`

**Current behavior:** Interactive TUI wizard that sets a single reviewer (provider + model).

**New behavior:** The wizard manages the `reviewers[]` array.

```
┌─────────────────────────────────────────────┐
│          Configure Reviewers                │
│                                             │
│  Reviewers (all must approve):              │
│                                             │
│  1. codex / gpt-4.1              [x]        │
│  2. claude / claude-sonnet-4     [x]        │
│  3. gemini / gemini-2.5-pro      [x]        │
│                                             │
│  [+] Add reviewer                           │
│                                             │
│  [↑/↓] Navigate  [x] Remove  [+] Add       │
│  [Enter] Edit provider/model  [q] Done      │
└─────────────────────────────────────────────┘
```

**Interactions:**
- **Arrow keys** — navigate the reviewer list
- **Enter** — edit the selected reviewer (opens provider → model selection flow)
- **`+` or `a`** — add a new reviewer slot (opens provider → model selection)
- **`x` or `d` or `Delete`** — remove the selected reviewer (blocked if only one remains)
- **`q` or `Esc`** — save and exit

**Removing the last reviewer:**
```
┌──────────────────────────────────────┐
│  Cannot remove the last reviewer.   │
│  At least one reviewer is required. │
└──────────────────────────────────────┘
```

**Adding a reviewer with a duplicate provider:**
```
┌──────────────────────────────────────────────┐
│  Provider "claude" is already in the list.   │
│  Each reviewer must use a different provider.│
└──────────────────────────────────────────────┘
```

**Non-interactive mode:**
```bash
# Add a reviewer
steroids config ai reviewer --add -p gemini -m gemini-2.5-pro

# Remove a reviewer by provider name
steroids config ai reviewer --remove gemini

# List current reviewers
steroids config ai reviewer --list

# Set the full array at once (replaces all)
steroids config ai reviewer --set "codex:gpt-4.1,claude:claude-sonnet-4"
```

### 2. WebUI: Settings Page & Project Settings

**Current behavior:** `AIRoleSettings` component shows a single provider/model selector for the reviewer role.

**New behavior:** The reviewer section becomes a dynamic list with add/remove controls.

```
┌─────────────────────────────────────────────────────┐
│  Reviewers                                          │
│  All configured reviewers must approve each review. │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 1. Codex          gpt-4.1            [bin]  │    │
│  ├─────────────────────────────────────────────┤    │
│  │ 2. Claude         claude-sonnet-4     [bin]  │    │
│  ├─────────────────────────────────────────────┤    │
│  │ 3. Gemini         gemini-2.5-pro      [bin]  │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  [+ Add Reviewer]                                   │
│                                                     │
│  Note: First reviewer is primary for style conflicts│
└─────────────────────────────────────────────────────┘
```

**Components:**
- Each reviewer row shows: provider name, model name, trash bin icon (delete button)
- Trash bin is **disabled/hidden** when only one reviewer remains
- `[+ Add Reviewer]` button opens the provider → model selection flow (same `AIRoleSettings` component, reused)
- Clicking a row opens inline edit for provider/model
- Drag handle (optional) for reordering — first position = primary reviewer
- Provider dropdown filters out already-used providers

**Project-level override:**
- Same "Inherited" vs "Custom" toggle as today
- When "Custom", shows the full reviewer list with add/remove
- When "Inherited", shows the global reviewer list as read-only with a note: "Inherited from global config"

### 3. Init Wizard: `steroids init`

**Current behavior:** During init, the AI setup wizard asks for a single reviewer provider/model.

**New behavior:** After setting up the coder, the wizard asks about reviewers.

```
┌─────────────────────────────────────────────────┐
│          AI Setup - Reviewers                   │
│                                                 │
│  How many reviewers should approve each task?   │
│                                                 │
│  > Single reviewer (default)                    │
│    Multiple reviewers (all must approve)        │
│                                                 │
│  [↑/↓] Select  [Enter] Continue                │
└─────────────────────────────────────────────────┘
```

If "Multiple reviewers" is selected:

```
┌──────────────────────────────────────────────────┐
│          Configure Reviewers                     │
│                                                  │
│  Select providers for code review.               │
│  All must approve before a task is complete.     │
│                                                  │
│  Reviewer 1:                                     │
│    Provider: [codex    v]  Model: [gpt-4.1    v] │
│                                                  │
│  Reviewer 2:                                     │
│    Provider: [claude   v]  Model: [sonnet-4   v] │
│                                                  │
│  [+ Add another reviewer]                        │
│                                                  │
│  [Enter] Save  [Esc] Back                        │
└──────────────────────────────────────────────────┘
```

**With `--yes` flag:** Skips the wizard entirely, uses defaults (single reviewer: claude).

**Non-interactive init with multi-review:**
```bash
steroids init --reviewers "codex:gpt-4.1,claude:claude-sonnet-4"
```

### 4. CLI: Direct Config Commands

For users who prefer direct manipulation over the wizard:

```bash
# View current reviewers
steroids config get ai.reviewers
# Output:
# - codex / gpt-4.1
# - claude / claude-sonnet-4

# Set the full array (replaces existing)
steroids config set ai.reviewers '[{"provider":"codex","model":"gpt-4.1"},{"provider":"claude","model":"claude-sonnet-4"}]'

# Or use the shorthand via the wizard
steroids config ai reviewer
```

### Files to Modify

| File | Change |
|------|--------|
| `src/config/ai-setup.ts` | Extend reviewer wizard to manage array with add/remove |
| `src/commands/config.ts` | Add `--add`, `--remove`, `--list`, `--set` flags for reviewer |
| `src/commands/init.ts` | Add multi-reviewer question to init flow |
| `WebUI/src/components/settings/AIRoleSettings.tsx` | Support array mode with add/remove/reorder |
| `WebUI/src/components/onboarding/AISetupModal.tsx` | Add multi-reviewer step |
| `WebUI/src/pages/SettingsPage.tsx` | Wire up array-based reviewer settings |
| `API/src/routes/config.ts` | Handle `reviewers[]` array in PUT endpoint |

---

### Phase 1: Config & Plumbing
1. Add `reviewers` array and `review` policy to `SteroidsConfig` in `src/config/loader.ts`
2. Add config loading with backward compatibility (`reviewer` singular still works)
3. Add validation: unique providers, min 2 entries
4. Add `isMultiReviewEnabled()` and `getReviewerConfigs()` helpers
5. Add env var parsing for `STEROIDS_AI_REVIEWERS`

### Phase 2: Parallel Invocation
6. Refactor `invokeReviewer()` to accept `ReviewerConfig` as parameter (not read from global config)
7. Create `invokeReviewers()` that calls all in parallel via `Promise.allSettled()`
8. Define `MultiReviewerContext` type
9. Update invocation logging to use `reviewer:N` role naming

### Phase 3: Policy Engine
10. Implement `resolveDecision()` — pure function, priority-based rules
11. Unit test all decision combinations
12. Implement circuit breaker for provider failures

### Phase 4: Orchestrator Consolidation
13. Create multi-reviewer orchestrator prompt template (grouper/router, not rewriter)
14. Extend `invokeReviewerOrchestrator()` to accept `MultiReviewerContext`
15. Add style conflict detection and primary-reviewer-wins logic
16. Add context window pressure detection and truncation

### Phase 5: Loop Integration
17. Update `runReviewerPhase()` to detect multi-review mode and branch
18. Add pre-flight provider availability check with strict/lenient handling
19. Update audit trail entries for multi-review
20. Update coder prompt to show consolidated feedback (no reviewer names)

### Phase 6: CLI UI
21. Extend `steroids config ai reviewer` wizard to manage `reviewers[]` array
22. Add `--add`, `--remove`, `--list`, `--set` flags to reviewer config command
23. Update init wizard with single vs multi-reviewer question
24. Add `--reviewers` flag to `steroids init` for non-interactive setup

### Phase 7: WebUI
25. Extend `AIRoleSettings` component to support array mode (add/remove/reorder)
26. Update `AISetupModal` with multi-reviewer step
27. Update `SettingsPage` to wire up array-based reviewer settings
28. Update API `PUT /api/config` to handle `reviewers[]` array
29. Add project-level reviewer override (inherited vs custom toggle)

### Phase 8: Testing
30. Unit tests for `resolveDecision()` — all priority rules
31. Unit tests for circuit breaker state transitions
32. Unit tests for note merging / deduplication
33. Integration test: all approve flow
34. Integration test: split decision (some approve, one reject)
35. Integration test: strict mode (one failure -> UNCLEAR -> retry)
36. Integration test: lenient mode (one failure -> degrade)
37. Integration test: 3+ reviewers
38. UI test: add/remove reviewer in CLI wizard
39. UI test: cannot delete last reviewer

---

## Resolved Design Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Should the coder know which providers reviewed? | **No** — facts only | The coder gets a list of problems to fix. Who found them is irrelevant. "Is there a problem or not?" is what matters. |
| 2 | Should we cap the number of reviewers? | **No cap** | The `reviewers[]` array accepts any number. Users decide how many opinions they want. More reviewers = more cost, but that's their choice. |
| 3 | Should degraded mode be opt-in? | **Yes — strict by default** | `strict: true` is the default. Multi-review means all must respond. Users opt into `strict: false` for lenient mode. |
| 4 | Cost concerns? | **Out of scope** | A separate cost-tracking feature handles this. Multi-review is N reviewers = Nx cost. Users accept this when they configure multiple reviewers. |
| 5 | Should reviewers see each other's output? | **No — independence** | Reviewers must be completely independent. No awareness of each other. |
| 6 | Should coordinator thresholds change? | **Keep same for now** | Keep [2, 5, 9] thresholds. Recalibrate after collecting real data on multi-reviewer disagreement rates. |
| 7 | Dispute override by orchestrator? | **Rare edge case only** | The orchestrator can dismiss a dispute only if a reviewer clearly misunderstood the spec. This should almost never happen. The default is: dispute = escalate to human. |

---

## Open Questions

1. **Per-reviewer timeout overrides.** Should each reviewer have its own timeout? Some providers are consistently slower. Could add `timeout` to `ReviewerConfig`, defaulting to 600s.

2. **Primary reviewer selection.** Currently, the first entry in `reviewers[]` is "primary" for style conflicts. Should this be a separate config field for clarity, or is array order sufficient?

3. **Same provider, different models.** The current validation prevents two entries with the same provider. But should we allow e.g. `claude:sonnet` + `claude:opus` as two reviewers? Different models from the same provider could still provide independent perspectives.
