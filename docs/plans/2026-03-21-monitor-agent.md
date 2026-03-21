# Monitor Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Monitor" page to the WebUI that runs a two-tier autonomous health system: a deterministic scanner + rules engine detects anomalies across all projects and escalates, and a powerful "Investigator" agent (with fallback chain) diagnoses and resolves issues via a structured action interface.

**Architecture:** Two layers: (1) a deterministic health scanner reusing `detectStuckTasks()` + a rules engine that decides escalation without any LLM, (2) an Investigator agent (capable model with fallback chain) that receives structured anomaly data and returns a fixed set of allowed actions executed programmatically. The scanner runs inside wakeup (fast, no AI). If escalation is needed, wakeup spawns a detached monitor process for the LLM invocation. All config and run history lives in the global database.

**Tech Stack:** TypeScript, Express API routes, React + Tailwind WebUI, better-sqlite3 (global DB), existing provider registry for agent invocation.

---

## Problem Statement

When tasks fail, get stuck, runners die, or projects stall, there's no automated system that notices and acts. The operator must manually check the dashboard, diagnose the issue, and intervene. This feature adds an autonomous monitoring loop that detects problems deterministically, applies rules-based escalation, and optionally dispatches a powerful LLM to investigate and fix via a constrained action interface.

## Current Behavior

- `wakeup.ts` runs every 60s and spawns runners for projects with pending work
- `stuck-task-detector.ts` detects 6 failure modes (orphaned tasks, hanging invocations, zombie/dead runners, DB inconsistency, credit exhaustion)
- `stuck-task-recovery.ts` performs automated recovery (reset, kill, skip)
- No cross-project anomaly aggregation or LLM-based diagnosis
- No UI for configuring or viewing autonomous monitoring

## Desired Behavior

A new "Monitor" page at `/monitor` where the user can:
1. Configure 1-N Investigator agents (powerful models with fallback chain)
2. Select a response preset or write a custom prompt
3. Configure escalation rules (which anomaly types/severities trigger investigation)
4. Enable/disable the monitoring loop with a configurable interval
5. View run history with findings and actions taken
6. Clear history

The monitoring loop:
1. Runs deterministic health checks across all projects (reuses existing detector)
2. Applies rules engine to decide if investigation is needed (no LLM)
3. If escalation triggered, spawns a detached monitor process that invokes the Investigator
4. Pauses the loop while an investigation is in progress (with expiry timeout)
5. Logs every run to the global DB

## Design

### 1. Global Database Schema (V21)

Two new tables in the global database. Timestamps use INTEGER epoch ms (matching newer schema patterns: `hf_usage`, `workspace_pool_slots`, `provider_backoffs`).

```sql
-- Monitor configuration (singleton row, id=1)
-- Default row inserted in migration
CREATE TABLE IF NOT EXISTS monitor_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  -- JSON array: [{provider, model}, ...] — ordered fallback chain
  investigator_agents TEXT NOT NULL DEFAULT '[]',
  -- 'stop_on_error' | 'investigate_and_stop' | 'fix_and_monitor' | 'custom'
  response_preset TEXT NOT NULL DEFAULT 'investigate_and_stop',
  custom_prompt TEXT,
  -- JSON: escalation rules — which severity/types trigger investigation
  -- Default: any 'critical' anomaly triggers investigation
  escalation_rules TEXT NOT NULL DEFAULT '{"min_severity":"critical"}',
  -- Max seconds an investigation can run before being considered stale
  investigation_timeout_seconds INTEGER NOT NULL DEFAULT 900,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- Insert default config row
INSERT OR IGNORE INTO monitor_config (id, updated_at) VALUES (1, 0);

-- Monitor run log
CREATE TABLE IF NOT EXISTS monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  -- 'clean' | 'anomalies_found' | 'investigation_dispatched' | 'investigation_complete' | 'error'
  outcome TEXT NOT NULL DEFAULT 'clean',
  -- JSON: deterministic scan results
  scan_results TEXT,
  -- Rules engine decision summary
  escalation_reason TEXT,
  -- Whether rules engine triggered investigation
  investigation_needed INTEGER DEFAULT 0,
  -- Which investigator agent was used (provider:model)
  investigator_agent TEXT,
  -- JSON: structured actions the investigator requested
  investigator_actions TEXT,
  -- Investigator's diagnostic report (raw text)
  investigator_report TEXT,
  -- JSON: results of executing each action
  action_results TEXT,
  -- Error message if something failed
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitor_runs_started ON monitor_runs(started_at DESC);
```

### 2. Deterministic Health Scanner (`src/monitor/scanner.ts`)

Runs across ALL registered projects. No AI involved. **Reuses `detectStuckTasks()` from `stuck-task-detector.ts`** for all runner/task health checks (no duplication). Only adds genuinely new cross-project checks.

**Checks performed:**
- **Stuck tasks** (via `detectStuckTasks()`): Maps all 6 failure modes (`orphaned_task`, `hanging_invocation`, `zombie_runner`, `dead_runner`, `db_inconsistency`, `credit_exhaustion`) to the `Anomaly` type. Single source of truth.
- **Failed/skipped tasks**: Query each project DB for `status IN ('failed', 'skipped')` — not covered by stuck-task-detector
- **Idle projects**: Projects with pending tasks but no active runner and cron installed — not covered by detector
- **High invocation counts**: Tasks approaching `maxInvocationsPerTask` limit — not covered by detector
- **Repeated failures**: Tasks with `failure_count >= 2` or `rejection_count >= 5` — not covered by detector

**Does NOT duplicate:** Stale runners, orphaned runners, zombie runners — all already in `detectStuckTasks()`.

Returns:
```typescript
interface ScanResult {
  timestamp: number; // epoch ms
  projectCount: number;
  anomalies: Anomaly[];
  summary: string;
}

interface Anomaly {
  type: 'orphaned_task' | 'hanging_invocation' | 'zombie_runner' | 'dead_runner' |
        'db_inconsistency' | 'credit_exhaustion' |
        'failed_task' | 'skipped_task' | 'idle_project' | 'high_invocations' | 'repeated_failures';
  severity: 'info' | 'warning' | 'critical';
  projectPath: string;
  projectName: string;
  taskId?: string;
  taskTitle?: string;
  runnerId?: string;
  details: string;
  context: Record<string, unknown>;
}
```

**Severity mapping:**
- `critical`: orphaned_task, hanging_invocation, zombie_runner, dead_runner, credit_exhaustion
- `warning`: failed_task, skipped_task, repeated_failures, high_invocations
- `info`: idle_project, db_inconsistency

### 3. Rules Engine (`src/monitor/rules.ts`)

**Replaces the Monitor LLM tier.** Deterministic escalation logic — no AI, no JSON parsing, no non-determinism. Evaluates scanner output against configurable rules.

Default rule: escalate if any anomaly has `severity >= min_severity` from config.

```typescript
interface EscalationRules {
  min_severity: 'info' | 'warning' | 'critical';
  // Future: per-type overrides, anomaly count thresholds, etc.
}

function shouldEscalate(anomalies: Anomaly[], rules: EscalationRules): {
  escalate: boolean;
  reason: string;
}
```

This is a simple threshold check today. If users need more nuanced rules in the future, this is where they go — not an LLM.

### 4. Investigator Agent Tier (`src/monitor/investigator-agent.ts`)

Only invoked when the rules engine says to escalate. Uses the first available agent from the `investigator_agents` fallback chain.

**Structured Action Interface** (the Investigator returns JSON, NOT free-form shell commands):

```typescript
type InvestigatorAction =
  | { action: 'reset_task'; projectPath: string; taskId: string; reason: string }
  | { action: 'kill_runner'; runnerId: string; reason: string }
  | { action: 'stop_all_runners'; reason: string }
  | { action: 'trigger_wakeup'; reason: string }
  | { action: 'report_only'; diagnosis: string };

interface InvestigatorResponse {
  diagnosis: string;
  actions: InvestigatorAction[];
}
```

The Investigator LLM receives the anomaly list and response preset, returns a JSON response. The host code validates each action against the allowed set and executes them programmatically. **The LLM never gets shell access.** Invalid actions are logged and skipped.

**Fallback chain algorithm:**
1. For each agent in order: check `isAvailable()` (CLI binary exists), check `getProviderBackoffRemainingMs() === 0`
2. Invoke the first available agent
3. On retryable error (rate_limit, network_error): try next agent
4. On non-retryable error (auth_error, model_not_found): fail the chain immediately
5. If all agents exhausted: log error, mark run as `error`

**Resource constraints:**
- Invocation timeout: 5 minutes (configurable via `investigation_timeout_seconds / 3` per attempt)
- Check system pressure before spawning (`checkSystemPressure()`)
- `NODE_OPTIONS=--max-old-space-size=1536` on child process

### 5. Monitor Loop (`src/monitor/loop.ts`)

**The scanner + rules engine run inside wakeup (fast, deterministic, <1s).** If escalation is needed, wakeup spawns a **detached child process** (`steroids monitor investigate`) that runs the LLM invocation independently. The wakeup process does NOT wait for it.

```
monitorCheck() — called from wakeup, must complete in <5s:
  1. Read monitor_config from global DB
  2. If not enabled, return
  3. If interval not elapsed since last run, return
  4. Check for stale investigations:
     - If a run has outcome='investigation_dispatched' AND
       started_at + investigation_timeout_seconds < now:
       → Mark as error ("stale investigation timed out"), clear the lock
  5. If a run with outcome='investigation_dispatched' exists (not timed out), return (pause)
  6. Run deterministic scanner (reuses detectStuckTasks + new checks)
  7. Apply rules engine
  8. Create monitor_runs row
  9. If no anomalies or no escalation: update row outcome='clean' or 'anomalies_found', return
  10. Update row outcome='investigation_dispatched'
  11. Spawn detached: `steroids monitor investigate --run-id <id>`
      → This process runs the Investigator agent independently
```

```
investigateCommand(runId) — detached process, no timeout from wakeup:
  1. Read the monitor_runs row
  2. Parse scan_results
  3. Invoke Investigator agent (with fallback chain)
  4. Validate returned actions against allowed set
  5. Execute valid actions programmatically
  6. Update row: outcome='investigation_complete', investigator_report, action_results
  7. On any error: update row outcome='error', error message
  8. Exit
```

### 6. API Routes (`API/src/routes/monitor.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/monitor/config` | Get current monitor config |
| PUT | `/api/monitor/config` | Update monitor config |
| GET | `/api/monitor/runs` | List runs (paginated, newest first) |
| GET | `/api/monitor/runs/:id` | Get single run with full details |
| POST | `/api/monitor/runs/clear` | Delete all run history |
| POST | `/api/monitor/scan` | Trigger manual scan (deterministic only, returns results) |
| POST | `/api/monitor/run` | Trigger manual full run (scan + investigate if needed). Idempotency: rejects if investigation already in progress |

### 7. WebUI Page (`WebUI/src/pages/MonitorPage.tsx`)

**Layout (top to bottom):**

1. **Header**: "Monitor" title + enable/disable toggle + manual "Run Now" / "Scan Only" buttons
2. **Investigator Configuration** (collapsible, reuses `AISetupRoleSelector` pattern):
   - "Investigator Agents" section: ordered list of provider/model dropdowns with +/- and drag-to-reorder
   - Interval dropdown (1min, 2min, 5min, 10min, 15min, 30min)
   - Escalation severity threshold dropdown (Critical / Warning / Info)
3. **Response Preset**: Radio buttons for the 3 presets + "Custom" with textarea
   - Stop on Error: "When anomalies are detected, stop all runners and report."
   - Investigate & Stop: "Investigate what's happening, provide a diagnostic report, then stop runners."
   - Fix & Monitor: "Attempt to fix issues automatically (reset tasks, restart runners), keep monitoring."
   - Custom: User-provided prompt textarea
4. **Run History** table:
   - Columns: Time, Outcome (badge), Anomalies, Escalation, Actions Taken, Duration
   - Each row expandable to show full scan results, diagnosis, and action results
   - "Clear History" button above table
   - Auto-prune: keep last 500 rows (prune on insert)
5. **Save button** for configuration changes

### 8. Sidebar Navigation

Add "Monitor" nav item between "Runners" and "Intake" in the sidebar with `ShieldCheckIcon`.

### 9. CLI Commands (`src/commands/monitor.ts`)

- `steroids monitor scan` — run deterministic scanner, print results
- `steroids monitor run` — full cycle (scan + investigate if needed)
- `steroids monitor investigate --run-id <id>` — internal command for detached investigation process
- `steroids monitor status` — show config and last few runs
- `steroids monitor enable/disable` — toggle from CLI

## Implementation Order

### Phase 1: Database + Scanner (backend foundation)
1. Add V21 migration with `monitor_config` and `monitor_runs` tables
2. Create `src/monitor/scanner.ts` — reuses `detectStuckTasks()`, adds new checks
3. Create `src/monitor/rules.ts` — deterministic escalation logic
4. Add tests for scanner and rules engine

### Phase 2: API Routes
5. Create `API/src/routes/monitor.ts` with config CRUD and run history endpoints
6. Register route in `API/src/index.ts`
7. Add manual scan endpoint

### Phase 3: Investigator Agent + Loop
8. Create `src/monitor/investigator-agent.ts` with structured action interface + fallback chain
9. Create `src/monitor/loop.ts` with `monitorCheck()` for wakeup integration
10. Create `src/commands/monitor.ts` with CLI commands including detached `investigate`
11. Integrate `monitorCheck()` into wakeup cycle (call after runner spawns)
12. Add tests for investigator action validation and loop logic

### Phase 4: WebUI
13. Create `WebUI/src/pages/MonitorPage.tsx` with investigator config section
14. Add monitor API client to `WebUI/src/services/api.ts`
15. Add route to `App.tsx` and nav item to `Sidebar.tsx`
16. Add run history table with expandable rows
17. Add response preset selector and escalation config

### Phase 5: Integration + Polish
18. Wire "Run Now" button with idempotency guard
19. Add auto-prune for run history (keep last 500)
20. Test end-to-end flow

## Edge Cases

| Scenario | Handling |
|----------|----------|
| All investigator agents fail (rate limit/auth) | Log error, mark run as error, unpause for next cycle |
| Non-retryable error (auth, model_not_found) | Fail chain immediately, don't try remaining agents |
| Investigation process crashes (SIGKILL/OOM) | `investigation_timeout_seconds` expiry clears the lock on next wakeup |
| Investigation takes longer than interval | Loop sees `investigation_dispatched`, skips until complete or expired |
| No projects registered | Scanner returns empty, no anomalies, no agent invoked |
| Investigator returns invalid JSON | Treat as `report_only` with raw text as diagnosis, log parse error |
| Investigator returns disallowed action | Skip that action, log warning, execute remaining valid actions |
| Global DB locked during scan | Retry once after 1s, then skip cycle |
| User disables monitor mid-investigation | Current investigation completes, next cycle respects disabled |
| User clicks "Run Now" while investigation in progress | API returns 409 Conflict |
| Same anomalies persist across cycles | Investigation runs once; if anomalies persist after fix, next cycle re-evaluates |

## Non-Goals

- **No source code modification**: The investigator operates on DB/runner state only via structured actions.
- **No per-project monitor config**: Monitor is global, watches all registered projects.
- **No alerting/notifications**: Future work. Currently findings are only in the run history table.
- **No real-time WebSocket updates**: Polling-based like the rest of the WebUI.
- **No Monitor LLM tier**: Escalation is deterministic (rules engine). LLM is only used for investigation.

---

## Cross-Provider Review

### Reviewers
- **Claude** (code-reviewer agent): Thorough adversarial review, read full codebase
- **Gemini** (CLI): Adversarial review against design doc + AGENTS.md

### Findings and Decisions

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| C1 | Wakeup timeout (30-45s) makes LLM invocation impossible inside wakeup cycle | Both | **Adopt.** Scanner + rules run inside wakeup (<5s). LLM invocation spawned as detached process `steroids monitor investigate`. |
| C2 | Pause mechanism (`investigation_dispatched`) can get permanently stuck if process dies | Both | **Adopt.** Added `investigation_timeout_seconds` (default 900s). Wakeup checks for stale investigations and marks them as error. Same pattern as `lease_expires_at` in workstreams. |
| C3 | Investigator scope under-constrained — LLM with shell access is unsafe | Claude | **Adopt.** Replaced free-form CLI access with structured action interface (`InvestigatorAction` union type). Host validates each action before programmatic execution. LLM never gets shell access. |
| G3 | Monitor LLM tier is unnecessary complexity — deterministic rules suffice for escalation | Gemini | **Adopt.** Eliminated Monitor agent tier entirely. Replaced with deterministic rules engine (`src/monitor/rules.ts`). Simpler, cheaper, faster, more reliable. Complies with "Determinism First" in AGENTS.md. |
| I1 | Scanner duplicates stuck-task-detector checks (stale/orphaned runners) | Both | **Adopt.** Scanner now reuses `detectStuckTasks()` as single source of truth. Only adds genuinely new checks (failed tasks, idle projects, high invocations, repeated failures). |
| I2 | Monitor LLM expects JSON from cheap model — fragile, non-deterministic | Claude | **Adopt (moot).** Monitor LLM tier eliminated per G3. Only the Investigator parses JSON, and it's a capable model. Invalid JSON falls back to `report_only`. |
| I3 | DB timestamps should use INTEGER epoch ms, not TEXT datetime | Claude | **Adopt.** All timestamps in new tables use INTEGER epoch ms, matching `hf_usage`, `workspace_pool_slots`, `provider_backoffs`. |
| I4 | Fallback chain needs precise algorithm with availability + backoff checks | Claude | **Adopt.** Defined explicit algorithm: check `isAvailable()`, check `getProviderBackoffRemainingMs()`, invoke, fall back only on retryable errors. |
| I5 | Investigation needs timeout + resource caps + pressure checks | Claude | **Adopt.** Added 5min per-attempt timeout, system pressure check, NODE_OPTIONS heap cap. |
| S1 | Singleton config needs default row in migration | Claude | **Adopt.** Added `INSERT OR IGNORE` in migration SQL. |
| S3 | Manual "Run Now" has no idempotency guard | Claude | **Adopt.** API returns 409 if investigation already in progress. |
| S4 | Run history needs retention limit | Claude | **Adopt.** Auto-prune to 500 rows on insert. |
| S5 | AISetupRoleSelector may not support ordered lists | Claude | **Defer.** Will verify during Phase 4 and build ordered-list component if needed. |
| G5 | Failed investigation retry loop risk | Gemini | **Adopt (partially).** The expiry timeout + rules engine means we won't retry the exact same anomaly set in a tight loop — the scanner must find anomalies again, and the rules engine must re-trigger. If the same anomalies persist after 3 consecutive failed investigations, add exponential backoff as follow-up. |
| G6 | Investigator could hallucinate catastrophic actions (e.g., reset all tasks) | Gemini | **Mitigated.** Structured action interface means each action is validated. Additional guard: `reset_task` requires explicit `taskId` (no wildcards), `kill_runner` requires explicit `runnerId`. No "batch" actions. |
