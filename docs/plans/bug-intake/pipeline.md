# Bug Intake Pipeline Task Templates

## Problem Statement

The intake subsystem can now persist external reports and parse the first `triage`
phase result, but it still has no shared contract for the internal tasks that the
pipeline is supposed to create. Without deterministic templates, later glue code
would invent titles, sections, and coder instructions ad hoc, which would make the
pipeline brittle and difficult to review.

## Current Behavior

- [src/intake/poller.ts](../../../src/intake/poller.ts) persists normalized intake reports
  but does not create internal tasks.
- [src/intake/pipeline-glue.ts](../../../src/intake/pipeline-glue.ts) validates
  `intake-result.json` for the `triage` phase and derives the next transition, but
  it does not define the task metadata for any phase.
- The normal task helper in [src/database/queries.ts](../../../src/database/queries.ts)
  only creates generic tasks and does not provide intake-specific defaults.

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

This task does not create or wire tasks. It only defines the template contract that
later glue code can consume.

## Design

### Module

Add `src/intake/task-templates.ts` with pure builders:

- `getIntakeTaskSectionName(phase)`
- `buildIntakeTaskTitle(phase, report)`
- `buildIntakeTaskDescription(phase, report)`
- `buildIntakeTaskTemplate(phase, report, options?)`

### Phase Defaults

| Phase | Section | Title prefix | Notes |
|---|---|---|---|
| `triage` | `Bug Intake: Triage` | `Triage intake report ...` | Must instruct the coder to write `intake-result.json` using the existing triage contract |
| `reproduction` | `Bug Intake: Reproduction` | `Reproduce intake report ...` | Focus on reliable repro + evidence; no speculative cleanup |
| `fix` | `Bug Intake: Fix` | `Fix intake report ...` | Focus on the narrowest safe fix + targeted validation |

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

## Implementation Order

1. Create this pipeline design doc.
2. Add the pure intake task-template module.
3. Export it from `src/intake/index.ts`.
4. Add deterministic unit tests for all three phases.
5. Run targeted tests and the project build.

## Edge Cases

| Scenario | Handling |
|---|---|
| Report title contains newlines or repeated spaces | Normalize whitespace so titles remain stable |
| Summary is empty or missing | Omit the summary line |
| Later glue needs a different source file path | Allow an explicit `sourceFile` override |
| Reproduction/fix pipeline transitions are not wired yet | Keep this task template layer pure and glue-free |

## Non-Goals

- reviewer approval-path wiring
- task insertion or section creation side effects
- new database migrations
- new `intake-result.json` parsing beyond the current `triage` contract

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
