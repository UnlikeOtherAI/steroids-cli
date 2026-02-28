# Controller CLI Design: `steroids-ctl`

> **Status:** Proposal — cross-provider review complete, pending decision
> **Date:** 2026-02-28

## Problem Statement

The current system communicates with blackbox AI CLIs (Claude, Codex, Gemini, etc.) through **signal tokens embedded in free text** (`STATUS: REVIEW`, `DECISION: APPROVE`). This requires:

1. **Signal parsing** — regex extraction of tokens from the AI's text output, with code-block stripping to avoid false positives
2. **Post-hoc orchestrator invocation** — a separate LLM call to interpret the AI's output and validate the decision

This works, but has inherent fragility:

- Signal tokens can be missed, malformed, or appear in unexpected locations
- The AI has no way to validate preconditions before signaling (e.g., are commits clean?)
- Information between sessions flows only through rejection notes and coordinator guidance, reconstructed from the audit trail
- Adding new structured data channels requires new parsing logic each time

## Current Behavior

### Signal Flow (Coder)
```
AI writes free text → includes "STATUS: REVIEW" somewhere in output
    → signal-parser.ts extracts STATUS, REASON, CONFIDENCE via regex
    → post-coder orchestrator (separate LLM call) validates the decision
    → loop acts on the result
```

### Signal Flow (Reviewer)
```
AI writes free text → includes "DECISION: APPROVE" somewhere in output
    → signal-parser.ts extracts DECISION, NOTES via regex
    → post-reviewer orchestrator (separate LLM call) validates the decision
    → loop acts on the result
```

### Key files
- `src/orchestrator/signal-parser.ts` — regex-based signal extraction
- `src/orchestrator/post-coder.ts` — orchestrator that interprets coder output
- `src/orchestrator/post-reviewer.ts` — orchestrator that interprets reviewer output
- `src/commands/loop-phases-coder.ts` — coder phase execution
- `src/commands/loop-phases-reviewer.ts` — reviewer phase execution

## Desired Behavior

Replace signal tokens with **explicit CLI calls** that the AI makes during its session. The AI calls a controller CLI (`steroids-ctl`) to signal state transitions. The CLI validates preconditions and writes structured data to a sidecar file. The loop reads the sidecar after invocation completes.

### Signal Flow (Proposed)
```
AI runs: steroids-ctl signal review --confidence high --reason "implemented feature"
    → steroids-ctl validates preconditions (e.g., commits clean)
    → writes structured record to .steroids/ctl-state/{task-id}.json
    → loop reads sidecar file after invocation completes
    → loop acts on the structured result (no second LLM call needed)
```

## Design

### Architecture Overview

Two separate tools the AI can call during its session:

1. **`steroids-ctl`** — narrow scope: signal state transitions, check preconditions, retrieve context. Does not touch the database directly. Writes to a sidecar file that the loop reads and validates.

2. **Existing memory CLI** — already built, handles long-term memory persistence. The AI is told about it in the prompt and calls it directly. No wrapping needed.

### Command Set

```
steroids-ctl signal <state> [options]
    States: review, error, retry
    Options: --confidence high|medium|low
             --reason "..."
             --commit-message "..."

steroids-ctl check commits
    Returns exit code 0 if working tree is clean, 1 if dirty.
    Stdout: summary of uncommitted changes (if any).

steroids-ctl context [key]
    Retrieves context for the current task:
    - rejection-notes: previous rejection feedback
    - coordinator-guidance: guidance from coordinator
    - sibling-tasks: other tasks in the same section
    - task-info: current task metadata
```

### Sidecar File Format

Location: `.steroids/ctl-state/{task-id}.json`

```json
{
  "signals": [
    {
      "type": "review",
      "confidence": "high",
      "reason": "Implemented the feature as specified",
      "commit_message": "feat: add user auth endpoint",
      "timestamp": "2026-02-28T14:32:17Z"
    }
  ],
  "checks": [
    {
      "type": "commits",
      "clean": true,
      "timestamp": "2026-02-28T14:32:15Z"
    }
  ]
}
```

### Precondition Validation

When `steroids-ctl signal review` is called, the CLI can:

1. Check if the working tree is clean (no uncommitted changes)
2. Check if there are actual commits since the task baseline
3. Refuse to accept the signal if preconditions fail (non-zero exit code + error message)

This moves validation **before** the signal is recorded, rather than discovering problems during post-processing.

### Prompt Integration

Add to coder/reviewer prompts:

```
## Tools Available

You have access to `steroids-ctl` for communicating status:

- When you're done with your work: `steroids-ctl signal review --confidence high --reason "..."`
- To check if your commits are clean: `steroids-ctl check commits`
- To retrieve task context: `steroids-ctl context rejection-notes`

Always run `steroids-ctl check commits` before signaling review.
Always signal your status before finishing. Do not use STATUS: or DECISION: text tokens.
```

### Fallback Strategy

During transition (and as a permanent safety net):

1. Loop first checks for sidecar file (`.steroids/ctl-state/{task-id}.json`)
2. If sidecar exists and has signals → use structured data, skip orchestrator LLM call
3. If sidecar is empty or missing → fall back to existing signal parsing + orchestrator
4. Log which path was taken for observability

**Precedence:** Sidecar always wins over parsed text signals if both exist.

### Reviewer Adaptation

The reviewer can use the same CLI:

```
steroids-ctl signal approve --confidence high --notes "Clean implementation"
steroids-ctl signal reject --notes "Missing error handling in auth endpoint"
steroids-ctl signal dispute --reason "Requirements are ambiguous"
steroids-ctl signal skip --reason "Requires external API setup"
```

## Implementation Order

### Phase 1: Core CLI skeleton
- Create `steroids-ctl` as a lightweight Node.js CLI (or shell script)
- Implement `signal` command with sidecar file writing
- Implement `check commits` command
- No database access, no complex logic

### Phase 2: Loop integration
- Modify loop to check sidecar file before signal parsing
- Implement fallback logic (sidecar → signal parsing)
- Add logging for which path was used

### Phase 3: Prompt updates
- Update coder prompts to instruct AI to use `steroids-ctl`
- Update reviewer prompts similarly
- Keep signal token instructions as fallback documentation

### Phase 4: Context command
- Implement `steroids-ctl context` subcommands
- Wire up to database reads (read-only)
- Add to prompts

### Phase 5: Deprecate orchestrator post-processing
- Once sidecar adoption is high (measurable via logs), reduce reliance on post-coder/post-reviewer orchestrator calls
- Keep as fallback but skip the LLM call when sidecar data is present

## Edge Cases

| Scenario | Handling |
|----------|----------|
| AI never calls `steroids-ctl` | Fallback to signal parsing (existing behavior) |
| AI calls `steroids-ctl signal review` but has uncommitted changes | CLI refuses signal, returns non-zero exit code with error message |
| AI calls `steroids-ctl signal` multiple times | Last signal wins (overwrite, not append) |
| Process crashes after `steroids-ctl signal` but before AI session ends | Signal is recorded; loop validates git state independently before acting |
| Sidecar file is corrupted / malformed JSON | Fallback to signal parsing, log warning |
| AI calls `steroids-ctl` with wrong arguments | CLI prints usage help, returns non-zero exit code |
| Task ID not available to the CLI | Passed via environment variable (`STEROIDS_TASK_ID`) set by the loop before provider invocation |

## Non-Goals

- **Not a general-purpose tool framework.** The command set is fixed and small. The AI cannot compose arbitrary operations.
- **Not a database client.** The CLI does not write to the database. It writes to sidecar files that the loop processes.
- **Not a replacement for the memory CLI.** Long-term memory is handled by the existing, separate memory tool.
- **Not real-time IPC.** The sidecar is read after invocation completes, not during. No sockets, no pipes, no watchers for v1.

## Additional Requirements

### Bulletproof Help at Every Level

`steroids-ctl` must have comprehensive, maintained help text at every command level. This is the primary interface an AI agent will use to learn the tool. If the help is wrong or stale, the AI will misuse the tool.

```
steroids-ctl --help              # top-level: list all commands
steroids-ctl signal --help       # signal: list all states and options
steroids-ctl check --help        # check: list all check types
steroids-ctl context --help      # context: list all context keys
```

Every help screen must include:
- Usage syntax with all options
- Description of what the command does
- Examples of correct invocation
- Exit codes and their meanings
- Error conditions and how to resolve them

### Update `steroids llm` Command

The `steroids llm` command (`src/commands/llm.ts`) is how LLM agents learn about the system. When `steroids-ctl` is implemented, `steroids llm` must be updated to:

1. Document `steroids-ctl` commands and their purpose
2. Show examples of correct usage in the coder and reviewer workflow
3. Explain the signaling protocol (when to signal, what preconditions to check)
4. Include `steroids-ctl` in the JSON output schema (`--json` flag)

This is part of the implementation, not a follow-up. The feature is incomplete until the LLM can discover it via `steroids llm`.

## Open Questions

1. Should `steroids-ctl` be a separate binary, a subcommand of `steroids`, or a standalone script?
2. Should the sidecar file be per-invocation (new file each time) or per-task (overwritten)?
3. How is `STEROIDS_TASK_ID` passed to the AI's shell environment? (Likely via the provider's env setup in `invoke()`)
4. Should the reviewer's `signal approve` also trigger git push, or should that remain in the loop?

---

## Cross-Provider Adversarial Review

### Reviewer: Codex (gpt-5.3-codex)

**Review date:** 2026-02-28
**Mode:** Non-interactive (`codex exec`), strict adversarial persona per AGENTS.md

---

### Finding 1: Command Contract Is Self-Contradictory
**Severity:** Critical
**Finding:** The command spec defines `signal` states as `review|error|retry` (coder), but reviewer examples use `approve|reject|dispute|skip`. The `--reason` flag in the coder section becomes `--notes` in the reviewer section. This is not implementable as written.
**Refs:** `controller-cli-design.md:71-75`, `controller-cli-design.md:157`

**Assessment: ADOPT.** This is a genuine spec error. The command set needs to be role-aware or unified. Fix: define a single `signal` command with a unified state set (`review`, `error`, `retry`, `approve`, `reject`, `dispute`, `skip`) and use `--reason` consistently. The loop knows the role and validates which states are valid for coder vs. reviewer.

---

### Finding 2: "Clean Tree Required" Regresses Current Submission Flow
**Severity:** Critical
**Finding:** The proposal rejects `signal review` when uncommitted changes exist, but the current loop intentionally supports completion with uncommitted work and stages/commits it via `stage_commit_submit`. This would reject legitimate successful runs.
**Refs:** `controller-cli-design.md:118`, `loop-phases-coder.ts:293-314`

**Assessment: ADOPT.** This is a real regression. The precondition should NOT require a clean tree. Instead, `steroids-ctl signal review` should record the signal regardless of git state. The loop's existing `stage_commit_submit` flow handles staging/committing after the signal. The `check commits` command remains available for the AI to use optionally, but it is not a gate on signaling.

---

### Finding 3: Drops Existing Quality Gates Enforced by Post-Coder Orchestrator
**Severity:** High
**Finding:** The post-coder orchestrator enforces checklist/rejection-response contracts and WONT_FIX scrutiny. Skipping the orchestrator LLM call when sidecar exists removes these gates.
**Refs:** `post-coder.ts:149-169`, `controller-cli-design.md:146`

**Assessment: PARTIALLY ADOPT.** The concern is valid but overstated. The post-coder orchestrator's primary job is interpreting ambiguous output — which the sidecar eliminates. The checklist and WONT_FIX scrutiny can be enforced as **preconditions in `steroids-ctl`** (check that the AI actually addressed rejection items before accepting `signal review` after a rejection). However, this needs explicit design work in Phase 2, not hand-waving. **Defer to Phase 2 spec.**

---

### Finding 4: Reviewer Architecture Regression (Multi-Reviewer Merge + Follow-Ups)
**Severity:** High
**Finding:** Current reviewer flow supports multi-review decision logic (`resolveDecision`), merge orchestration, and follow-up task creation. The "last signal wins" sidecar model does not preserve multi-reviewer structure.
**Refs:** `loop-phases-reviewer-resolution.ts:45-65`, `loop-phases-reviewer.ts:375`

**Assessment: ADOPT.** The sidecar model must support multi-reviewer. Fix: sidecar file is per-invocation (keyed by `{task-id}-{invocation-id}.json`), not per-task. The loop collects all sidecar files for a given task's review cycle and feeds them into the existing `resolveDecision` logic. Follow-up tasks should be extracted from the sidecar's `notes` field by the loop, not by the CLI.

---

### Finding 5: Sidecar Precedence Creates Stale-State and Race Hazards
**Severity:** High
**Finding:** Sidecar path is per-task with no invocation ID, freshness check, or cleanup. A stale file from a prior attempt can override current session output.
**Refs:** `controller-cli-design.md:91`, `controller-cli-design.md:145-150`

**Assessment: ADOPT.** Fix: sidecar files are per-invocation, named `{task-id}-{invocation-id}.json`. The loop cleans up sidecar files before starting each invocation. The invocation ID is passed via `STEROIDS_INVOCATION_ID` environment variable alongside `STEROIDS_TASK_ID`. This eliminates stale-state issues.

---

### Finding 6: Type Safety Is Weaker Than Current Orchestrator Path
**Severity:** Medium
**Finding:** The sidecar schema is unversioned and not tied to typed runtime validation. Malformed JSON just falls back, hiding corruption.
**Refs:** `controller-cli-design.md:89-111`

**Assessment: ADOPT.** Fix: define a TypeScript interface for the sidecar schema. Validate with zod on read. Include a `schema_version` field. Reject (don't silently fallback) on schema mismatch — a schema mismatch means the CLI and loop are out of sync, which is a deployment error, not an AI error.

---

### Finding 7: Task-ID Environment Dependency Is Not Implementable in Current Provider Contract
**Severity:** High
**Finding:** `InvokeOptions` does not expose arbitrary env injection. The provider `invoke()` and `base-runner.ts` pass fixed options only. `STEROIDS_TASK_ID` cannot be injected without modifying the provider interface.
**Refs:** `interface.ts:14`, `base-runner.ts:49`, `codex.ts:286`

**Assessment: ADOPT.** This is a concrete integration gap. Fix: add `env?: Record<string, string>` to `InvokeOptions`. The base runner passes `{ STEROIDS_TASK_ID, STEROIDS_INVOCATION_ID, STEROIDS_PROJECT_PATH }` to each invocation. Each provider merges these into its sanitized env. This is a small, focused change to `interface.ts` and each provider's spawn logic.

---

### Finding 8: DB/Isolation Story Is Contradictory
**Severity:** Medium
**Finding:** The design says "does not touch the database directly" but Phase 4 wires `context` to DB reads. This reverses the stated boundary.
**Refs:** `controller-cli-design.md:64`, `controller-cli-design.md:182-183`

**Assessment: DEFER.** The `context` command is Phase 4 and can be scoped separately. For Phase 1-3, the CLI writes sidecar files only — no DB access. When `context` is designed, it can either read the DB directly (read-only is acceptable) or read from a context file that the loop pre-generates before invocation. Defer this decision to Phase 4 design.

---

### Reviewer: Claude (claude-opus-4-6)

**Review date:** 2026-02-28
**Mode:** Task agent (`general-purpose`), strict adversarial persona per AGENTS.md

---

### Finding C1: Proposal Mischaracterizes the Existing Architecture's Role
**Severity:** Critical
**Finding:** The design frames the problem as "signal tokens can be missed/malformed" but the actual codebase shows signal parsing is highly reliable (simple regex: `/STATUS:\s*(REVIEW|RETRY|ERROR)/i`). The real fragility is in the orchestrator's *interpretation* (judgment calls about completeness, rejection responses). `steroids-ctl` replaces "will the AI emit the right text token" with "will the AI call the right CLI command" — the trust assumption is identical, just expressed differently. The proposal may be solving a phantom problem.

**Assessment: ACKNOWLEDGED but DISAGREE on framing.** The signal tokens *are* reliable in isolation, but the proposal's value isn't just signal reliability — it's **eliminating the post-hoc orchestrator LLM call** (cost, latency, its own parse failures via `OrchestrationFallbackHandler`) and **enabling precondition checks at signal time**. However, Claude is right that the Problem Statement should be rewritten to state the actual motivation more honestly. The text-token reliability argument is weak; the orchestrator-elimination and precondition-validation arguments are strong.

---

### Finding C2: `steroids-ctl` Availability in AI Provider Environments
**Severity:** Critical
**Finding:** The AI is spawned with sanitized env and isolated HOME. `steroids-ctl` must be discoverable in PATH within this environment. Some providers (Codex) may run in sandboxed environments where arbitrary CLI tools are unavailable. The design doesn't specify how `steroids-ctl` gets into PATH across all providers and isolation modes.

**Assessment: ADOPT.** This is a real implementation gap. Fix: `steroids-ctl` must be a subcommand of `steroids` (i.e., `steroids ctl signal ...`), not a separate binary. Since `steroids` is already globally installed and in PATH, this guarantees availability. Open Question 1 is resolved: it's a subcommand.

---

### Finding C3: Loss of Orchestrator Intelligence Creates Edge Case Regression
**Severity:** Critical
**Finding:** The post-coder orchestrator handles: (1) timeout with partial work → save progress as REVIEW, (2) no-work detection → RETRY, (3) conflicting signals → RETRY. With `steroids-ctl`, if the AI times out before calling the CLI, there's NO sidecar signal. The orchestrator validates the AI's self-assessment against objective evidence (git state, exit codes, stderr). A sidecar only captures the AI's own claim. Claude explicitly disagrees with the Codex F3 assessment: "The orchestrator's primary job is independent validation, not interpreting ambiguous output."

**Assessment: PARTIALLY ADOPT.** Claude is right that the orchestrator does independent validation, not just ambiguity resolution. The sidecar does NOT replace this. However, the fix is not to keep the orchestrator — it's to move the objective validation (git state checks, exit code analysis, stderr scanning) into the loop's sidecar-reading logic. When the loop reads a sidecar with `signal: review`, it still runs the same git-state and exit-code checks that `post-coder.ts` currently runs. The difference: these checks are deterministic code, not an LLM call. The orchestrator LLM call is only needed for *judgment* calls, which we accept losing. **Update Codex F3 assessment to acknowledge this is more significant than "overstated."**

---

### Finding C4: Two Parallel Signal Paths Permanently Increase Complexity
**Severity:** High
**Finding:** The "permanent safety net" fallback creates a dual-path architecture that violates AGENTS.md Simplification First: "Two code paths that answer the same invariant question must share one source of truth." Every signal-related change must be validated against both paths. Bug reports require diagnosing which path was taken.

**Assessment: PARTIALLY ADOPT.** The concern about permanent dual-path is valid. Fix: the fallback is a **transition mechanism with a deprecation timeline**, not a permanent feature. After N releases where sidecar adoption is >95% (measurable via existing invocation logs), remove the signal-parsing fallback entirely. Add a concrete deprecation milestone to Phase 5.

---

### Finding C5: Edge Case Table Contradicts Per-Invocation Fix
**Severity:** Medium
**Finding:** The Edge Cases table says "last signal wins (overwrite)" with per-task file paths, but the accepted Codex findings changed to per-invocation. The design doc was never updated to incorporate accepted findings, making it internally inconsistent.

**Assessment: ADOPT.** The design doc needs a post-review revision pass to incorporate all accepted changes into the main spec text, not just in the review appendix.

---

### Finding C6: No Evidence That CLI Calls Are More Reliable Than Text Tokens
**Severity:** High
**Finding:** No data comparing current signal token emission success rate vs. expected CLI invocation success rate. CLI calls can fail for reasons outside the AI's control (PATH, permissions, shell quoting). The mandatory `check commits` precondition step adds a step the AI may forget. The proposal may actually reduce signal reliability.

**Assessment: ACKNOWLEDGED.** This is a valid concern. However, the primary motivation is not reliability improvement — it's eliminating the orchestrator LLM call and enabling precondition checks. The reliability argument in the Problem Statement should be deprioritized. Add to Phase 1: measure actual `steroids ctl` invocation success rate and compare against text-token signal rate from logs.

---

### Finding C7: Context Command Replicates What Prompt Already Provides
**Severity:** Medium
**Finding:** All context data (`rejection-notes`, `coordinator-guidance`, `sibling-tasks`) is already injected into the prompt at invocation time. The context command is only useful if the AI's context window overflows.

**Assessment: ADOPT.** Phase 4 (`context` command) is dropped from scope. If context window issues arise, the solution is prompt optimization, not a CLI tool re-fetching the same data. Remove Phase 4 from the implementation plan.

---

### Finding C8: Sidecar File Cleanup Race with Pool Workspaces
**Severity:** High
**Finding:** In pool workspace mode, the effective project path is `poolSlotContext.slot.slot_path`. Sidecar files in `.steroids/ctl-state/` could be lost if the pool slot is cleaned up or reassigned. `prepareForTask` and `postCoderGate` don't know about sidecar files.

**Assessment: ADOPT.** The sidecar directory must be in the pool slot's `.steroids/` path, and pool lifecycle functions (`prepareForTask`, `postCoderGate`) must be updated to handle sidecar cleanup. Add this to Phase 2 requirements.

---

### Finding C9: Session Resumption Creates Mixed-Generation Sessions
**Severity:** Medium
**Finding:** Resumed sessions from before `steroids-ctl` deployment won't know about it. The original invocation prompt didn't include `steroids-ctl` instructions.

**Assessment: ADOPT.** Fix: when resuming a session, check if the original invocation included `steroids-ctl` instructions. If not, include them in the delta prompt. This is a small addition to `generateResumingCoderDeltaPrompt` and `generateResumingReviewerDeltaPrompt`.

---

### Claude's Agreement/Disagreement with Codex Findings

| Codex Finding | Claude's Take |
|---------------|---------------|
| F1: Self-contradictory contract | **Agrees** with finding and assessment |
| F2: Clean tree regression | **Agrees** with finding and assessment |
| F3: Drops quality gates | **Disagrees** with assessment — says concern is *understated*, not overstated |
| F4: Multi-reviewer regression | **Agrees** with finding and assessment |
| F5: Stale-state hazards | **Agrees**, adds pool workspace concerns (Finding C8) |
| F6: Type safety | **Mostly agrees**, disagrees with hard rejection — prefers fallback + error log |
| F7: Env injection | **Agrees** — calls this the one genuinely low-risk improvement |
| F8: DB isolation | **Agrees** with deferral, adds that context command may not be needed at all (Finding C7) |

---

### Summary of All Actions (Both Reviews)

| Finding | Decision | Action |
|---------|----------|--------|
| Codex F1: Self-contradictory command contract | **Adopt** | Unify signal states, use `--reason` consistently |
| Codex F2: Clean tree requirement regresses flow | **Adopt** | Remove clean-tree precondition from `signal` |
| Codex F3: Drops post-coder quality gates | **Revise** | Move objective validation (git state, exit code) into loop sidecar-reading logic; accept losing LLM judgment calls |
| Codex F4: Multi-reviewer regression | **Adopt** | Per-invocation sidecar files, preserve `resolveDecision` |
| Codex F5: Stale-state and race hazards | **Adopt** | Per-invocation file naming + cleanup before invocation |
| Codex F6: Weak type safety | **Adopt (modified)** | Zod schema + version field; log error + fallback on mismatch (not hard reject) |
| Codex F7: Env injection not in provider contract | **Adopt** | Add `env` to `InvokeOptions` |
| Codex F8: DB isolation contradiction | **Defer** | Scope to Phase 4 design |
| Claude C1: Mischaracterized problem statement | **Acknowledge** | Rewrite Problem Statement to focus on orchestrator elimination + precondition validation |
| Claude C2: PATH availability | **Adopt** | Make it `steroids ctl` subcommand, not separate binary |
| Claude C3: Orchestrator intelligence loss | **Partially adopt** | Move objective checks to loop; accept losing LLM judgment |
| Claude C4: Permanent dual-path complexity | **Partially adopt** | Add concrete deprecation timeline for fallback path |
| Claude C5: Doc inconsistency after review | **Adopt** | Post-review revision pass on main spec text |
| Claude C6: No reliability evidence | **Acknowledge** | Reframe motivation; measure in Phase 1 |
| Claude C7: Context command is redundant | **Adopt** | Drop Phase 4 from scope |
| Claude C8: Pool workspace sidecar race | **Adopt** | Update pool lifecycle functions in Phase 2 |
| Claude C9: Mixed-generation sessions | **Adopt** | Include `steroids ctl` in delta prompts for resumed sessions |
