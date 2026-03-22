# Monitor Issues — Audit & Fix Plan

> Generated from analysis of 92 monitor runs (2026-03-21 15:44 — 2026-03-22 07:52).
> 301 total anomaly occurrences, 28 unique task-level issues, 7 affected projects.

---

## Part 1: Monitor Issues (low-hanging fruit)

These are bugs in the monitor subsystem itself — the scanner, the loop, the first responder dispatch, and the retry/remediation logic. All changes are contained within `src/monitor/` and `src/commands/monitor.ts`.

---

### [ ] M1: Follow-up scan creates an infinite dispatch chain

**Severity:** Critical — this burned 30+ consecutive FR invocations overnight (runs 59-92).

**What happens:** After a successful first responder run, `src/commands/monitor.ts:406-413` triggers a follow-up scan:

```ts
// monitor.ts:406-413
if (result.success) {
  const { runMonitorCycle } = await import('../monitor/loop.js');
  await runMonitorCycle({ manual: true });
}
```

`runMonitorCycle({ manual: true })` bypasses the duplicate-detection gate at `loop.ts:274-276`:

```ts
// loop.ts:274-276
if (!options?.manual && isDuplicateOfLastRun(scanResult)) {
  return { outcome: 'skipped', anomalyCount: scanResult.anomalies.length };
}
```

If any anomaly persists (like the false-positive `idle_project`), the follow-up scan finds it, escalates, spawns a new FR, which completes, triggers another follow-up scan... ad infinitum.

**Evidence:** Runs 59 through 90 form a continuous chain with no gap — each run's `started_at` equals the previous run's `completed_at`. 30+ FR invocations over ~2 hours, all diagnosing the same two `idle_project` false positives.

**Fix:** Remove `manual: true` from the follow-up scan call so the duplicate gate applies. Alternatively, replace the follow-up scan entirely with a simple row insert that records the post-fix scan results without triggering dispatch. The follow-up was only meant to refresh the dashboard, not to restart the loop.

**Files:** `src/commands/monitor.ts:406-413`

---

### [ ] M2: Remediation attempt tracking exists but is never used as a circuit breaker

**Severity:** High — the system retries the same failing remediation indefinitely.

**What happens:** `loop.ts:192-201` defines `countRemediationAttempts()` and `loop.ts:207-216` defines `recordRemediationAttempt()`. Every dispatch records an attempt. But the count is **never checked before dispatching**. The function `countRemediationAttempts` is dead code.

The `monitor_remediation_attempts` table shows **43+ attempts** for warehouse/`idle_project` and 43+ for prompter/`idle_project` — all doing the same `trigger_wakeup` that accomplishes nothing.

**Evidence:**
```sql
SELECT project_path, anomaly_fingerprint, COUNT(*) as attempts
FROM monitor_remediation_attempts
GROUP BY project_path, anomaly_fingerprint
ORDER BY attempts DESC;
-- warehouse / idle_project: 43+
-- prompter / idle_project,skipped_task: 20+
-- prompter / idle_project,repeated_failures: 15+
```

**Fix:** In both `monitorCheck()` (loop.ts:254-262) and `runMonitorCycle()` (loop.ts:294-300), before dispatching the FR, call `countRemediationAttempts()` for each affected project. If any project+fingerprint has >= 5 attempts, skip the dispatch for that project. Record outcome as `max_remediation_attempts` and log it. Also add a TTL-based cleanup — clear old remediation attempts after 24h so the system can retry after a real fix is deployed.

**Files:** `src/monitor/loop.ts:192-201` (existing dead code), `src/monitor/loop.ts:254-262` (wakeup path), `src/monitor/loop.ts:294-300` (manual path)

---

### [ ] M3: Auth failure kills the entire provider fallback chain

**Severity:** Medium — caused 3 failed runs (20, 91, 92).

**What happens:** When a provider returns a non-retryable error (like "Authentication failed"), `investigator-agent.ts:558-573` immediately returns failure instead of trying the next provider in the chain:

```ts
// investigator-agent.ts:558-573
if (!result.success) {
  const classified = provider.classifyResult(result);
  const errMsg = classified?.message ?? result.stderr.slice(0, 200);
  if (classified?.retryable) {
    console.warn(...);
    continue; // <-- only retryable errors fall through
  }
  return { success: false, ... }; // <-- non-retryable = hard stop
}
```

The `isRetryableError` helper (line 509-511) checks for "rate", "limit", "timeout", "network" but not "auth" or "authentication". An auth failure is not retryable on the **same** provider, but should absolutely fall through to the **next** provider.

**Evidence:** Run 20 (17:41), run 91 (01:35), run 92 (07:52) — all "Authentication failed". The config has 3 agents (claude, codex/gpt-5.4, codex/gpt-5.3-codex-spark) but only claude was tried.

**Fix:** In the non-retryable branch at line 564, instead of returning, check if the error is auth-related. If so, `continue` to the next agent. Alternatively, simplify: always `continue` to the next agent on any error (retryable or not), and only `return` failure after all agents are exhausted. The for-loop already handles exhaustion at line 601-608.

**Files:** `src/monitor/investigator-agent.ts:558-573`, `src/monitor/investigator-agent.ts:509-511`

---

### [ ] M4: First responder ignores "MUST act on blocking issues" instruction

**Severity:** Low — the prompt is clear but the FR LLM sometimes ignores it.

**What happens:** The prompt at `investigator-prompt.ts:129` says:

```
Blocking issues (blocked_task, idle_project, orphaned_task) MUST be acted upon — do NOT use report_only for these.
```

But run 16's FR returned `report_only` for 9 `blocked_task` anomalies. The instruction is not enforced programmatically.

**Evidence:** Run 16 — FR returned a single `report_only` action for 9 blocked tasks + 2 idle projects. All 11 anomalies were left unresolved.

**Fix:** In `investigator-agent.ts`, after parsing the FR response (`parseFirstResponderResponse`), validate that blocking anomaly types from the scan have a corresponding non-`report_only` action. If the FR only returned `report_only` for a scan containing blocking issues, either re-prompt (expensive) or inject a default `reset_task`/`trigger_wakeup` action automatically. The simpler approach: after `executeActions()`, check if any blocking anomalies were left unaddressed and append a `trigger_wakeup` as a safety net.

**Files:** `src/monitor/investigator-agent.ts:575-577` (after parseFirstResponderResponse), `src/monitor/investigator-prompt.ts:129`

---

### [ ] M5: Duplicate detection fingerprint doesn't account for context changes

**Severity:** Low — causes unnecessary skips or unnecessary dispatches.

**What happens:** `isDuplicateOfLastRun()` at `loop.ts:99-120` compares anomaly fingerprints using `type|severity|projectPath|taskId|runnerId`. This misses context changes — e.g., a task's invocation count increasing from 116 to 130 produces the same fingerprint, so the scan is skipped even though the situation worsened. Conversely, a runner PID change creates a different fingerprint even when the anomaly is semantically identical.

**Fix:** Include meaningful context fields in the fingerprint (invocation count ranges, failure counts) and exclude volatile fields (runnerId, exact PID). Consider a "severity escalation" check: if any anomaly's context shows worsening metrics vs. the previous run, treat it as non-duplicate.

**Files:** `src/monitor/loop.ts:99-120`

---

### [ ] M6: `project_disabled` outcome type is orphaned

**Severity:** Cosmetic — confusing but not breaking.

**What happens:** The `MonitorCycleResult` type at `loop.ts:31` still includes `'project_disabled'` as a valid outcome, and 17 DB rows have this outcome. But the code that produced it (introduced in commit `e894f83`, later removed in `d0c41e7`) no longer exists. The type is a lie — this outcome can never be produced by current code.

**Evidence:** `grep -r "project_disabled" src/` returns nothing. But `SELECT COUNT(*) FROM monitor_runs WHERE outcome = 'project_disabled'` returns 17.

**Fix:** Remove `'project_disabled'` from the `MonitorCycleResult` type union. The existing DB rows are fine — they're historical records. If the disable-project-after-N-attempts feature should come back, reimplement it properly (see M2 — the circuit breaker is the right abstraction).

**Files:** `src/monitor/loop.ts:31`

---

### [ ] M7: No cooldown between FR dispatches

**Severity:** Medium — compounds M1 but is independently useful.

**What happens:** Neither `monitorCheck()` nor `runMonitorCycle()` checks how recently the last FR was dispatched. The `monitorCheck` path has an interval check (`loop.ts:229-230`) but that's based on the last *scan* start time, not the last *FR dispatch* time. The follow-up scan path (`monitor.ts:409`) bypasses even that.

A completed FR triggers a new scan immediately, which dispatches a new FR immediately. There's no minimum gap.

**Evidence:** Runs 72-78 each started the instant the previous one completed. 7 consecutive FR invocations in 20 minutes.

**Fix:** Add a minimum FR dispatch cooldown (e.g., 10 minutes). Before dispatching in both `monitorCheck()` and `runMonitorCycle()`, check the most recent `monitor_runs` row with `outcome IN ('first_responder_complete', 'first_responder_dispatched', 'investigation_complete')`. If it completed less than 10 minutes ago and the current scan's fingerprint matches, skip dispatch.

**Files:** `src/monitor/loop.ts:254-262` (wakeup path), `src/monitor/loop.ts:294-300` (manual path)

---

### [ ] M8: No escalation-to-human mechanism

**Severity:** Medium — the system silently burns API credits on unfixable issues.

**What happens:** When the FR fails to resolve an issue after multiple attempts, there is no way to notify the user. The system either keeps retrying (M2) or silently stops (if the project gets disabled). The "Initialize Android project" task in prompter was reset by the FR **at least 10 times** across 51 run appearances without ever making progress.

**Evidence:** Task `d871ce3c` in prompter cycled through `repeated_failures` -> FR reset -> fail -> `skipped` -> FR reset -> `blocked_error` -> FR reset, appearing in nearly every run from 22 to 92. Currently sitting at `pending` with zeroed counters — will fail again on next runner pickup.

**Fix:** After the circuit breaker (M2) prevents further FR dispatches, write an entry to a new `monitor_alerts` table (or a simple JSON file at `~/.steroids/alerts/`). The WebUI dashboard can poll this for user-facing notifications. Minimal schema: `{ project_path, anomaly_fingerprint, attempts, last_attempted_at, acknowledged }`. The `steroids monitor status` command should also surface unacknowledged alerts.

**Files:** New table in global DB migration, `src/monitor/loop.ts` (after circuit breaker logic), `src/commands/monitor.ts` (status subcommand)

---

## Part 2: Systemic Issues (core engine fixes)

These are bugs in the scanner's data sources, the runner lifecycle, and the wakeup/sanitisation pipeline. Changes touch `src/monitor/scanner.ts`, `src/health/`, `src/runners/`, and potentially `src/orchestrator/`.

---

### [ ] S1: Scanner `hasActiveRunner()` misses parallel-session runners

**Severity:** Critical — this is the single root cause of 189 out of 301 anomaly occurrences.

**What happens:** `scanner.ts:93-103` checks only the `runners` table:

```ts
function hasActiveRunner(globalDb: Database.Database, projectPath: string): boolean {
  const row = globalDb
    .prepare(
      `SELECT 1 FROM runners
       WHERE project_path = ?
         AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes')`)
    .get(projectPath);
  return row !== undefined;
}
```

Parallel session runners (managed through `parallel_sessions` and `workstreams` tables) and freshly-spawned runners that haven't registered a heartbeat yet are invisible to this query. The FR itself diagnosed this in multiple runs:

- **Run 73:** "Both idle_project CRITICAL anomalies are FALSE POSITIVES. Investigation shows: Warehouse: Runner PID 45123 is active, working on task..."
- **Run 85:** "Both projects have active runners with fresh heartbeats (within 2 minutes of scan time). Runners operate on parallel workspace copies which the scan may not recognize as active."

**Evidence:** warehouse and prompter flagged as `idle_project` in **all 92 runs**. The FR's own `query_db` actions confirmed active runners in the project databases.

**Fix:** Expand the runner detection to also check:

1. `parallel_sessions` table for `status = 'running'` matching the project path (with fresh `updated_at`)
2. `task_invocations` in the project DB for any `status = 'running'` with `started_at_ms` within the last 10 minutes

The query should be:

```sql
-- Check 1: Direct runner registration (existing)
SELECT 1 FROM runners WHERE project_path = ? AND status != 'stopped' AND heartbeat_at > datetime('now', '-5 minutes')

-- Check 2: Active parallel session
SELECT 1 FROM parallel_sessions WHERE project_path = ? AND status = 'running'

-- Check 3: Active task invocation in project DB (requires project DB access)
SELECT 1 FROM task_invocations WHERE status = 'running' AND started_at_ms > ?
```

If any of the three returns a row, the project has active work.

**Files:** `src/monitor/scanner.ts:93-103` (primary fix), `src/monitor/scanner.ts:427-439` (idle_project anomaly creation)

---

### [ ] S2: Orphaned task not cleaned up by wakeup sanitiser

**Severity:** High — tasks can stay orphaned for hours.

**What happens:** The live scan right now shows prompter's "Build Android Dashboard and Editor screens" task orphaned for 5356+ seconds (~89 minutes) with no active runner. The wakeup sanitiser (`src/runners/wakeup-sanitise.ts`) should clean this up, but either:

1. The sanitiser is skipping it due to the `hasActiveParallelContext` guard (documented in MEMORY.md under "Runner SIGTERM Death Loop Fix")
2. The wakeup cron isn't running effectively for this project

**Evidence:** Live scan output: `[CRITICAL] orphaned_task: prompter — Task "Build Android Dashboard and Editor screens" orphaned for 5356s with no active runner`

The task is `in_progress` in the prompter DB but has no corresponding running invocation or runner.

**Investigation needed:** Check `parallel_sessions` for prompter — if there's a stale `status='running'` row, the sanitiser skips orphan cleanup for the entire project. This is the known `hasActiveParallelContext` guard issue.

**Fix:** The sanitiser should clean up orphaned tasks **regardless** of parallel session state if the task has been orphaned for > 30 minutes. The parallel session guard was meant to prevent killing active runners during normal parallel work, but a 30-minute orphan is clearly not "normal." Add a time-based override to `wakeup-sanitise.ts`.

**Files:** `src/runners/wakeup-sanitise.ts` (sanitiser logic), `src/health/stuck-task-detector.ts` (orphan detection threshold)

---

### [ ] S3: Stuck "disputed" tasks block section progress

**Severity:** Medium — task blocks all siblings in its section.

**What happens:** The FR discovered in run 90 that warehouse task `581e0906` ("Pending request admin API") was stuck in `disputed` status due to an arbitration provider crash (exit code 143), not a genuine coder-reviewer disagreement:

> "Task is stuck in 'disputed' status due to an arbitration provider crash (exit 143), not a real disagreement. Both reviewers subsequently approved the coder's work (success=1)."

The task-selector (`src/orchestrator/task-selector.ts:177`) skips sections with `active_count > 0` (in_progress/review/disputed), so a stuck `disputed` task blocks all sibling tasks.

**Evidence:** Run 90 FR report. The task currently shows 3 failures and is back to `pending` (FR reset it), but the underlying issue — arbitration crashes leaving tasks in `disputed` forever — is unaddressed.

**Fix:** The dispute resolution logic should have a timeout. If a task has been `disputed` for > 30 minutes with no active arbitration invocation, auto-reset to `pending`. This could be added to `wakeup-sanitise.ts` or to `stuck-task-detector.ts`.

**Files:** `src/orchestrator/task-selector.ts` (section skip logic), `src/runners/wakeup-sanitise.ts` or `src/health/stuck-task-detector.ts` (timeout-based auto-reset)

---

### [ ] S4: Merge-conflict blocked tasks require manual intervention

**Severity:** Medium — 15 occurrences across 4 projects, no auto-recovery.

**What happens:** When a task branch diverges from the target branch and the runner's merge/rebase fails, the task transitions to `blocked_conflict`. There is no automatic recovery — the FR can reset the task to `pending`, which makes the runner retry with a fresh checkout, but if the conflict recurs (because the branch still diverges), it blocks again.

**Evidence:** Run 16 had 9 `blocked_conflict` tasks across steroids-cli (1), Technician (6), monorepo (1), and translatemy.world (1). Technician had 6 tasks blocked simultaneously, suggesting its main branch moved significantly while multiple task branches were in flight.

**Current state:** Technician and monorepo are disabled (`enabled=0`). The steroids-cli task was reset by the FR and resolved. translatemy.world was disabled.

**Fix options:**
1. When a task hits `blocked_conflict`, the runner should attempt a branch reset (delete the task branch, recreate from current main) before blocking. This is a "start fresh" strategy.
2. Add a `steroids tasks reset --blocked` command that bulk-resets all `blocked_conflict` tasks with branch cleanup. The FR already knows to call this via `reset_project`.
3. For the currently disabled projects: decide whether to re-enable them and let the runner retry, or manually resolve the conflicts.

**Files:** `src/orchestrator/` (coder phase merge logic), `src/commands/tasks.ts` (reset command)

---

### [ ] S5: Persistent task failures with no learning (prompter Android init)

**Severity:** Medium — affects task completion rates for complex environment-dependent tasks.

**What happens:** The "Initialize Android project with Jetpack Compose, Gradle dependencies, and AppReveal debug-only" task in prompter appeared in **51 monitor runs** (runs 22-92). It cycled through: `repeated_failures` -> FR reset -> fail -> `skipped` -> FR reset -> `blocked_error` -> FR reset -> repeat. The FR added feedback notes multiple times but the coder never succeeded.

**Root cause hypothesis:** Android/Gradle initialization requires specific SDK paths, Java versions, and environment variables that aren't available in the runner's isolated environment. No amount of retry or feedback will fix a missing Android SDK.

**Evidence:** 51 appearances across 70 runs. Task currently at `pending` with zeroed counters — will fail again immediately.

**Fix:** This is partially addressed by M2 (circuit breaker) and M8 (human escalation). The deeper fix is for the runner to detect environment-specific failures (missing SDK, missing build tools) and transition the task to `blocked_error` with a clear message, rather than allowing infinite retries. The coder prompt could also be enhanced to check for prerequisites before attempting the task.

**Files:** `src/orchestrator/coder.ts` (failure classification), `src/prompts/coder.ts` (prerequisite checking guidance)

---

### [ ] S6: Wakeup cron runs but doesn't spawn runners for idle projects

**Severity:** High — directly causes S1's false positives to be partially real.

**What happens:** While S1 describes the scanner's false-positive detection, the reality is mixed. Some of the `idle_project` alerts ARE real — the wakeup cron fires, but runners don't spawn for warehouse/prompter. The FR's `trigger_wakeup` action spawns a wakeup cycle, which may or may not result in a runner.

Possible causes:
1. System pressure guard (`src/runners/system-pressure.ts`) blocking spawns due to low disk space or memory
2. Provider backoff preventing runner from doing useful work (so it exits immediately)
3. All pending tasks have unmet dependencies (nothing to pick up)

**Evidence:** Run 85 FR found 3 active runners (2 for warehouse, 1 for prompter). Run 73 found active runners too. But the scanner still reported `idle_project`. Some runs genuinely had no runners — the FR's `trigger_wakeup` was the correct action for those.

**Investigation needed:** Check `~/.steroids/logs/api.log` for wakeup-time entries showing why runners weren't spawned. Check `system-pressure.ts` thresholds against current system state. Check `provider_backoffs` table for active backoffs.

**Files:** `src/runners/wakeup.ts` (spawning logic), `src/runners/system-pressure.ts` (pressure guard), `src/runners/global-db-backoffs.ts` (backoff table)

---

## Part 3: Early Detection Gaps & FR Effectiveness

Analysis of whether issues could have been caught sooner and whether the FR's actions actually resolved them.

---

### Detection Gap: 1h18m blind window (runs 1-14)

The monitor was deployed with `escalation_rules.min_severity = "critical"` (the hardcoded default at `loop.ts:242`). Runs 1-14 (15:44 — 16:54) detected anomalies at `warning` and `info` severity only — so no FR was ever dispatched.

The config was updated to `min_severity: "warning"` at **17:24** (commit `e894f83` also reclassified `idle_project` with active cron from `info` to `critical`). The first automatic FR dispatch happened at run 18 (17:30).

**What was missed during the blind window:**
- **Technician Prisma task** at 116/150 invocations — detected at run 1 (15:44) but no action until run 15 (17:02, manually triggered). Even then the FR only issued `report_only`. The task was never reset and eventually hit `blocked_conflict` in run 16. **Could have been caught 1h18m earlier** if the initial escalation threshold was `warning`.
- **warehouse + prompter idle_project** — detected at run 1 (15:44) as `info` severity. No action until run 15 (17:02). The severity was wrong — an idle project with active cron is not "informational", it's a real problem. The reclassification to `critical` in commit `e894f83` was correct but came too late.
- **prompter iOS Camera repeated_failures** (6 rejections) — detected at run 1, first reset at run 19 (17:36). **1h52m gap.** The task eventually completed after reset, so earlier action would have unblocked it sooner.

**Lesson:** The default escalation threshold should be `warning`, not `critical`. The `info` severity should be reserved for things that genuinely require no action (skipped tasks, completed tasks with high counts). Anything the system _could_ fix should be at least `warning`.

---

### Detection Gap: Blocked tasks — FR chose inaction

Run 16 (17:07) detected **9 `blocked_conflict` tasks across 4 projects**. The FR was dispatched and diagnosed all of them correctly. But it chose `report_only`:

> "Blocked tasks will need reset_project/reset_task actions or manual conflict resolution in a follow-up if the user wants to recover them."

This directly contradicted the prompt instruction at `investigator-prompt.ts:129`: _"Blocking issues MUST be acted upon — do NOT use report_only for these."_

**Impact:** The steroids-cli Sentry connector task wasn't reset until run 18 — a 23-minute delay. The Technician, monorepo, and translatemy.world tasks were **never** reset by the FR; those projects were eventually disabled manually. If the FR had issued `reset_project` for all 4 projects in run 16, some tasks might have recovered via fresh checkout.

**Lesson:** See M4 — the prompt instruction needs programmatic enforcement, not just LLM compliance.

---

### FR Effectiveness: Reset actions

**19 unique tasks were reset by the FR.** Success rate:

| Outcome | Count | Tasks |
|---------|:-----:|-------|
| RESOLVED (never reappeared) | 15 | steroids-cli/Sentry, warehouse/Tablet screens, warehouse/OCR, prompter/iOS Camera, prompter/iOS Controller, prompter/WebRTC pipeline, prompter/iPad portrait, prompter/takeover test, warehouse/Category API, warehouse/AppReveal e2e, warehouse/Meta webhook, warehouse/Offline sync, prompter/Android Session Entry, warehouse/Stock level, warehouse/Image handler |
| MOSTLY RESOLVED (1-2 reappearances) | 1 | warehouse/Pending request admin API |
| NEVER RESOLVED (reset loop) | 1 | prompter/Initialize Android project (13 resets, 29 reappearances after last reset) |
| RESOLVED after multiple resets | 2 | warehouse/GET events API (4 resets), prompter/Android Dashboard (2 resets) |

**78% (15/19) of tasks were resolved by a single FR reset.** The FR's `reset_task` action is effective for transient failures. The problem is the 1 task that entered an infinite reset loop (M2), and the initial 1h18m delay before any resets started.

---

### FR Effectiveness: trigger_wakeup action

`trigger_wakeup` was the most common FR action (issued in nearly every run). **It resolved idle_project exactly 0 times across 92 runs.** Both warehouse and prompter were flagged as `idle_project` in all 92 runs — no single recovery was ever observed from a wakeup.

The FR itself identified this in run 73: _"The scanner likely flagged both projects as idle because the runner registration mechanism doesn't match the process detection — the runners are started with workspace-prefixed paths which may not be recognized by the scanner's runner-detection logic."_

Despite correctly diagnosing the problem as a false positive (scanner bug, not a runner bug), the FR still issued `trigger_wakeup` because:
1. It has no action available to "suppress this anomaly" or "mark as false positive"
2. The prompt says blocking issues MUST be acted upon
3. `trigger_wakeup` is the only action that makes sense for `idle_project`, even when the FR knows it won't help

**Lesson:** The FR needs a `suppress_anomaly` or `acknowledge_false_positive` action that marks an anomaly as known-benign for a time window, so the circuit breaker (M2) can distinguish "tried and failed" from "known false positive."

---

### FR Effectiveness: Deeper diagnostic actions (runs 73, 85, 90)

The FR's best work came in later runs when it used `query_db` to investigate before acting:

- **Run 73:** Queried project DBs to find active runner PIDs and heartbeats. Correctly identified both idle_project alerts as false positives. Documented the scanner's workspace-path mismatch as root cause.
- **Run 85:** Found 3 active runners (2 warehouse, 1 prompter) with fresh heartbeats. Confirmed the scanner bug.
- **Run 90:** Found a `disputed` task stuck due to arbitration crash (exit 143). Used `update_task` to fix the status. Found a review loop (35 invocations, 7+ rejection cycles) and force-completed the task with `add_task_feedback` for audit trail.

Run 90 is the gold standard — the FR diagnosed a non-obvious root cause (arbitration crash leaving task in limbo), took a surgical fix (`update_task` to change status), and documented its reasoning. This is exactly what the FR should do every time.

**However:** These deep investigations only happened in late runs (73+). Earlier runs (18-50) mostly did shallow `reset_task` + `trigger_wakeup` without investigation. The difference is likely prompt quality — the deep debugging capabilities were added in commit `d0c41e7` ("empower first responder agent with deep debugging capabilities").

---

### FR Effectiveness: Actions the FR should have taken but didn't

| Situation | What FR did | What it should have done |
|-----------|-------------|-------------------------|
| Run 16: 9 blocked tasks | `report_only` | `reset_project` for each affected project |
| Run 15: Technician at 116/150 invocations | `report_only` | `update_task` to skip the task, or `add_task_feedback` with guidance |
| Runs 23-58: Repeated idle_project false positive | `trigger_wakeup` (every time) | After 3rd attempt: `report_only` acknowledging false positive, stop retrying |
| Run 86: orphaned_task (warehouse Image handler) | `trigger_wakeup` | `reset_task` (the task was orphaned, wakeup doesn't fix that) |
| Runs 22-62: Android init reset loop | `reset_task` (13 times) | After 3rd reset: `update_task` to skip, with `add_task_feedback` explaining why |

---

### Timeline: Could the auth failures have been prevented?

The 3 auth failures (runs 20, 91, 92) all hit Claude's OAuth. Run 20 was isolated (17:41) and the FR recovered on the next cycle. Runs 91-92 happened after the overnight infinite chain (M1) burned through Claude's rate/token window.

Run 91's auth failure at 01:35 **was the only thing that stopped the infinite chain.** Without it, runs would have continued indefinitely. The auth failure was accidental mitigation — the system has no intentional mechanism to stop itself.

If M3 (auth fallthrough to next provider) had been implemented, the chain would have continued via codex, potentially burning that provider's quota too. So paradoxically, M3 must be implemented **together with** M1/M2/M7 — you need the circuit breaker before you improve the fallback chain.

---

## Appendix: Run-by-Run Timeline

| Phase | Runs | Period | What happened |
|-------|------|--------|---------------|
| Initial scans | 1-14 | 15:44-16:54 | Anomalies found, below escalation threshold. 2 warnings (Technician high invocations, prompter rejections), 2 idle projects. No FR dispatched. |
| First FR wave | 15-22 | 17:02-17:49 | FR dispatched. Trigger wakeups for idle projects. Reset blocked tasks. Reset failed tasks in warehouse/prompter. |
| Auth failure | 20 | 17:41 | Claude auth failed. No fallback to codex. |
| Remediation loop | 23-58 | 18:00-23:19 | Mix of `first_responder_complete` (FR runs, resets tasks, triggers wakeups) and `project_disabled` (all affected projects already disabled). Same 2-3 anomalies repeating. |
| Infinite chain | 59-90 | 23:21-01:35 | Follow-up scan triggers next FR, continuously. 30+ consecutive dispatches. All diagnosing the same idle_project false positives. FR correctly identifies them as false positives but still triggers wakeup each time. |
| Auth failure | 91 | 01:35 | Claude auth expired after 2+ hours of continuous use. Chain broken. |
| Morning probe | 92 | 07:52 | Wakeup-triggered scan. Auth still failed. |

## Appendix: Currently Active Issues (live scan)

| Anomaly | Severity | Project | Task | Action Needed |
|---------|----------|---------|------|---------------|
| `repeated_failures` | warning | warehouse | "Pending request admin API" (3 failures) | Investigate failure cause in runner logs |
| `idle_project` | critical | warehouse | - | Fix S1 (scanner detection) and S6 (wakeup spawning) |
| `orphaned_task` | critical | prompter | "Build Android Dashboard and Editor screens" (89+ min) | Fix S2 (sanitiser guard) or manually reset |
| `idle_project` | critical | prompter | - | Fix S1 (scanner detection) and S6 (wakeup spawning) |

## Appendix: Disabled Projects

| Project | Reason |
|---------|--------|
| Technician | 6 merge-conflict-blocked tasks, high invocations on Prisma task |
| monorepo (@kilomayo) | 1 merge-conflict-blocked task |
| flatu | Unknown (not seen in monitor data) |
