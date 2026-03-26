# Monitor Detectability And Mode Contract Plan

## Problem Statement

The current monitor implementation can detect many anomalies, but it cannot yet prove that it detects every scenario we care about, nor can it prove that each response mode obeys its instructions.

Three gaps matter:

1. The monitor has almost no direct tests. Current coverage is limited to [tests/wakeup-basic.test.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/tests/wakeup-basic.test.ts) and [tests/s6-scanner-alignment.test.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/tests/s6-scanner-alignment.test.ts), which do not validate the full monitor loop, first-responder dispatch, response-mode behavior, or CLI/API/UI contract.
2. `response_preset` is mostly prompt text today. The host does not enforce a mode-specific action policy, so the system cannot prove that a "triage" run stayed diagnostic-only or that a "monitor-only" run never dispatched a fixer.
3. The current preset vocabulary does not match the required product contract. The code exposes `stop_on_error`, `investigate_and_stop`, `fix_and_monitor`, and `custom`, but the required states are:
   - just monitor
   - triage / identify the problem
   - identify and apply a fix
   - custom

The result is a false sense of safety: we have detections, prompts, and UI controls, but not a complete, machine-checkable contract. Any scenario that is required but not currently detectable must be treated as missing monitor functionality, not as a mere test gap.

## Current Behavior

### Monitor Detection Surface

The scanner in [src/monitor/scanner.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/scanner.ts) and [src/monitor/scanner-queries.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/scanner-queries.ts) currently emits these anomaly types:

| ID | Scenario | Current detector | Current severity | Detectable today |
|---|---|---|---|---|
| D1 | orphaned task | `detectStuckTasks()` mapping | critical | yes |
| D2 | hanging invocation | `detectStuckTasks()` mapping | critical | yes |
| D3 | zombie runner | `detectStuckTasks()` mapping | critical | yes |
| D4 | dead runner | `detectStuckTasks()` mapping | critical | yes |
| D5 | DB inconsistency | `detectStuckTasks()` mapping | info | yes |
| D6 | credit exhaustion | `detectStuckTasks()` mapping | critical | yes |
| D7 | failed task | `scanFailedAndSkippedTasks()` | info | yes |
| D8 | skipped task | `scanFailedAndSkippedTasks()` | info | yes |
| D9 | high invocations | `scanHighInvocations()` | warning | yes |
| D10 | repeated failures | `scanRepeatedFailures()` | warning | yes |
| D11 | blocked task from `blocked_conflict` | `scanBlockedTasks()` | critical | yes |
| D12 | blocked task from `blocked_error` | `scanBlockedTasks()` | critical | yes |
| D13 | stuck merge phase: queued stale | `scanStuckMergePhase()` | warning | yes |
| D14 | stuck merge phase: rebasing stale | `scanStuckMergePhase()` | warning | yes |
| D15 | stuck merge phase: rebase_review stale | `scanStuckMergePhase()` | warning | yes |
| D16 | disputed task | `scanDisputedTasks()` | warning | yes |
| D17 | stale merge lock | `scanStaleMergeLocks()` | critical | yes |
| D18 | idle project with cron active | `hasPendingWork()` + `hasActiveRunner()` | critical | yes |
| D19 | idle project while provider backed off | same idle-project detector | info | yes |
| D20 | idle project while cron inactive | same idle-project detector | info | yes |
| D21 | anomaly suppression active | `monitor_suppressions` filter | n/a | yes |
| D22 | suppression expired and anomaly returns | suppression expiry path | original severity | yes |

What is missing today is not the list of emitted anomaly types. The missing part is the contract that every scenario above has a dedicated test, plus a documented decision for scenarios we expect but do not yet detect.

### Monitor Loop State Surface

The loop in [src/monitor/loop.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/loop.ts) currently has these branch points:

| ID | Scenario | Current behavior | Detectable today |
|---|---|---|---|
| L1 | monitor config missing | `monitorCheck()` returns immediately | yes |
| L2 | monitor disabled | `monitorCheck()` returns immediately | yes |
| L3 | interval not elapsed | `monitorCheck()` returns immediately | yes |
| L4 | active first responder still within timeout | `monitorCheck()` returns immediately | yes |
| L5 | active first responder timed out | marks prior run `error`; continues | yes |
| L6 | scan returns duplicate of last clean/dispatched run | `monitorCheck()` returns without new row | yes |
| L7 | duplicate after `anomalies_found` or `error` | intentionally not suppressed | yes |
| L8 | escalation false | creates `clean` or `anomalies_found` row | yes |
| L9 | escalation true but no agents configured | creates `anomalies_found` row | yes |
| L10 | escalation true but FR cooldown active | creates `anomalies_found` row | yes |
| L11 | escalation true but all projects capped by circuit breaker | creates `anomalies_found` row and alerts | yes |
| L12 | escalation true with uncapped projects | creates `first_responder_dispatched` row | yes |
| L13 | spawn entrypoint missing in detached dispatch path | currently silent in `spawnFirstResponder()` from loop | partly |
| L14 | manual run duplicate | `runMonitorCycle({ manual: true })` bypasses duplicate suppression | yes |
| L15 | manual force-dispatch | `forceDispatch` can dispatch even when rules do not escalate | yes |
| L16 | scanner / loop error | `runMonitorCycle()` returns `error` result | yes |

`L13` is only partly detectable today because `spawnFirstResponder()` in the loop returns early if no CLI entrypoint exists, leaving a dispatched row without a spawned process. That should be treated as missing functionality and fixed, not merely tested around.

### Response Mode Surface

The current responder contract is split across:

- [src/monitor/investigator-prompt.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/investigator-prompt.ts)
- [src/monitor/investigator-agent.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/investigator-agent.ts)
- [src/commands/monitor-respond.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/commands/monitor-respond.ts)
- [WebUI/src/pages/MonitorPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/MonitorPage.tsx)

Current built-in presets:

| Stored value | Current meaning | Problem |
|---|---|---|
| `stop_on_error` | Ask the model to stop runners immediately on critical anomalies | Not one of the required four states |
| `investigate_and_stop` | Ask the model to diagnose and maybe stop runners | Not a pure "triage" mode |
| `fix_and_monitor` | Ask the model to repair | Closest to required fix mode |
| `custom` | Free-form custom instruction text | Valid required state |

The host currently validates action shape, but it does not enforce preset-specific action policies. That means a model response can violate the selected mode and still execute if the JSON shape is valid.

### Existing Tests

Current direct test coverage is not sufficient:

| Area | Current direct tests | Gap |
|---|---|---|
| scanner anomaly contract | [tests/s6-scanner-alignment.test.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/tests/s6-scanner-alignment.test.ts) only checks pending-work alignment and provider extraction | no anomaly-type matrix |
| loop state machine | none | complete gap |
| response mode policy | none | complete gap |
| respond command | none | complete gap |
| monitor CLI/API contract | none | complete gap |
| monitor UI mode contract | none | complete gap |

## Desired Behavior

The monitor should have a complete, testable contract with four canonical response modes:

1. `monitor_only`
2. `triage_only`
3. `fix_and_monitor`
4. `custom`

Required properties of the new contract:

1. Every required scenario is explicitly cataloged.
2. Every cataloged scenario is either:
   - detected and tested, or
   - explicitly marked as missing functionality for the monitor.
3. Response modes are enforced by host policy, not only by prompt wording.
4. Tests use independent oracles. No test harness should derive both stimulus and expected behavior from the same table.
5. CLI, API, UI, and prompt text all use the same canonical mode vocabulary.
6. Legacy preset values are handled deliberately and compatibly, not accidentally.

## Design

### 1. Canonical Response Modes

Introduce a single monitor response-mode module, for example [src/monitor/response-mode.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/response-mode.ts), with the canonical mode vocabulary and host-enforced policies.

```ts
export type MonitorResponseMode =
  | 'monitor_only'
  | 'triage_only'
  | 'fix_and_monitor'
  | 'custom';

export type LegacyMonitorResponsePreset =
  | 'stop_on_error'
  | 'investigate_and_stop';

export type StoredMonitorResponsePreset =
  | MonitorResponseMode
  | LegacyMonitorResponsePreset;

export interface MonitorResponsePolicy {
  autoDispatch: boolean;
  allowedActions: ReadonlySet<FirstResponderAction['action']>;
  allowFallbackRepairInjection: boolean;
  requiresCustomPrompt: boolean;
  promptMode: MonitorResponseMode | LegacyMonitorResponsePreset;
}
```

Canonical policy:

| Mode | Auto-dispatch from loop | Allowed actions | Fallback repair injection | Notes |
|---|---|---|---|---|
| `monitor_only` | no | none | no | detect and log only |
| `triage_only` | yes | `query_db`, `report_only` | no | diagnosis only, no mutations |
| `fix_and_monitor` | yes | all current allowed actions | yes | full current repair mode |
| `custom` | yes | all current allowed actions | no by default | custom prompt inside fixed host guardrails |

Legacy compatibility:

| Legacy value | Runtime handling | Reason |
|---|---|---|
| `stop_on_error` | accepted as deprecated alias with host policy `{ stop_all_runners, report_only }` | preserve existing saved configs without exposing the mode as canonical |
| `investigate_and_stop` | accepted as deprecated alias with host policy `{ query_db, report_only, stop_all_runners }` | preserve current behavior while moving new configs to `triage_only` |

This avoids silently changing stored behavior while still making the canonical product contract match the required four states.

Manual behavior:

- `monitor_only` blocks automatic dispatch only.
- Explicit manual investigation of an already-recorded run remains allowed, but it must require an explicit override to `triage_only`, `fix_and_monitor`, or `custom`.
- `forceDispatch` on the generic "run now" path does not override `monitor_only`; the operator must choose an explicit investigation mode instead.

### 2. Host-Enforced Mode Policy

Mode policy must be applied in three places:

1. Before dispatch in [src/monitor/loop.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/loop.ts)
2. During prompt generation in [src/monitor/investigator-prompt.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/investigator-prompt.ts)
3. After JSON parse and before action execution in [src/monitor/investigator-agent.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/investigator-agent.ts)

Required enforcement rules:

- `monitor_only` must never dispatch a first responder automatically.
- `triage_only` must never execute state-mutating actions.
- `custom` stays within the fixed host allowlist even if the prompt asks for something else.
- fallback repair injection (`M6`) must run only in `fix_and_monitor`; it is incompatible with `monitor_only`, `triage_only`, and most `custom` runs.
- invalid or over-broad model output must be reduced to the nearest valid action set for that mode, never expanded.

### 3. Missing Functionality To Treat As Product Gaps

These are not only missing tests. They are missing or under-specified monitor features:

| ID | Gap | Why it is missing functionality |
|---|---|---|
| F1 | `monitor_only` mode does not exist today | the required four-state contract is not implemented |
| F2 | `triage_only` mode does not exist today | current `investigate_and_stop` is not pure triage |
| F3 | preset-specific action policy is not enforced | instructions cannot be trusted |
| F4 | fallback repair injection is mode-blind | non-fix modes can be silently upgraded to repair |
| F5 | `spawnFirstResponder()` silently returns when entrypoint is missing | loop can claim dispatch without proving dispatch happened |
| F6 | there is no coverage registry for required monitor scenarios | missing scenarios can disappear unnoticed |
| F7 | there are no direct monitor loop / responder / CLI / UI tests | monitor behavior is effectively unverified |

The implementation should close `F1` through `F7`. If a gap is intentionally left open, it must be called out explicitly as a non-goal or follow-up.

### 4. Exhaustive Scenario Registry

Add a scenario registry for the monitor under `tests/monitor/scenario-registry.ts`. This registry is for coverage bookkeeping only. It must not define expected outcomes used by the same tests.

```ts
export interface MonitorScenario {
  id: string;
  layer: 'scanner' | 'loop' | 'response_mode' | 'command' | 'ui';
  description: string;
  required: boolean;
  currentStatus: 'implemented' | 'missing_functionality';
}
```

Rules:

1. The registry stores identity, scope, and requirement status only.
2. Each test suite owns a subset of scenario IDs.
3. A dedicated `coverage-contract.test.ts` verifies that every required scenario ID has a suite owner.
4. Expected outcomes live in the suite itself, not in the registry, to avoid self-derived oracles.

### 5. Detailed Scenario Matrix

#### Scanner Scenarios

Every scanner scenario below requires at least one direct test:

| ID | Scenario | Current status | Required assertions |
|---|---|---|---|
| S1 | no registered projects | implemented | `projectCount=0`, empty anomalies, clean summary |
| S2 | missing project DB | implemented | project skipped without crash |
| S3 | orphaned task | implemented | anomaly type/severity/task metadata |
| S4 | hanging invocation | implemented | anomaly type/severity/runner metadata |
| S5 | zombie runner | implemented | anomaly type/severity/pid metadata |
| S6 | dead runner | implemented | anomaly type/severity/pid metadata |
| S7 | DB inconsistency | implemented | anomaly type=`db_inconsistency`, severity=`info` |
| S8 | credit exhaustion | implemented | anomaly type=`credit_exhaustion`, severity=`critical` |
| S9 | failed task | implemented | anomaly type=`failed_task`, info severity |
| S10 | skipped task | implemented | anomaly type=`skipped_task`, info severity |
| S11 | high invocations | implemented | warning severity and threshold context |
| S12 | repeated failures | implemented | warning severity and failure/rejection counts |
| S13 | blocked conflict task | implemented | `blocked_task`, critical severity, conflict message |
| S14 | blocked error task | implemented | `blocked_task`, critical severity, error message |
| S15 | stale queued merge phase | implemented | `stuck_merge_phase`, mergePhase=`queued` |
| S16 | stale rebasing merge phase | implemented | `stuck_merge_phase`, mergePhase=`rebasing` |
| S17 | stale rebase-review merge phase | implemented | `stuck_merge_phase`, mergePhase=`rebase_review` |
| S18 | disputed task | implemented | `disputed_task`, warning severity |
| S19 | stale merge lock | implemented | `stale_merge_lock`, critical severity |
| S20 | idle project with cron active | implemented | critical idle anomaly |
| S21 | idle project with provider backoff | implemented | info idle anomaly with backoff context |
| S22 | idle project with cron inactive | implemented | info idle anomaly |
| S23 | anomaly suppressed | implemented | anomaly omitted from final result |
| S24 | suppression expired | implemented | anomaly visible again |
| S25 | corrupt project DB or query failure | implemented | project skipped without crashing scan |

#### Loop Scenarios

Every loop scenario below requires at least one direct test:

| ID | Scenario | Current status | Required assertions |
|---|---|---|---|
| L1 | config missing | implemented | no run row, no spawn |
| L2 | disabled monitor | implemented | no run row, no spawn |
| L3 | interval not elapsed | implemented | no scan, no run row |
| L4 | active FR in progress | implemented | no new row, no spawn |
| L5 | stale FR timeout | implemented | old row marked `error`, monitor proceeds |
| L6 | duplicate of previous clean run | implemented | no new row |
| L7 | duplicate of previous dispatched run | implemented | no new row |
| L8 | duplicate after `anomalies_found` | implemented | not suppressed; new row created |
| L9 | no anomalies | implemented | `clean` row |
| L10 | anomalies below escalation threshold | implemented | `anomalies_found`, no spawn |
| L11 | escalation with no agents | implemented | `anomalies_found`, no spawn |
| L12 | escalation blocked by cooldown | implemented | `anomalies_found`, no spawn |
| L13 | escalation capped for all projects | implemented | `anomalies_found`, alert rows written |
| L14 | escalation capped for some projects only | implemented | dispatch still occurs, attempts only for uncapped projects |
| L15 | escalation and successful dispatch | implemented | `first_responder_dispatched`, spawn called |
| L16 | dispatch entrypoint missing | missing functionality | row must not remain falsely dispatched |
| L17 | run pruning | implemented | oldest rows pruned to retention |
| L18 | manual run bypasses duplicate suppression | implemented | returns new row/result |
| L19 | manual `forceDispatch` overrides rules | implemented | dispatch occurs if anomalies exist and agents configured |
| L20 | loop throws | implemented | `runMonitorCycle()` returns `error` result |
| L21 | duplicate fingerprint ignores `runnerId` noise | implemented | equivalent anomalies dedupe despite runner ID churn |
| L22 | blocked/failed/skipped task type-flapping dedupes as one stuck-task fingerprint | implemented | equivalent stuck-task anomalies dedupe correctly |
| L23 | circuit-breaker alert deduplication | implemented | repeated capped fingerprints do not create duplicate unacked alerts |

#### Response-Mode Scenarios

These are the critical new tests because the current code does not truly enforce them:

| ID | Scenario | Current status | Required assertions |
|---|---|---|---|
| M1 | `monitor_only` with anomalies | missing functionality | no dispatch, row=`anomalies_found`, escalation reason retained |
| M2 | `triage_only` dispatch allowed | missing functionality | dispatch occurs when escalated |
| M3 | `triage_only` rejects mutating actions | missing functionality | `reset_task`, `update_task`, `trigger_wakeup`, etc. are filtered/rejected |
| M4 | `triage_only` allows `query_db` | missing functionality | query action preserved and executed |
| M5 | `triage_only` allows `report_only` | missing functionality | report action preserved |
| M6 | `fix_and_monitor` allows full repair set | partly implemented | mutating actions preserved and executed |
| M7 | `fix_and_monitor` permits fallback repair injection | partly implemented | injection only here, never elsewhere |
| M8 | `custom` requires `custom_prompt` | missing functionality | empty custom prompt rejected at config/command boundary |
| M9 | `custom` remains within host allowlist | missing functionality | unsupported actions filtered even if prompt requests them |
| M10 | legacy `stop_on_error` alias | missing functionality | only `stop_all_runners` / `report_only` permitted |
| M11 | legacy `investigate_and_stop` alias | missing functionality | only `query_db` / `report_only` / `stop_all_runners` permitted |
| M12 | invalid JSON response in non-fix modes | missing functionality | degrades to safe report-only behavior, no repair injection |

#### Command, API, and UI Scenarios

| ID | Scenario | Current status | Required assertions |
|---|---|---|---|
| C1 | CLI help exposes canonical modes | missing functionality | help text lists canonical mode names |
| C2 | API save/load round-trips canonical modes | missing functionality | config returns same saved mode |
| C3 | API rejects `custom` without prompt | missing functionality | 400 response |
| C4 | API accepts legacy preset values but marks them deprecated | missing functionality | compatibility preserved |
| C5 | CLI `monitor run` honors `monitor_only` | missing functionality | no dispatch |
| C6 | CLI/API manual `forceDispatch` ignored for `monitor_only` | missing functionality | mode policy wins over force |
| C7 | CLI/API manual `forceDispatch` works for triage/fix/custom | missing functionality | dispatch occurs if anomalies exist |
| C8 | WebUI shows the four canonical modes | missing functionality | labels and descriptions match contract |
| C9 | WebUI does not offer legacy presets for new saves | missing functionality | only canonical modes shown |
| C10 | run detail/status badges distinguish no-dispatch vs dispatched vs completed | partly implemented | outcome labels stay accurate |
| C11 | manual investigate of a `monitor_only` run requires explicit override | missing functionality | no accidental dispatch from monitor-only config |
| C12 | manual investigate with explicit override from a `monitor_only` run succeeds | missing functionality | selected override mode is enforced |

### 6. Test Architecture

Create a dedicated `tests/monitor/` area with small, single-responsibility files:

| File | Responsibility |
|---|---|
| `tests/monitor/scanner-detection.test.ts` | anomaly-type matrix |
| `tests/monitor/scanner-suppression.test.ts` | suppressions and expiry |
| `tests/monitor/loop-state-machine.test.ts` | non-mode loop branching |
| `tests/monitor/loop-dispatch.test.ts` | dispatch, cooldown, circuit breaker, pruning |
| `tests/monitor/response-mode-policy.test.ts` | host-enforced action policy per mode |
| `tests/monitor/respond-command.test.ts` | `steroids monitor respond` / preset override / update rows |
| `tests/monitor/command-api-contract.test.ts` | CLI/API config and manual-run contract |
| `WebUI/src/pages/__tests__/MonitorPage.test.tsx` | UI mode labels and save/load contract |
| `tests/monitor/coverage-contract.test.ts` | every required scenario ID has a suite owner |

Shared test utilities:

| File | Responsibility |
|---|---|
| `tests/monitor/fixtures/global-monitor-db.ts` | create global DB using real monitor schema |
| `tests/monitor/fixtures/project-monitor-db.ts` | create project DB fixtures for anomaly scenarios |
| `tests/monitor/fixtures/scan-results.ts` | deterministic anomaly fixtures for loop tests |
| `tests/monitor/fixtures/time.ts` | fake clock helpers |
| `tests/monitor/scenario-registry.ts` | scenario IDs and descriptions only |

Design constraints for the tests:

1. Use real schema setup, not inline schema drift where avoidable.
2. Mock only the external edges: child-process spawn, provider invocation, current time, and filesystem presence.
3. Keep scanner, loop, and policy code real in the tests intended to validate them.
4. Do not build a single mega-harness that scripts inputs and expected outcomes from one table.
5. Each suite must assert branch-specific side effects, not only terminal outcome strings.
6. `response-mode-policy.test.ts` must include negative-path tests where the mocked model returns disallowed actions for the active mode, and the host is expected to reject or filter them.

### 7. File-Level Implementation Plan

#### Product code

- [src/monitor/response-mode.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/response-mode.ts)
  - new canonical mode and legacy alias logic
  - mode policy lookup
  - prompt label/description helpers shared by CLI/API/UI
- [src/monitor/loop.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/loop.ts)
  - respect `monitor_only`
  - enforce entrypoint-missing dispatch failure instead of silent false-dispatch
  - keep mode decision logic centralized
- [src/monitor/investigator-prompt.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/investigator-prompt.ts)
  - build prompt text from canonical modes
  - add explicit non-mutation instruction for `triage_only`
- [src/monitor/investigator-agent.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/monitor/investigator-agent.ts)
  - filter actions by mode policy
  - restrict fallback repair injection to `fix_and_monitor`
- [src/commands/monitor-respond.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/commands/monitor-respond.ts)
  - validate mode/prompt override rules
  - pass canonical mode to the responder
- [src/commands/monitor.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/commands/monitor.ts)
  - help text and status output aligned to canonical modes
- [API/src/routes/monitor.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/API/src/routes/monitor.ts)
  - validate canonical modes
  - reject `custom` without prompt
  - expose compatibility for legacy values deliberately
- [WebUI/src/pages/MonitorPage.tsx](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/pages/MonitorPage.tsx)
  - show the four canonical modes only
  - add helper text explaining `monitor_only` vs `triage_only`
- [WebUI/src/services/api.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI/src/services/api.ts)
  - tighten mode typing

#### Documentation

- [README.md](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/README.md)
  - update monitor capability summary
- [docs/cli/COMMANDS.md](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/docs/cli/COMMANDS.md)
  - document canonical monitor modes
- [src/commands/monitor.ts](/System/Volumes/Data/.internal/projects/Projects/steroids-cli/src/commands/monitor.ts)
  - help text is part of the documentation contract

## Implementation Order

### Phase 1: Canonical Contract

1. Add `response-mode.ts` with canonical modes, legacy aliases, and host policies.
2. Replace ad hoc preset string handling in loop, responder, CLI, API, and WebUI with the shared module.
3. Decide the exact compatibility path for legacy stored values and document it in code comments and docs.

### Phase 2: Direct State Enforcement

4. Enforce `monitor_only` as no-dispatch in the loop.
5. Enforce action filtering in the responder by mode.
6. Restrict fallback repair injection to `fix_and_monitor`.
7. Fix false-dispatch behavior when no CLI entrypoint exists.

### Phase 3: Exhaustive Test Harness

8. Add `tests/monitor/scenario-registry.ts` and `coverage-contract.test.ts`.
9. Add scanner anomaly matrix tests.
10. Add loop state-machine and dispatch tests.
11. Add response-mode policy tests.
12. Add respond-command tests.
13. Add API and WebUI contract tests.

### Phase 4: Documentation Alignment

14. Update CLI help and docs to the canonical four modes.
15. Update README monitor description.
16. Record any intentionally missing scenarios as explicit follow-ups, not implicit gaps.

## Progress Update

Completed in this implementation:

- Phase 1 canonical response-mode contract
- Phase 2 host-side enforcement, including `monitor_only` no-dispatch behavior and false-dispatch failure handling
- targeted tests for response-mode policy, loop no-dispatch/dispatch-error behavior, respond-command override rules, and WebUI canonical mode rendering
- README, CLI help text, API payloads, and WebUI mode labels aligned to the canonical four modes

Still planned:

- the exhaustive scanner scenario matrix
- the scenario registry / coverage-contract enforcement
- broader command/API/UI scenario coverage beyond the targeted mode-contract cases above

## Edge Cases

| Scenario | Handling |
|---|---|
| legacy preset present in DB | accepted and handled by explicit compatibility policy, not by accidental prompt fallthrough |
| `custom` mode with empty prompt | rejected at API/CLI boundary |
| model returns mutating action in `triage_only` | action filtered, result recorded as rejected by policy |
| model returns no valid actions in `triage_only` | degrade to `report_only` |
| model returns no valid actions in `fix_and_monitor` | safe fallback injection allowed only if actionable anomalies exist |
| `forceDispatch` used with `monitor_only` | ignored; mode policy wins |
| duplicate anomalies after cooldown-blocked run | not deduplicated away; monitor should retry once cooldown expires |
| dispatch entrypoint missing | row should become `error`, not remain `first_responder_dispatched` |
| scanner cannot open global DB | scan returns clean-empty summary today; if we keep that behavior, document it and test it |
| circuit breaker caps only a subset of projects | alert capped projects, still dispatch for uncapped ones |
| suppressed anomaly should be visible after expiry | suppression expiry is part of the required detector matrix |

## Non-Goals

- Redesigning the anomaly set itself beyond documenting missing detections discovered during implementation.
- Introducing free-form shell access for the first responder.
- Merging monitor tests into the unrelated 50-scenario integration harness.
- Adding real-time WebSocket behavior or notification delivery in this change.

## Cross-Provider Review

### Gemini

Command used:

```bash
timeout 1800 gemini --approval-mode yolo --include-directories /System/Volumes/Data/.internal/projects/Projects/steroids-cli -o text -p "Adversarial review of the monitor design doc ..."
```

Findings and decisions:

| ID | Finding | Assessment | Decision |
|---|---|---|---|
| G1 | Host-enforced mode filtering is the most critical part of the plan because prompt-only presets are unsafe. | Correct. This is the central contract hole in the current system. | Adopt |
| G2 | Legacy presets must be mapped to strict, host-enforced limited action sets instead of being left as prompt-only aliases. | Correct. This preserves compatibility without expanding old modes accidentally. | Adopt |
| G3 | The scenario registry is only safe if expected outcomes stay in suite-local assertions; otherwise it recreates the self-derived-oracle problem. | Correct. The registry remains bookkeeping only, and the test architecture now calls out negative-path assertions explicitly. | Adopt |
| G4 | Silent dispatch failure in `spawnFirstResponder()` is a critical consistency bug, not just a missing test. | Correct. The plan already treats this as required missing functionality and keeps it in scope. | Adopt |
| G5 | The extra modules and test files are justified because they centralize existing complexity rather than adding speculative abstraction. | Correct. This is a simplification-through-centralization change, not over-engineering. | Adopt |
