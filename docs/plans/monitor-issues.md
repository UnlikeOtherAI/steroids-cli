# Monitor Issues — Audit & Fix Plan

> Generated from analysis of 92 monitor runs (2026-03-21 15:44 — 2026-03-22 07:52).
> 301 total anomaly occurrences, 28 unique task-level issues, 7 affected projects.
> Three independent adversarial reviews conducted. All findings consolidated below.

---

## Definition of Done (per task)

Every task below must pass all four gates before its checkbox is ticked:

1. **Implement** — write the fix, ensure `npm run build` compiles cleanly.
2. **Playwright verification** — use browser automation to confirm any UI-facing changes render correctly and the monitor dashboard/status reflects the fix. If the fix is backend-only, verify via the WebUI monitor panel that no regressions appear.
3. **Cross-provider code review** — dispatch two independent sub-agent reviewers:
   - **Claude** (`superpowers:code-reviewer`) — adversarial review of the diff.
   - **Gemini** (`gemini` CLI) — adversarial review of the same diff.
4. **Consensus gate** — both reviewers must agree the implementation is correct. If either raises a valid objection, address it before ticking off. If they disagree with each other, assess the dispute and document the resolution inline.

Only when all four gates pass: tick the checkbox `[x]` and move to the next task.

## Coding & Review Standards

All implementers and reviewers **must** read and follow [`AGENTS.md`](../../AGENTS.md). Key rules that apply to every fix here:

- **Root-Cause First** — do not patch around a failure. Diagnose the broken invariant and fix it directly. Fallbacks only as temporary containment with an explicit follow-up.
- **Simplification First** — before patching, ask whether the right fix is to simplify. Every change must reduce or hold total complexity. Two code paths answering the same question must share one source of truth.
- **Determinism First** — no fuzzy matching, regex parsing of LLM output, or nested fallback chains without deep justification.
- **No over-engineering** — fix the bug, nothing more. No speculative abstractions, no feature flags for one-off changes.

---

## Part 1: Monitor Issues (low-hanging fruit)

These are bugs in the monitor subsystem itself — the scanner, the loop, the first responder dispatch, and the retry/remediation logic. All changes are contained within `src/monitor/` and `src/commands/monitor.ts`.

Ordered by effort-to-impact ratio — easiest wins first.

---

### [x] M1: Follow-up scan creates an infinite dispatch chain

**Severity:** Critical — this burned 30+ consecutive FR invocations overnight (runs 59-92).

**What happens:** After a successful first responder run, `src/commands/monitor.ts:406-413` triggers a follow-up scan with `runMonitorCycle({ manual: true })`. The `manual: true` bypasses the duplicate-detection gate at `loop.ts:274-276`. If any anomaly persists, the follow-up dispatches another FR, which completes, triggers another follow-up... ad infinitum.

**Root cause:** Commit `d0c41e7` (published as v0.12.24 at 23:19:04 UTC) removed the `project_disabled` code path — the only circuit breaker that existed. Run 57 (23:14) was the last run under the old code. Run 58 (23:19:41) was the first run on v0.12.24. Run 59 (23:21:51) was the first run in the infinite chain. The removal directly caused the chain. Even without the follow-up mechanism, cron-triggered scans every 5 min would have dispatched FR indefinitely — just slower.

**Evidence:**
- Runs 59-90 form a continuous chain — each run's `started_at` equals the previous run's `completed_at`. 32 consecutive FR dispatches over 2.2 hours.
- 21 of 36 duplicate scans (58%) still dispatched FR due to the `manual: true` bypass.
- Runs 68-85: 18 consecutive scans with the exact same fingerprint — all dispatched FR, all produced reports, all issued `trigger_wakeup` + `report_only`, zero resolution.
- The chain consumed 78% of all report output (51,329 of 65,681 total chars) and an estimated $0.43 of the $0.71 total token cost.

**Early detection:** Detectable at run 23 (18:00), when the first repeat dispatch happened for an identical anomaly set. The `countRemediationAttempts()` function existed as dead code.

**Fix:** Remove `manual: true` from the follow-up scan call so the duplicate gate applies. Alternatively, replace the follow-up scan entirely with a simple row insert that records the post-fix scan results without triggering dispatch. The follow-up was only meant to refresh the dashboard, not to restart the loop.

**Files:** `src/commands/monitor.ts:406-413`

---

### [x] M2: Remediation attempt tracking exists but is never used as a circuit breaker

**Severity:** High — the system retries the same failing remediation indefinitely.

**What happens:** `loop.ts:192-201` defines `countRemediationAttempts()` and `loop.ts:207-216` defines `recordRemediationAttempt()`. Every dispatch records an attempt. But the count is **never checked before dispatching**. The function `countRemediationAttempts` is dead code. The old `project_disabled` code path used to check it, but that was removed in `d0c41e7`.

**Evidence:**
- 83 remediation attempts recorded: 42 for warehouse/idle_project, 34 for prompter/idle_project+skipped_task, 7 for prompter/idle_project alone.
- `trigger_wakeup` was issued 54 times for idle_project across 92 runs. It resolved idle_project exactly **0 times** — 0% success rate.
- 23 out of 57 FR dispatches (40%) were "pure futility" — only `trigger_wakeup` + `report_only`, no task-level action.
- The longest unbroken futility streak was 8 runs (72-79, 00:24 to 00:47).

**Early detection:** A `count >= 3` check would have stopped this at run 25 (18:11), saving 29+ FR invocations. The infrastructure was already built — just never wired in.

**Circuit breaker granularity note:** The old `project_disabled` mechanism operated at project granularity. When warehouse/prompter hit 3 attempts for `idle_project`, ALL anomalies for those projects were suppressed — including task-level anomalies that had never been addressed. 8 of 17 `project_disabled` runs had collateral task-level anomaly suppression. The new circuit breaker must operate per anomaly fingerprint, not per project.

**Fix:** In both `monitorCheck()` (loop.ts:254-262) and `runMonitorCycle()` (loop.ts:294-300), before dispatching the FR, call `countRemediationAttempts()` for each affected project. If any project+fingerprint has >= 5 attempts, skip the dispatch for that project. Record outcome as `max_remediation_attempts`. Add a TTL-based cleanup — clear old remediation attempts after 24h so the system can retry after a real fix is deployed.

**Files:** `src/monitor/loop.ts:192-201` (existing dead code), `src/monitor/loop.ts:254-262` (wakeup path), `src/monitor/loop.ts:294-300` (manual path)

---

### [x] M3: Auth failure kills the entire provider fallback chain

**Severity:** Medium — caused 3 failed runs (20, 91, 92). **Must be implemented AFTER M1+M2.**

**What happens:** When a provider returns a non-retryable error (like "Authentication failed"), `investigator-agent.ts:558-573` immediately returns failure instead of trying the next provider in the chain.

**Evidence:** Run 20 (17:41), run 91 (01:35), run 92 (07:52) — all "Authentication failed". The config has 3 agents but only claude was tried. Run 91's auth failure was the only thing that stopped the infinite chain. A 6.3-hour blind spot followed (01:35-07:52) — no monitor retry after auth failure, no scan at all until the morning cron at 07:52.

**Ordering constraint:** If M3 were implemented alone (without M1/M2 circuit breakers), it would just shift the burn to the next provider.

**Fix:** Always `continue` to the next agent on any error (retryable or not). Only `return` failure after all agents are exhausted. The for-loop already handles exhaustion at line 601-608.

**Files:** `src/monitor/investigator-agent.ts:558-573`, `src/monitor/investigator-agent.ts:509-511`

---

### [x] M4: No cooldown between FR dispatches

**Severity:** Medium — compounds M1 but is independently useful as defense-in-depth.

**What happens:** Neither `monitorCheck()` nor `runMonitorCycle()` checks how recently the last FR was dispatched. A completed FR triggers a new scan immediately, which dispatches a new FR immediately.

**Evidence:** Runs 72-78 each started the instant the previous one completed. 7 consecutive FR invocations in 20 minutes. The escalation_reason was identical across 70 consecutive runs (23-92): "2-3 anomalies at or above severity warning (highest: critical)" — the system had no progressive escalation, just binary dispatch/don't-dispatch.

**Fix:** Add a minimum FR dispatch cooldown (e.g., 10 minutes). Before dispatching, check the most recent FR-complete run. If it completed less than 10 minutes ago and the current scan's fingerprint matches, skip dispatch.

**Files:** `src/monitor/loop.ts:254-262` (wakeup path), `src/monitor/loop.ts:294-300` (manual path)

---

### [x] M5: `project_disabled` outcome type is orphaned (already resolved)

**Severity:** Cosmetic — confusing but not breaking. One-line fix.

**What happens:** `MonitorCycleResult` at `loop.ts:31` still includes `'project_disabled'`, and 17 DB rows have this outcome, but the code that produced it was removed in `d0c41e7`. Additionally, the disable/re-enable oscillation pattern across runs 27-57 showed that the old mechanism was ineffective — 9 transitions from `project_disabled` back to `first_responder_complete` as projects were re-enabled between cycles.

**Fix:** Remove `'project_disabled'` from the type union.

**Files:** `src/monitor/loop.ts:31`

---

### [ ] M6: First responder ignores "MUST act on blocking issues" instruction

**Severity:** Medium — caused 3 projects to go permanently unaddressed.

**What happens:** The prompt says blocking issues MUST be acted upon. But the FR returned `report_only` for blocking anomalies in runs 15, 16, 51, 68, 72-79, 81-82, 85-88. Run 16 was the worst: `report_only` for 9 `blocked_task` + 2 `idle_project` — all 11 anomalies left unresolved.

**Impact:** Three projects (Technician, monorepo, translatemy.world) had `blocked_task` anomalies detected in run 16 but were NEVER acted upon. The FR chose `report_only`, and the projects were disabled before any corrective action. Detection-to-action latency for these projects was effectively infinite.

**Fix:** After `parseFirstResponderResponse()`, validate that blocking anomaly types have a corresponding non-`report_only` action. If not, inject a default `reset_task`/`trigger_wakeup` automatically.

**Files:** `src/monitor/investigator-agent.ts:575-577`, `src/monitor/investigator-prompt.ts:129`

---

### [ ] M7: Duplicate detection fingerprint doesn't account for context changes

**Severity:** Low — causes unnecessary skips or dispatches.

**What happens:** `isDuplicateOfLastRun()` at `loop.ts:99-120` compares `type|severity|projectPath|taskId|runnerId`. Task `d871ce3c` appeared under 4 different anomaly types (`skipped_task`, `repeated_failures`, `blocked_task`, `blocked_error`) — each type change defeated the fingerprint, causing a fresh FR dispatch even though it was the same underlying problem. The FR has no cross-run memory of this task.

**Fix:** Include meaningful context fields (invocation count ranges, failure counts), exclude volatile fields (runnerId, PID). Consider a stable "issue ID" that persists across anomaly type changes for the same task.

**Files:** `src/monitor/loop.ts:99-120`

---

### [ ] M8: No escalation-to-human mechanism

**Severity:** Medium — the system silently burns API credits on unfixable issues.

**What happens:** The FR has no way to notify the user. It wrote "requires human" or "cannot be fixed by" in 12 run reports. Task `d871ce3c` in prompter was reset 13 times across 51 appearances without progress. The FR's strategy only changed from `reset_task` to `update_task` at run 63 (after 10 resets, not 3), and even then oscillated between `blocked_error` and `skipped` across 4 consecutive runs (63-66) as different FR invocations disagreed on the correct terminal state.

**Fix:** After M2's circuit breaker prevents further dispatches, write to a `monitor_alerts` table. The WebUI can poll for notifications. The `steroids monitor status` command should surface unacknowledged alerts.

**Files:** New table in global DB migration, `src/monitor/loop.ts`, `src/commands/monitor.ts`

---

### [ ] M9: FR needs a `suppress_anomaly` action for known false positives

**Severity:** Medium — 11 runs where FR diagnosed false positive but still acted.

**What happens:** In runs 68, 72-74, 77, 82-85, 87, 89, the FR explicitly stated "FALSE POSITIVES" in its report but still issued `trigger_wakeup` because no suppress action exists. The FR correctly diagnosed the scanner bug but was forced to take a useless action because the prompt says blocking issues MUST be acted upon and `trigger_wakeup` is the only available action for `idle_project`.

**Fix:** Add `suppress_anomaly` action: `{ action: "suppress_anomaly", projectPath, anomalyType, duration_hours, reason }`. Scanner checks suppressions before emitting. This lets M2's circuit breaker distinguish "tried and failed" from "known false positive."

**Files:** `src/monitor/investigator-agent.ts` (new action), `src/monitor/investigator-prompt.ts`, `src/monitor/scanner.ts`

---

### [x] M10: Default escalation threshold should be `warning`, not `critical`

**Severity:** Medium — caused a 1h18m blind window at initial deployment.

**What happens:** Runs 1-14 detected anomalies at `warning`/`info` severity but the default threshold was `critical`, so no FR was dispatched for 78 minutes. The user manually triggered runs 15-16 from the WebUI 28 minutes before automatic dispatch kicked in (after config change at 17:24). Technician's Prisma task burned 34+ extra invocations (116 to 150) during this window because the FR never reset or skipped it.

**Fix:** Change the hardcoded default at `loop.ts:242` from `{ min_severity: 'critical' }` to `{ min_severity: 'warning' }`.

**Files:** `src/monitor/loop.ts:242`

---

### [ ] M11: FR response parser fails on "text + JSON" output

**Severity:** Low — 1.8% failure rate, but lost the deepest single-run analysis.

**What happens:** Run 75 produced a 3,294-char report — the longest and deepest in the dataset. But the FR output thinking text before the JSON response. `parseFirstResponderResponse` at `investigator-agent.ts:90-106` expects the entire output to be valid JSON or markdown-fenced JSON. The thinking preamble caused `JSON.parse` to fail, so all actions were lost and replaced with `report_only: "Failed to parse response"`.

**Fix:** Scan the raw output for the last `{...}` block that parses as valid JSON, rather than requiring the entire output to be JSON. The regex at line 93 already handles markdown fences but doesn't handle arbitrary preamble text.

**Files:** `src/monitor/investigator-agent.ts:90-106`

---

### [ ] M12: `reset_project` action has 0% success rate

**Severity:** Low — the action is broken and the FR wastes action slots on it.

**What happens:** `reset_project` was attempted 3 times (runs 24, 71, 71). All 3 failed with "tasks reset exited with code 1". In run 71, the FR correctly diagnosed both projects as "deregistered from the global project registry" and tried `reset_project` as recovery — but `reset_project` can only reset task statuses within registered projects, not re-register them. After each failure, the FR silently fell back to `trigger_wakeup` without retrying or adjusting strategy.

**Fix:** Investigate why `steroids tasks reset --project <path>` exits non-zero for these projects (likely unregistered). Either fix the command to handle unregistered projects gracefully, or remove `reset_project` from the FR's action set and replace it with individual `reset_task` calls (which have 100% success rate). Also: after a failed action, the FR should be informed and given a chance to try an alternative.

**Files:** `src/monitor/investigator-agent.ts:196-223` (reset_project executor), `src/commands/tasks.ts` (reset command)

---

### [ ] M13: Scanner lacks task-level detail in anomalies

**Severity:** Medium — amplifies all other false-state loops.

**What happens:** The scan anomalies for `repeated_failures`, `failed_task`, and `skipped_task` do not include task IDs — only aggregate project-level metrics. The FR had to issue `query_db` actions to discover which specific task was failing. Before `d0c41e7` added deep debugging (run 59), the FR had no way to investigate and blindly reset the first task it found.

**Concrete impact:** The f06f7cad death spiral (prompter "Build Android Session Entry", 35 invocations, 7+ rejection cycles) was invisible to the scanner because `repeated_failures` is a project-level anomaly. The FR focused on d871ce3c (a different, more visible task) for 32 runs (48-79) while f06f7cad burned invocations undetected. Only at run 80 did the FR discover it via `query_db`.

**Fix:** The scanner's `repeated_failures` anomaly should include the task ID and title of the worst-offending task (highest failure_count + rejection_count). Same for `failed_task` and `skipped_task`. This lets the FR prioritize without needing `query_db` round-trips.

**Files:** `src/monitor/scanner.ts` (anomaly construction for repeated_failures, failed_task, skipped_task)

---

### [ ] M14: No `completed_at` timestamp on monitor runs

**Severity:** Low — makes debugging and cost analysis harder.

**What happens:** The `monitor_runs` table has no `completed_at` column for the overall run. Actual FR execution time cannot be separated from inter-cycle gaps. The schema defines `completed_at` but it's only set when the FR respond command finishes — not for scan-only runs or error runs. Mean "duration" appears to be 304s but this includes cron wait time.

**Fix:** Set `completed_at` on all run outcomes, not just FR-dispatched runs.

**Files:** `src/monitor/loop.ts:133-148` (createRunRow function)

---

### FR Effectiveness Summary

Data to inform prioritization of the above issues.

**Overall action statistics (160 total executions):**

| Action | Executions | Success | Effective | Notes |
|--------|:---------:|:-------:|:---------:|-------|
| trigger_wakeup | 54 | 100% | **0%** | Never resolved idle_project in 92 runs |
| reset_task | 39 | 100% | **94.9%** | 37/39 resolved the issue; 2 failures on d871ce3c (infra issue) |
| report_only | 24 | 100% | N/A | Informational only |
| add_task_feedback | 17 | 100% | High when actionable | Effective for dispute resolution; useless for infra issues |
| update_task | 15 | 100% | **60%** | 9/15 resolved; 6 failures on d871ce3c (scanner still flags) |
| query_db | 8 | 100% | **100%** | Every query returned useful data; only used in runs 59+ |
| **reset_project** | **3** | **0%** | **0%** | All 3 failed with exit code 1 |

**35% of all FR invocations were wasted** — only trigger_wakeup/report_only with no task-level action.

**Actions the FR should have taken but didn't:**

| Situation | What FR did | What it should have done |
|-----------|-------------|-------------------------|
| Run 16: 9 blocked tasks across 4 projects | `report_only` | `reset_project` for each project |
| Run 15: Technician at 116/150 invocations | `report_only` | `update_task` to skip |
| Runs 23-58: Repeated idle_project false positive | `trigger_wakeup` (every time) | After 3rd attempt: suppress or stop |
| Run 86: orphaned_task (warehouse Image handler) | `trigger_wakeup` | `reset_task` (wakeup doesn't fix orphans) |
| Runs 22-62: Android init reset loop (13 resets) | `reset_task` (13 times) | After 3rd reset: `update_task` to skip |
| Runs 48-79: f06f7cad death spiral (32-run blind window) | Nothing | `query_db` to find the worst-offending task |

**FR quality improved dramatically after `d0c41e7`:**

| Metric | Early (runs 15-25) | Late (runs 73-90) | Change |
|--------|:-:|:-:|:-:|
| Mean report length | 649 chars | 1,646 chars | +153% |
| Used `query_db` | 0 | 2 | New capability |
| Identified false positives | 0 | 9 (50%) | New pattern |
| Mentioned "root cause" | 1 | 8 (44%) | Deeper analysis |

The irony: late-phase reports are qualitatively excellent but the FR intelligence is trapped without an action channel (M9). The best diagnostic reports were produced during the worst operational phase.

---

## Part 2: Systemic Issues (core engine fixes)

These are bugs in the scanner's data sources, the runner lifecycle, and the wakeup/sanitisation pipeline. Changes touch `src/monitor/scanner.ts`, `src/health/`, `src/runners/`, and potentially `src/orchestrator/`.

---

### [ ] S1: Scanner `hasActiveRunner()` misses parallel-session runners

**Severity:** Critical — single root cause of 189 out of 301 anomaly occurrences.

**What happens:** `scanner.ts:93-103` checks only the `runners` table. Parallel session runners (via `parallel_sessions` and `workstreams` tables) and freshly-spawned runners are invisible. The anomaly count never dropped below 2 across all 92 runs — a permanent noise floor of `idle_project` for warehouse and prompter. No correlation exists between FR actions and anomaly count reduction because these structural false positives dominate.

**FR evidence:**
- Run 73: "Runners are started with workspace-prefixed paths (e.g., /warehouse/ca15f1449f147eb2/ws-688389ea-2) which may not be recognized by the scanner's runner-detection logic."
- Run 85: Found 3 active runners (2 warehouse, 1 prompter) with fresh heartbeats within 2 min of scan time.

**Fix:** Expand runner detection to also check `parallel_sessions` (status='running') and `task_invocations` (status='running', recent started_at_ms).

**Files:** `src/monitor/scanner.ts:93-103`, `src/monitor/scanner.ts:427-439`

---

### [ ] S2: Orphaned task not cleaned up by wakeup sanitiser

**Severity:** High — tasks can stay orphaned for hours.

**What happens:** The live scan shows prompter's "Build Android Dashboard and Editor screens" task orphaned for 89+ minutes. The sanitiser skips it due to the `hasActiveParallelContext` guard.

**Additional finding:** Two orphan instances in the data (runs 86, 89) had different root causes. Run 86: task completed 12 seconds before scan (race condition false positive) — FR wrongly issued `trigger_wakeup` instead of `reset_task`. Run 89: task was set to `in_progress` but never had an invocation created (invocation_count=0, runner crash between lock and invocation). The FR correctly diagnosed and reset it.

**Fix:** Sanitiser should clean up orphaned tasks regardless of parallel session state if orphaned > 30 minutes. Time-based override.

**Files:** `src/runners/wakeup-sanitise.ts`, `src/health/stuck-task-detector.ts`

---

### [ ] S3: Stuck "disputed" tasks block section progress

**Severity:** Medium — task blocks all siblings in its section.

**What happens:** The FR discovered in run 90 that warehouse task `581e0906` was stuck in `disputed` status due to an arbitration provider crash (exit 143). The FR tried contradictory fixes across runs: run 84 set status to `review`, run 90 reverted to `pending`. The task still reappeared in run 92. The FR needs a proper `resolve_dispute` action rather than hacking status via `update_task`.

**Fix:** Dispute timeout: auto-reset to `pending` after 30 minutes with no active arbitration. Also consider a `resolve_dispute` FR action that properly updates the disputes table.

**Files:** `src/orchestrator/task-selector.ts`, `src/runners/wakeup-sanitise.ts` or `src/health/stuck-task-detector.ts`

---

### [ ] S4: Merge-conflict blocked tasks require manual intervention

**Severity:** Medium — 15 occurrences across 4 projects, no auto-recovery.

**What happens:** 9 `blocked_conflict` tasks in run 16 across steroids-cli (1), Technician (6), monorepo (1), translatemy.world (1). The FR chose `report_only` (M6), the old circuit breaker then disabled the projects as collateral damage (suppressing both idle_project AND task-level anomalies), and the tasks were never resolved.

**Fix:** Branch reset strategy (delete task branch, recreate from main) before blocking. Or bulk `steroids tasks reset --blocked` with branch cleanup.

**Files:** `src/orchestrator/` (coder phase merge logic), `src/commands/tasks.ts`

---

### [ ] S5: Persistent task failures with no learning (prompter Android init)

**Severity:** Medium — 25 FR actions on a single unfixable task.

**What happens:** Task `d871ce3c` received 25 FR actions over 6h6m (runs 22-67): 13 resets, 5 update_task, 7 add_task_feedback. The FR's strategy escalated too slowly — 10 blind resets before first investigation (run 62's `query_db` revealed 31+ coder invocations, zero reviewer invocations). Then status oscillated 4 times in 5 runs (63-67) as different FR invocations disagreed.

**Root cause (FR run 73):** Cross-device link error — project on /System/Volumes/Data, workspaces on /Users/dictator/.steroids/workspaces (different APFS volumes). Infrastructure issue, not code issue.

**Fix:** Runner should detect environment-specific failures and transition to `blocked_error` with a clear message. M2 (circuit breaker) and M8 (human escalation) prevent the reset loop.

**Files:** `src/orchestrator/coder.ts`, `src/prompts/coder.ts`

---

### [ ] S6: Wakeup cron runs but doesn't spawn runners for idle projects

**Severity:** High — partially real problem underneath S1's false positives.

**What happens:** Some `idle_project` alerts ARE real. Investigation needed into system-pressure.ts thresholds, provider backoffs, and unmet task dependencies.

**Additional finding:** A 6.3-hour blind spot exists after auth failure (runs 91-92, 01:35-07:52). The wakeup cron didn't trigger any monitor scan overnight. No retry mechanism exists after auth failure.

**Files:** `src/runners/wakeup.ts`, `src/runners/system-pressure.ts`, `src/runners/global-db-backoffs.ts`

---

## Appendix: Run-by-Run Timeline

| Phase | Runs | Period | What happened |
|-------|------|--------|---------------|
| Initial scans | 1-14 | 15:44-16:54 | Anomalies found, below escalation threshold. 2 warnings, 2 idle projects. No FR dispatched. 78-min blind window (M10). |
| Manual FR | 15-16 | 17:02-17:07 | User manually triggered from WebUI. FR issued `report_only` for 9 blocked tasks (M6). |
| First auto wave | 18-22 | 17:30-17:49 | First automatic dispatches after config change. Reset blocked/failed tasks. Auth failure at run 20. |
| Remediation loop | 23-58 | 18:00-23:19 | Alternation: `first_responder_complete` / `project_disabled`. Circuit breaker suppressed task-level anomalies as collateral. d871ce3c reset 10 times without investigation. |
| Infinite chain | 59-90 | 23:21-01:35 | v0.12.24 removed circuit breaker. 32 consecutive FR dispatches. FR diagnoses false positives but triggers wakeup anyway. Deepest analysis produced during worst operational phase. |
| Auth failure | 91 | 01:35 | Claude auth expired. Chain broken accidentally. No fallback to codex (M3). |
| Blind spot | 91-92 | 01:35-07:52 | 6.3-hour gap. No retry. Morning cron at 07:52 still fails auth. |

### [ ] S7: FR reset_task forces full coder restart — wastes 80 coder invocations

**Severity:** Critical — 74% of all FR resets wasted coder invocations on tasks where the coder had already succeeded.

**What happens:** The FR's `reset_task` action (`investigator-agent.ts:166-192`) unconditionally sets status to `pending` and zeroes all counters:

```sql
UPDATE tasks SET status = 'pending', failure_count = 0, rejection_count = 0, ...
```

The task selector (`task-selector.ts:420-435`) treats all `pending` tasks as fresh work with `action: 'start'`. The orchestrator loop (`orchestrator-loop.ts:296-314`) dispatches `action === 'start'` to `runCoderPhase(mode='start')` — a full coder run from scratch.

There is **no check** for whether the coder already succeeded. Even if a task failed only at the reviewer, arbitration, or push phase, the reset forces it back through the entire coder pipeline.

**Evidence across all 39 reset_task actions:**

| Category | Tasks | Wasted Coder Runs | Root Cause |
|----------|:-----:|:-----------------:|------------|
| Arbitration crash (exit 143) | 4 | 15 | Coder + reviewer both succeeded; dispute resolution crashed |
| Reviewer failure/rejection | 4 | 12 | Coder succeeded; reviewer rejected or hit rate limits |
| Post-coder failure (push/merge) | 3 | 10 | Coder succeeded; git push or merge to main failed |
| Push failure loop (d871ce3c) | 1 | **35** | Coder succeeded 36 times; push always failed; reset 13 times |
| Review death spiral (f06f7cad) | 1 | 8 | Coder succeeded; reviewer trapped in 7+ rejection cycles |
| **Total unnecessary coder runs** | **14 tasks** | **80** | |
| Justified resets (0 coder success) | 5 tasks | 0 | Correct: no prior work to preserve |

**Worst cases:**

- **d871ce3c** (prompter, Android init): 38 total coder invocations, 36 successful. Zero reviewer invocations ever — the task always failed at the push step after coding completed. FR reset it 13 times; each time the coder re-ran from scratch. 35 wasted coder invocations on a single task.
- **f06f7cad** (prompter, Android Session Entry): 11 coder invocations. The coder succeeded on the first try. Then 21 reviewer invocations followed (3 failures, 18 in a rejection cycle about out-of-scope async tests). FR reset at run 48 — coder ran again 8 more times unnecessarily.
- **ff275dfb** (warehouse, GET events API): 4 resets, 4 wasted coder runs. Coder succeeded each time; the task was stuck in `disputed` from an arbitration crash.

**The fix has two parts:**

**Part A — Smart reset in the FR (monitor layer fix):**

In `investigator-agent.ts:166-192`, before setting status to `pending`, check if the task has successful coder invocations:

```sql
SELECT COUNT(*) as count FROM task_invocations
WHERE task_id = ? AND role = 'coder' AND success = 1
```

If `count > 0`, set status to `review` instead of `pending`. This routes the task to `runReviewerPhase` instead of `runCoderPhase`. Also preserve the `rejection_count` when the issue was a reviewer failure — zeroing it loses context.

**Part B — Prior-work-aware task selection (engine fix):**

In `task-selector.ts`, when selecting a `pending` task for `action: 'start'`, check if the task has prior successful coder invocations. If so, return `action: 'resume'` or `action: 'review'` instead of `action: 'start'`. This makes the fix work for ALL resets (not just FR resets), including manual `steroids tasks reset` and wakeup sanitiser resets.

**Files:**
- `src/monitor/investigator-agent.ts:166-192` (Part A: smart reset)
- `src/orchestrator/task-selector.ts:420-435` (Part B: prior-work-aware selection)
- `src/runners/orchestrator-loop.ts:296-314` (action dispatch — no change needed if task-selector returns correct action)

---

## Appendix: Currently Active Issues (live scan)

| Anomaly | Severity | Project | Task | Action Needed |
|---------|----------|---------|------|---------------|
| `repeated_failures` | warning | warehouse | "Pending request admin API" (3 failures) | Investigate runner logs |
| `idle_project` | critical | warehouse | - | Fix S1 + S6 |
| `orphaned_task` | critical | prompter | "Build Android Dashboard and Editor screens" (89+ min) | Fix S2 or manually reset |
| `idle_project` | critical | prompter | - | Fix S1 + S6 |

## Appendix: Disabled Projects

| Project | Reason |
|---------|--------|
| Technician | 6 merge-conflict-blocked tasks, high invocations on Prisma task. Never acted on by FR (M6). |
| monorepo (@kilomayo) | 1 merge-conflict-blocked task. Never acted on by FR. |
| flatu | Unknown (not in monitor data) |

## Appendix: Companion Audit

Detailed timing, cost, and duration analysis available in [`monitor-timing-cost-audit.md`](./monitor-timing-cost-audit.md).
