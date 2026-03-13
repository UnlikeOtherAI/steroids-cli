# Bug Intake Pipeline Tasks And Reproduction Glue

## Problem Statement

The intake subsystem can now persist external reports, build deterministic task
templates, and parse the first `triage` phase result, but the pipeline still lacks
deterministic reproduction-phase glue. Without an explicit `reproduction`
contract, reviewer approval cannot safely decide whether to retry reproduction,
advance to a fix, or close the report.

## Current Behavior

- [src/intake/poller.ts](../../../src/intake/poller.ts) persists normalized intake reports
  but does not create internal tasks.
- [src/intake/pipeline-glue.ts](../../../src/intake/pipeline-glue.ts) validates
  `intake-result.json` for the `triage` phase only.
- [src/intake/reviewer-approval.ts](../../../src/intake/reviewer-approval.ts) only
  handles approved `triage` tasks and cannot create deterministic retry
  reproduction tasks.
- [src/intake/task-templates.ts](../../../src/intake/task-templates.ts) builds the
  three intake task templates, but reproduction tasks do not yet explain the
  reproduction output contract or deterministic retry naming.

## Desired Behavior

Add one pure, deterministic source of truth for the three intake task phases:

1. `triage`
2. `reproduction`
3. `fix`

Each phase template should define:

- section name
- task title
- spec/source file path
- report-specific description text

Reviewer approval should also consume deterministic `intake-result.json`
contracts for:

1. `triage` decisions `close | reproduce | fix`
2. `reproduction` decisions `close | retry | fix`

## Design

### Module

Keep `src/intake/task-templates.ts` as the pure builder source of truth:

- `getIntakeTaskSectionName(phase)`
- `buildIntakeTaskTitle(phase, report)`
- `buildIntakeTaskDescription(phase, report)`
- `buildIntakeTaskTemplate(phase, report, options?)`

Extend `src/intake/pipeline-glue.ts` and
`src/intake/reviewer-approval.ts` so approved intake tasks can deterministically:

- complete the report
- create another reproduction task
- create the fix task

### Phase Defaults

| Phase | Section | Title prefix | Notes |
|---|---|---|---|
| `triage` | `Bug Intake: Triage` | `Triage intake report ...` | Must instruct the coder to write `intake-result.json` using the existing triage contract |
| `reproduction` | `Bug Intake: Reproduction` | `Reproduce intake report ...` | Focus on reliable repro + evidence, require the reproduction `intake-result.json` contract, and support deterministic retry titles |
| `fix` | `Bug Intake: Fix` | `Fix intake report ...` | Focus on the narrowest safe fix + targeted validation |

### Reproduction Result Contract

The reproduction phase writes `intake-result.json` with:

- `phase: "reproduction"`
- `decision: "close" | "retry" | "fix"`
- `summary` (required)
- `comment` (optional)
- `resolutionCode` (required only when `decision === "close"`)
- `nextTaskTitle` (optional deterministic override)

Transition rules:

- `close` completes the intake report using `resolutionCode`
- `retry` creates another `reproduction` task
- `fix` creates the `fix` task

### Shared Context

Every template description includes:

- external report identity (`source#externalId`)
- normalized title
- severity
- current intake status
- external URL
- optional summary when present

The shared spec/source path is `docs/plans/bug-intake/pipeline.md` so generated
tasks all point at one stable pipeline spec instead of phase-specific ad hoc docs.

Retry support stays deterministic by appending ` (retry N)` to a generated
reproduction task title when glue creates another reproduction task without an
explicit `nextTaskTitle`.

## Implementation Order

1. Create this pipeline design doc.
2. Add the pure intake task-template module.
3. Extend task templates with deterministic retry-title support.
4. Extend pipeline glue with the reproduction result contract.
5. Update reviewer approval to handle approved reproduction tasks.
6. Add deterministic unit tests for triage, reproduction, and retry behavior.
7. Run targeted tests and the project build.

## Edge Cases

| Scenario | Handling |
|---|---|
| Report title contains newlines or repeated spaces | Normalize whitespace so titles remain stable |
| Summary is empty or missing | Omit the summary line |
| Later glue needs a different source file path | Allow an explicit `sourceFile` override |
| Reproduction is retried repeatedly | Derive the next retry attempt from the current task title and append a deterministic ` (retry N)` suffix |
| Reproduction closes without requiring code changes | Allow `decision: "close"` with `resolutionCode`, which completes the report without creating a fix task |

## Non-Goals

- new database migrations
- non-deterministic retry policies or backoff
- new database state for retry counters

## Cross-Provider Review

- Claude CLI review attempt:
  - Command: `timeout 300 claude -p "<adversarial review prompt>"`
  - Result: `Not logged in · Please run /login`
  - Assessment: external-review tool available but blocked by auth in this workspace.
  - Decision: defer and proceed with a narrow, deterministic implementation.
- Gemini CLI review attempt:
  - Command: `timeout 300 gemini -p "<adversarial review prompt>"`
  - Result: missing auth configuration (`GEMINI_API_KEY` / Vertex / GCA).
  - Assessment: same blocker class as Claude.
  - Decision: defer and proceed with unit coverage plus explicit scope limits.
