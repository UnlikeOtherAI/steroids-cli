# Bug Intake Registry, Persistence, and Poll State

## Problem Statement

The intake foundation now has shared connector types and a GitHub connector, but there is still no runtime registry for connectors and no database layer for normalized intake reports or per-connector polling cursors. Without those pieces, the upcoming poller cannot deterministically discover connectors, persist pulled reports, deduplicate repeat observations, or resume from the last successful cursor.

## Current Behavior

- `src/intake/types.ts` defines shared `IntakeConnector` and `IntakeReport` types, but there is no registry or factory for enabled connectors.
- `src/intake/github-issues-connector.ts` implements GitHub behavior directly, but callers would need to instantiate it manually.
- `src/database/schema.ts` and `migrations/` contain no `intake_reports` or `intake_poll_state` tables.
- `src/database/queries.ts` has no intake-specific persistence helpers, so no code can record normalized reports, deduplicate them, or query them with filters.
- `docs/plans/bug-intake/connectors.md` explicitly left registry, deduplication, and DB persistence for a later task.

## Desired Behavior

Add the missing intake persistence layer, without implementing the async poller or API/UI work:

1. A deterministic registry that builds the set of enabled intake connectors from config.
2. Database schema for normalized intake reports and per-source poll state.
3. Upsert-style report persistence with deduplication by `(source, external_id)`.
4. Query helpers that support stable filtering by source, status, severity, and linked task presence.
5. Poll-state read/write helpers so the later poller can resume from the last cursor.

## Design

### Registry

Add `src/intake/registry.ts` with an `IntakeRegistry` class and a `createIntakeRegistry(config, options)` factory.

- The registry stores one connector per `IntakeSource`.
- Duplicate registration throws.
- `createIntakeRegistry` reads `config.intake.connectors`.
- Only enabled connectors are instantiated.
- For this task, the built-in factory only creates `GitHubIssuesConnector`.
- Sentry remains intentionally unimplemented; if enabled, the factory throws a clear error so misconfiguration fails fast instead of silently skipping a requested connector.

This keeps connector discovery deterministic and avoids pushing config-specific branching into the future poller.

### Persistence

Add two tables:

#### `intake_reports`

- `id TEXT PRIMARY KEY`
- `source TEXT NOT NULL`
- `external_id TEXT NOT NULL`
- `fingerprint TEXT NOT NULL`
- `title TEXT NOT NULL`
- `summary TEXT`
- `severity TEXT NOT NULL`
- `status TEXT NOT NULL`
- `report_url TEXT NOT NULL`
- `created_at_remote TEXT NOT NULL`
- `updated_at_remote TEXT NOT NULL`
- `resolved_at_remote TEXT`
- `tags_json TEXT NOT NULL`
- `payload_json TEXT NOT NULL`
- `first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))`
- `last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))`
- `linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL`
- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`

Constraints and indexes:

- unique index on `(source, external_id)` for deduplication
- filter indexes on `(source, status)`, `(source, severity)`, and `linked_task_id`

The external identity is the durable dedup key. `fingerprint` is stored for downstream grouping, but not used as the unique key because multiple external reports may share a fingerprint.

#### `intake_poll_state`

- `source TEXT PRIMARY KEY`
- `cursor TEXT`
- `last_polled_at TEXT`
- `last_success_at TEXT`
- `last_error_at TEXT`
- `last_error_message TEXT`
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`

This is one row per connector source. The later poller can atomically replace the latest cursor and timestamps after each run.

### Query Helpers

Keep intake-specific persistence in a focused module: `src/database/intake-queries.ts`.

Add:

- `upsertIntakeReport(db, report, options?)`
- `listIntakeReports(db, filters?)`
- `getIntakeReport(db, source, externalId)`
- `linkIntakeReportToTask(db, source, externalId, taskId)`
- `getIntakePollState(db, source)`
- `upsertIntakePollState(db, state)`

`upsertIntakeReport` behavior:

- insert new row when `(source, external_id)` is unseen
- otherwise update the normalized fields in place
- preserve `first_seen_at`
- always refresh `last_seen_at`
- preserve an existing `linked_task_id` unless a new explicit `linkedTaskId` is passed

`listIntakeReports` filters:

- `source`
- `status`
- `severity`
- `linkedTaskId`
- `hasLinkedTask`
- `limit`

Ordering:

- default `ORDER BY updated_at_remote DESC, source ASC, external_id ASC`

This keeps listing deterministic while supporting the later API/UI work without taking on pagination in this task. `id` is not a good tie-breaker here because this codebase typically uses UUIDs for text primary keys, so the tie-breaker must use stable business keys instead.

## Implementation Order

1. Add this design doc and record cross-provider review results.
2. Add registry/factory code in `src/intake/`.
3. Add schema changes to `src/database/schema.ts`, a new SQL migration, and the manifest entry.
4. Add intake persistence helpers in `src/database/intake-queries.ts` and export them.
5. Add unit tests for registry and DB behavior.
6. Run build and targeted/full tests.

## Edge Cases

| Scenario | Handling |
|---|---|
| GitHub enabled, Sentry disabled | Registry contains only GitHub |
| Sentry enabled before implementation exists | Fail fast with explicit unsupported-source error |
| Same report pulled twice with changed title/status | Existing row updated; one row preserved |
| Same fingerprint across different external IDs | Separate rows preserved |
| Query requests `hasLinkedTask=false` | Filter `linked_task_id IS NULL` deterministically |
| Poll state missing for a source | Getter returns `null` |
| Poll state updated after a failure | Store `last_error_*`; helpers must not overwrite the last successful cursor unless the caller explicitly passes a replacement |

## Non-Goals

- async polling or wakeup integration
- Sentry connector implementation
- API routes, CLI surfaces, or WebUI pages for intake
- task creation or pipeline glue from stored intake reports
- webhook ingestion

## Cross-Provider Review

- Codex finding: built-in schema initialization and migration files must both be updated or fresh databases and upgraded databases will diverge.
  - Assessment: valid.
  - Decision: adopt. Update `src/database/schema.ts`, `INITIAL_SCHEMA_DATA`, the new SQL migration, and `migrations/manifest.json` together.
- Codex finding: `linked_task_id TEXT REFERENCES tasks(id)` is unsafe because this repo deletes tasks with plain `DELETE FROM tasks` in tests and purge flows; the foreign key needs an explicit delete policy.
  - Assessment: valid.
  - Decision: adopt. Use `ON DELETE SET NULL` so report history survives task deletion.
- Codex finding: `ORDER BY updated_at_remote DESC, id ASC` is not deterministic enough if `id` is a UUID; ties should use stable business keys.
  - Assessment: valid.
  - Decision: adopt. Order by `updated_at_remote DESC, source ASC, external_id ASC`.
- Codex finding: poll-state failure semantics were underspecified; a failed poll should not accidentally advance or clear the last successful cursor.
  - Assessment: valid.
  - Decision: adopt. The poll-state helper will treat cursor replacement as explicit and preserve the existing cursor on failure-only updates.
- Codex finding: throwing when an enabled Sentry connector is configured is acceptable for fail-fast behavior, but the registry factory should make that error explicit and source-specific so operators can distinguish “enabled but unsupported” from generic config failure.
  - Assessment: valid.
  - Decision: adopt. Use a dedicated unsupported-connector error message naming the source.
- Claude CLI review attempt: `claude -p` failed locally with `Not logged in · Please run /login`.
  - Assessment: tooling/auth blocker, not a design flaw.
  - Decision: defer. Proceed with implementation while recording that the required second-provider review could not execute in this workspace.
