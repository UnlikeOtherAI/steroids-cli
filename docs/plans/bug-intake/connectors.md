# Bug Intake Connectors

## Problem Statement

The codebase has no shared contract for external bug-intake systems. Upcoming connector work for Sentry and GitHub Issues needs a stable, typed boundary for:

- pulling external reports into the intake pipeline
- pushing status/comments back to the external system
- notifying the external system when an internal task is resolved
- validating connector-specific configuration before runtime

Without a shared contract, each connector would invent its own shapes and config rules, which would create inconsistent behavior and higher integration risk in the poller, registry, and database layers.

## Current Behavior

- There is no `IntakeReport` type or intake connector abstraction in `src/`.
- The central config schema in `src/config/schema.ts` has no `intake` section.
- Config validation in `src/config/validator.ts` only validates generic schema field types; there is no bug-intake-specific validation.
- The JSON Schema exporter in `src/config/json-schema.ts` only exposes existing config categories.

## Desired Behavior

Add a shared intake foundation that future connectors can implement without changing core shapes:

1. A generic connector interface for pull, push, and resolution flows.
2. Shared `IntakeReport` and related TypeScript types for normalized external reports.
3. A central `intake` config section with connector-specific nested config for Sentry and GitHub.
4. Validation that catches invalid connector configuration before runtime.
5. Schema exposure through the existing config-schema plumbing and unit tests.

This task does not implement live connector behavior, polling, deduplication, or database writes.

## Design

### Architecture

Follow the existing modular-monolith pattern:

- pure types and connector contracts in `src/intake/`
- central configuration shape in `src/config/loader.ts` and `src/config/schema.ts`
- validation logic in `src/config/validator.ts`
- existing JSON Schema plumbing reused in `src/config/json-schema.ts`

This keeps the domain boundary stable and delays runtime integration to the sibling tasks.

### Connector Contract

Add a generic `IntakeConnector` interface with documented async methods:

- `pullReports(request)` returns normalized reports plus the next cursor
- `pushUpdate(request)` sends a comment/status/sync update back to the external system
- `notifyResolution(request)` informs the external system that the linked internal task or report was resolved

The interface is capability-driven:

- each connector declares its `source`
- optional capabilities are explicit in a `capabilities` object
- no connector registry or factory is added in this task

### Intake Types

Add normalized domain types:

- `IntakeSource` as `'sentry' | 'github'`
- `IntakeSeverity`
- `IntakeReportStatus`
- `IntakeReportReference`
- `IntakeReport`
- request/result types for pull, push, and resolution operations
- config types for the root intake section and per-connector settings

Normalized report fields are intentionally conservative:

- stable external identity (`externalId`, `source`, `fingerprint`)
- routing metadata (`title`, `url`, `tags`, `severity`, `status`)
- timestamps (`createdAt`, `updatedAt`, optional `resolvedAt`)
- freeform payload for source-specific metadata

### Config Schema

Add a new top-level `intake` config section:

- `enabled`
- `pollIntervalMinutes`
- `maxReportsPerPoll`
- `connectors`

`connectors` contains fixed nested objects for the known upcoming integrations so the schema remains deterministic:

- `sentry`
  - `enabled`
  - `baseUrl`
  - `organization`
  - `project`
  - `authTokenEnvVar`
  - `defaultAssignee`
- `github`
  - `enabled`
  - `apiBaseUrl`
  - `owner`
  - `repo`
  - `tokenEnvVar`
  - `labels`

### Validation Rules

Generic schema validation remains the first pass. Add intake-specific validation rules after the generic pass:

- if `intake.enabled` is `true`, at least one connector must be enabled
- if a connector is enabled, its required identifiers must be non-empty
- env-var fields must be non-empty strings
- numeric polling values must be positive integers

These checks live in `src/config/validator.ts` so the config command and any future intake runtime share the same validation entry point.

## Implementation Order

1. Add the design doc and cross-provider review notes.
2. Add intake types and connector interface in `src/intake/`.
3. Extend config types/defaults/schema.
4. Add intake-specific validation and JSON Schema exposure tests.
5. Run build and targeted/full tests.

## Edge Cases

| Scenario | Handling |
|---|---|
| Intake disabled and all connectors disabled | Valid config; runtime feature off |
| Intake enabled but no connectors enabled | Validation error |
| Connector enabled with blank required fields | Validation error on the specific field |
| Connector disabled with blank fields | Valid; ignored until enabled |
| Unknown keys under `intake` | Existing warning behavior preserved |
| Future connector added later | Extend `IntakeSource`, connector config types, and `intake.connectors` schema in one place |

## Non-Goals

- implementing Sentry API calls
- implementing GitHub Issues API or `gh` CLI calls
- connector registry or runtime dispatch
- deduplication, DB schema, or poll-state persistence
- poller scheduling or wakeup integration

## Cross-Provider Review

- Codex finding: the current schema engine cannot enforce connector invariants on its own because `SchemaField` and `validateObject` only handle structural type checks.
  - Assessment: valid.
  - Decision: adopt. Add explicit intake-specific validation in `src/config/validator.ts` instead of relying on generic schema metadata for semantic rules.
- Claude CLI: installed but not authenticated (`claude -p` returned `Not logged in · Please run /login`).
  - Assessment: tooling blocker, not a design flaw.
  - Decision: defer. Record the blocker and continue with the best available external review.
- Gemini CLI: installed but not authenticated (`GEMINI_API_KEY`/Vertex auth missing).
  - Assessment: same blocker class as Claude.
  - Decision: defer. No design change; proceed with the implementation constrained by the accepted Codex finding above.
