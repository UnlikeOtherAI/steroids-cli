# Steroids Agent Guidelines

> Read CLAUDE.md and AGENTS.md before starting any work. Update both when policy changes.

## Cross-Provider Reviews (CRITICAL)

### Core Engine Functions — Mandatory Double Review

Any change to the dispatch pipeline requires two independent adversarial reviews — Claude (`superpowers:code-reviewer`) and Codex — at both the **planning phase** (before writing code) and the **verification phase** (after tests pass).

**Functions that trigger this rule:**

| Area | Files / Symbols |
|------|----------------|
| Dependency gating | `getPendingDependencies`, `hasDependenciesMet` — `src/database/queries.ts` |
| Task selection | `findNextTask`, `findNextTaskSkippingLocked`, `selectNextTaskWithLock`, `selectNextTaskWithWait` — `src/orchestrator/task-selector.ts`, `src/database/queries.ts` |
| Parallel workstream planning | `buildParallelRunPlan`, pending-work count query — `src/commands/runners-parallel.ts` |
| Runner loop | `orchestrator-loop.ts`, `daemon.ts` — any change to when runners exit or restart |
| Status definitions | `TaskStatus` enum — `src/database/queries.ts` — adding or redefining a status propagates to all of the above |
| Section "done" checks | Any code that answers "is this section finished?" — must stay consistent across all call sites |
| Intake pipeline transitions | `buildIntakeTaskTemplate`, `parseIntakeResult`, `deriveIntakePipelineTransition`, `handleIntakeTaskApproval`, `syncGitHubIntakeGate`, `pollIntakeProject`, `processWakeupProject` — `src/intake/*.ts`, `src/runners/wakeup-project.ts` |

**Each adversarial review must check:**

1. **Status set consistency** — every "is task/section done?" check must agree on the same terminal status set across all call sites.
2. **New status propagation** — trace any new `TaskStatus` value through all six areas above.
3. **Wait-loop exit conditions** — every task/section state combination must result in a clean exit, not an infinite poll.
4. **Parallel plan / dependency gate alignment** — the pending-work query and the blocking query must exclude exactly the same terminal statuses.
5. **Rollback failure modes** — if a task is incorrectly marked terminal by a bug, document the worst-case consequence.
6. **Intake phase contract alignment** — task templates, `intake-result.json` parsing, and approval transitions must agree on valid phases, decisions, and required fields.
7. **Intake wakeup/gate alignment** — poller, approval gate, and wakeup-triggered task creation must not create duplicate triage tasks or strand reports without a linked task.

**Core engine functions NEVER skip review regardless of change size.**

### Codex Invocation Protocol

- Non-interactive mode only — never use flags that trigger interactive prompts.
- Never pass model flags or aliases unless explicitly requested.
- Before use: `codex --help` to verify availability; `codex exec "say hi"` as a smoke check.
- Cap long analysis runs at 5 minutes: `timeout 300 codex exec "<prompt>"`
- Do not kill an active process; only terminate after sustained inactivity and ~0% CPU.

### When to Request a Cross-Provider Review

Get a second opinion from a different provider **before implementation** for: new features spanning 3+ files, architectural changes (new tables, API routes, component patterns), design documents, changes to the orchestrator or loop.

### How to Conduct a Review

1. Write the design/spec first — complete thinking before seeking review.
2. Send to a different provider (Claude wrote it → Codex; Codex wrote it → Claude). Instruct the reviewer to be **adversarial**: look for technical debt, architectural regression, type safety gaps, and logic holes.
3. Run in non-interactive mode so output is captured and the workflow isn't blocked.
4. The review is advisory. Assess each finding independently: is it valid, relevant, actionable now? Push back with reasoning if the reviewer is wrong. Do not let reviewers push toward over-engineering.
5. Append a "Cross-Provider Review" section to the design doc (finding → assessment → decision: adopt/defer/reject). Commit the combined document.

**Skip review for:** typo fixes, doc-only updates, hotfixes (review post-merge), single-file changes under 50 lines — **unless they touch core engine functions.**

---

## Design Document Standards

Required sections for any feature design doc:

1. **Problem Statement** — what's broken and why it matters
2. **Current Behavior** — how the system works today (with file references)
3. **Desired Behavior** — what should happen instead
4. **Design** — technical approach with code sketches (not final code)
5. **Implementation Order** — phased plan with dependencies
6. **Edge Cases** — table of scenarios and handling
7. **Non-Goals** — explicitly out of scope
8. **Cross-Provider Review** — findings, assessments, decisions

Design docs live in `docs/plans/`. Move to `docs/done/` when implementation is complete.

---

## After Design Doc is Finalized

When all tasks in the plan are complete, move the design doc and plan file from `docs/plans/` to `docs/done/`.

---

## Agent Behavior Rules

### Root-Cause First (CRITICAL)

Do not patch around a failure before understanding the defect. Diagnose and document the root cause first (with concrete log/code evidence); fix the broken invariant directly. Fallbacks are only acceptable as temporary containment with an explicit follow-up task for the real fix.

### Determinism First (CRITICAL)

Keep the system deterministic. Any non-deterministic addition (regex parsing of LLM output, fuzzy matching, nested fallback chains) requires deep architectural justification and usually explicit user approval before implementation.

### Simplification First (CRITICAL)

Before patching, ask whether the right fix is to simplify. Every change must reduce or hold total system complexity — never increase it. Two code paths that answer the same invariant question must share one source of truth. If a short-term patch is unavoidable, create a follow-up simplification task with concrete scope.

### Intake Pipeline Consistency (CRITICAL)

Treat the intake phase contract as a core-engine invariant. If you add or change an intake phase, decision, required result field, or task-creation trigger, update the single source of truth across task templates, `intake-result.json` parsing, approval transitions, and wakeup/gate entry points together. Never let one path invent a phase transition or terminal outcome that the others do not understand.

### Documentation Alignment (CRITICAL)

Feature work is incomplete until `README.md`, `AGENTS.md`, and relevant schema/config docs are updated. When adding or changing CLI flags or subcommands, update the help text in `src/commands/`.

### Prompt Composition (CRITICAL)

For orchestrator-generated coder/reviewer/coordinator prompts:
- Never inline the contents of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or skill files.
- Link those files only and explicitly require the agent to read them.
- Place the specification file link near the top of the prompt.
- Path format is strict: in-repo links use `./...`; out-of-repo links use absolute paths.
- Do not emit placeholder text like "file not found" for linked spec/instruction/skill paths in prompt templates.

### CLI-Only Providers (CRITICAL)

All AI providers MUST invoke models by spawning a CLI subprocess (`spawn`). Never implement providers that call model APIs directly via HTTP (`fetch`, `https.request`, etc.). The provider's job is to wrap a CLI tool — authentication, tool use, multi-step reasoning, and request handling are the CLI's responsibility, not ours. If a model doesn't have a CLI wrapper, it doesn't get a provider.

### Command Execution Discipline (CRITICAL)

Use non-interactive modes for all scripted/automated flows. For `npx` in automation, use `-y`/`--yes`.

### Architecture and Quality Practices

- Prefer proven patterns in this codebase over new architectural models for routine problems.
- **After editing any file, check its line count — hard limits:**
  - Source, tests, config: **500 lines**. Exceeding requires splitting into focused modules before continuing.
  - Documentation (`.md`): **1,000 lines**. Exceeding requires a dedicated folder with `overview.md` linking to sub-files.
- Include targeted tests for bug fixes and new logic when validation is in scope.
- Keep work in small isolated commits and push promptly.

### What Belongs in the Repo (CRITICAL)

Only commit permanent, hand-authored files. If it can be regenerated, do not commit it.

**Never commit:** build output (`dist/`, `*.tsbuildinfo`), one-off scripts, backup files (`*.bak`, `*.orig`), temporary notes, duplicate or stale copies.

**Always commit:** source (`src/`, `tests/`), config (`tsconfig.json`, `jest.config.js`, `.gitignore`, `package.json`), AI config (`CLAUDE.md`, `AGENTS.md`), migrations, permanent scripts, permanent docs.

When in doubt: if it has a `.gitignore` entry, do not commit it.

---

## Follow-up Tasks (Non-blocking Improvements)

When reviewing, suggest valuable but non-blocking improvements as **follow-up tasks** rather than rejections.

**Create a follow-up for:** missing comprehensive tests, minor readability refactors, doc improvements, extracting hardcoded values, acceptable-performance optimizations.

**Reject instead for:** missing required functionality, security vulnerabilities, data corruption risk, test failures, zero test coverage.

Each follow-up must specify: **WHAT** (files/functions), **WHY** (technical debt or gap), **HOW** (suggested approach). Max 3 per review.

---

## Release / Publish Runbook (CRITICAL)

When the user says "do a release" or "do a publish":

1. Commit all intended changes.
2. **Pre-publish gate (MANDATORY):** Run `npm run build` (CLI) and `cd WebUI && npm run build` (dashboard) to verify both compile cleanly. Do NOT proceed if there are TypeScript errors or build failures — fix them first. Also run `npm audit` and fix any high/critical vulnerabilities before publishing.
3. Bump version: `npm version patch|minor|major`
4. Push: `git push && git push --tags`
5. Publish: `npm publish`
6. Create GitHub release: `gh release create v<version> --title ... --notes ...` (include user-visible changes, bug fixes, and a compare link to the previous tag).
7. Install globally: `npm i -g steroids-cli@latest`
8. Reload web assets: `steroids web stop && steroids web` (if UI looks stale: `steroids web update` first, then restart).

**Verify:** `steroids --version` matches; `steroids web` starts with no errors; hard-refresh browser if UI still shows old version.
