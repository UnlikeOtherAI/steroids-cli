# Monitor Timing, Cost & Remaining Patterns Audit

> Companion to `monitor-issues.md`. Covers timing analysis, cost implications, and patterns not in the primary audit.
> Data: 92 monitor runs (2026-03-21 15:44 -- 2026-03-22 07:52), 106 remediation attempts, 57 FR-dispatched runs.

---

## 1. FR Run Duration Analysis

Duration is approximated as the gap between a run's `started` timestamp and the next run's `started` timestamp (no `completed_at` column exists -- see finding 7g).

### Summary Statistics (57 FR-dispatched runs)

| Metric | Value |
|--------|-------|
| Mean | 304s (5.1 min) |
| Median | 300s (5.0 min) |
| Stdev | 153s |
| Min | 130s (run 58) |
| Max | 1129s (run 25, 18.8 min) |

### Top 5 Longest Runs

| Run | Started | Duration | Report len | Actions | Why slow |
|-----|---------|----------|-----------|---------|----------|
| 25 | 18:11:27 | 1129s | 382 ch | 1 | Single `trigger_wakeup`. The 18.8-min gap is NOT execution time -- it is the normal scan interval. No follow-up was triggered, so the next run came from the cron cycle. |
| 22 | 17:49:29 | 688s | 398 ch | 2 | Same pattern: `reset_task` + `trigger_wakeup`, then the system waited for the next cron scan. |
| 67 | 23:55:35 | 657s | 1663 ch | 3 | 3 actions including `query_db`. Genuinely longer LLM output (1663 chars). Followed by a 657s gap before the follow-up chain resumed. |
| 36 | 19:50:37 | 551s | 534 ch | 2 | Normal inter-cycle gap, not execution time. |
| 32 | 19:16:34 | 474s | 418 ch | 2 | Normal inter-cycle gap. |

### Top 5 Shortest Runs

| Run | Started | Duration | Report len | Actions |
|-----|---------|----------|-----------|---------|
| 58 | 23:19:41 | 130s | 492 ch | 3 |
| 73 | 00:27:36 | 133s | 1630 ch | 2 |
| 87 | 01:18:37 | 176s | 1271 ch | 2 |
| 85 | 01:11:54 | 179s | 829 ch | 2 |
| 77 | 00:40:12 | 180s | 1613 ch | 2 |

All 5 shortest runs are in the infinite chain (59-90). The chain's follow-up mechanism fires immediately after FR completion, so the "duration" includes only scan + LLM call + action execution -- no waiting for the next cron cycle.

### Duration vs Quality Correlation

| Metric | Pearson r |
|--------|-----------|
| Duration vs report length | -0.353 |
| Duration vs action count | -0.155 |

**Negative correlation**: longer runs produce SHORTER reports. This is counterintuitive but explained by the confound above: "long" runs are cron-gapped runs from the early phase (short, shallow reports), while "short" runs are follow-up-chain runs from the late phase (long, deep reports).

### Phase Duration Comparison

| Phase | Mean duration | Explanation |
|-------|--------------|-------------|
| Early (runs 15-30) | 426s | Dominated by cron intervals between runs |
| Late (runs 59-90) | 250s | Follow-up chain; duration = actual execution time |

**Finding T1 (NEW)**: The `monitor_runs` table lacks a `completed_at` column. Without it, actual FR execution time cannot be separated from inter-cycle gaps. The approximation (next-run start minus this-run start) is unreliable for cron-triggered runs. Recommendation: add `completed_at_ms` to the run row, set immediately after `executeActions()` returns.

---

## 2. Scan Interval Compliance

The configured interval appears to be ~300s (5 min), based on the median gap of 314s during the scan-only phase (runs 1-14).

### Interval Distribution

| Category | Count | Percentage |
|----------|-------|-----------|
| On-schedule (240-360s) | 46 | 51% |
| Faster than expected (<180s) | 6 | 7% |
| Slower than expected (>600s) | 12 | 13% |
| Moderately delayed (360-600s) | 27 | 30% |

### Gaps > 10 Minutes (Missed Cycles)

| From | To | Gap | Gap (min) | Cause |
|------|-----|-----|-----------|-------|
| 17 | 18 | 1100s | 18.3 | Config change deployed (severity threshold lowered to warning) |
| 25 | 26 | 1129s | 18.8 | Normal cron gap after FR run |
| 40 | 41 | 1172s | 19.5 | 3 consecutive `project_disabled` runs absorbed cron cycles |
| 42 | 43 | 1869s | 31.1 | Long gap between disabled and next FR dispatch |
| 46 | 47 | 2116s | 35.3 | Longest gap in the active period -- 2 disabled runs consumed cycles |
| 67 | 68 | 657s | 10.9 | Marginal; likely FR execution time + scan |
| 91 | 92 | 22620s | 377.0 | Auth failure at 01:35 broke the chain; next scan at 07:52 (morning cron) |

**Finding T2 (NEW)**: The 6.3-hour gap between runs 91 and 92 (01:35 to 07:52) reveals that the wakeup cron is NOT triggering monitor scans overnight. The monitor scan appears to run only as part of the wakeup cycle, which is configured with launchd. If launchd's `StartInterval` fires but the auth token is expired, the monitor cycle records an error and stops -- there is no retry. The system was blind from 01:35 to 07:52.

### Follow-up Chain Gaps (< 180s)

| From | To | Gap | Context |
|------|-----|-----|---------|
| 20 | 21 | 121s | Error (auth) -> next cron scan |
| 27 | 28 | 154s | project_disabled -> project_disabled |
| 58 | 59 | 130s | **Infinite chain start** |
| 73 | 74 | 133s | Mid-chain |
| 85 | 86 | 180s | Mid-chain |
| 87 | 88 | 176s | Mid-chain |

The 6 sub-180s gaps confirm the follow-up chain runs faster than the normal interval. Runs 58-59 (130s gap) marks the exact transition point where the chain began.

---

## 3. Detection-to-Action Latency

For every anomaly type + project combination, the time from first scan detection to the first FR action addressing it.

| Anomaly Type | Project | First Seen | First Acted | Latency | Notes |
|-------------|---------|-----------|------------|---------|-------|
| high_invocations | Technician | Run 1 (15:44) | **NEVER** | -- | FR issued `report_only` in run 15; task was never reset or skipped. Technician was disabled before any action. |
| idle_project | warehouse | Run 1 (15:44) | Run 15 (17:02) | **78.0 min** | Blocked by `min_severity: critical` (M10). |
| repeated_failures | prompter (iOS Camera) | Run 1 (15:44) | Run 19 (17:36) | **111.9 min** | Same severity gate. Task resolved after single reset. |
| idle_project | prompter | Run 1 (15:44) | Run 15 (17:02) | **78.0 min** | Same severity gate. |
| blocked_task | steroids-cli | Run 16 (17:07) | Run 18 (17:30) | **23.6 min** | Run 16 used `report_only` (M6). Fixed in run 18. |
| blocked_task | Technician | Run 16 (17:07) | **NEVER** | -- | 6 tasks blocked; FR only reported. Project disabled. |
| blocked_task | monorepo | Run 16 (17:07) | **NEVER** | -- | Single task; FR only reported. Project disabled. |
| blocked_task | translatemy.world | Run 16 (17:07) | **NEVER** | -- | FR only reported. Project disabled. |
| idle_project | translatemy.world | Run 18 (17:30) | Run 18 (17:30) | **0 min** | Immediate (wakeup in same run). |
| idle_project | steroids-cli | Run 19 (17:36) | Run 19 (17:36) | **0 min** | Immediate. |
| failed_task | warehouse (3 tasks) | Run 21 (17:43) | Run 21 (17:43) | **0 min** | All 3 reset immediately. |
| skipped_task | prompter (Android init) | Run 24 (18:06) | Run 24 (18:06) | **0 min** | Reset immediately -- but this started the 13-reset loop (S5). |
| db_inconsistency | warehouse | Run 41 (20:37) | Run 41 (20:37) | **0 min** | Immediate. |
| db_inconsistency | prompter | Run 51 (22:36) | Run 52 (22:41) | **5.2 min** | One-cycle delay. |
| blocked_task | prompter (Android init) | Run 64 (23:43) | Run 71 (00:19) | **36.6 min** | 7 runs elapsed before action. |
| orphaned_task | warehouse | Run 86 (01:14) | Run 86 (01:14) | **0 min** | FR correctly identified as transient (task had just completed). |

**Finding T3 (NEW)**: Three projects (Technician, monorepo, translatemy.world) had `blocked_task` anomalies detected in run 16 but were NEVER acted upon by the FR. The FR issued `report_only` for all 9 blocked tasks in run 16. By run 27, these projects were disabled via the `project_disabled` code path. The detection-to-action latency is effectively **infinite** for these projects -- the system detected the problem but chose inaction.

**Finding T4 (NEW)**: The 78-minute latency for idle_project (warehouse + prompter) from run 1 to run 15 was entirely caused by the default `min_severity: critical` setting (M10). The anomalies were classified as `info` severity. If the default had been `warning`, the FR would have been dispatched in run 1 or 2 -- an 78-minute blind window caused by a single configuration default.

---

## 4. Anomaly Count Trajectory

| Phase | Runs | Avg anomalies | Min | Max | Trend |
|-------|------|--------------|-----|-----|-------|
| Scan-only (1-14) | 14 | 3.4 | 3 | 4 | Stable |
| First FR wave (15-30) | 16 | 3.8 | 2 | **11** | Spike at run 16 (blocked tasks), then decline |
| Remediation loop (31-58) | 28 | 3.2 | 2 | 5 | Slight improvement from task resets |
| Infinite chain (59-90) | 32 | 3.0 | 2 | 4 | Stable floor of 2 (warehouse + prompter idle_project) |
| Post-chain (91-92) | 2 | 3.5 | 3 | 4 | No change |

**Peak**: Run 16 with 11 anomalies (9 `blocked_task` + 2 `idle_project`). This was triggered by a scan that detected merge conflicts across 4 projects simultaneously.

**Finding T5 (NEW)**: The anomaly count NEVER dropped below 2 across all 92 runs. The irreducible floor is `idle_project` for warehouse and prompter, which appeared in every single scan. The system is not getting healthier -- the FR addresses task-level anomalies effectively (78% single-reset success rate per the existing audit) but the two structural false positives (S1) create a permanent noise floor that masks real signals.

**Finding T6 (NEW)**: There is **no correlation** between FR actions and anomaly count reduction. The count oscillates between 2 and 5 regardless of how many resets or wakeups the FR performs. The reason: task-level anomalies self-resolve (runners pick them up and fail/succeed) independently of FR actions, while structural anomalies (idle_project) persist regardless of FR actions. The FR is most effective when it resets a specific failed/stuck task, but the anomaly count doesn't reflect this because idle_project dominates.

---

## 5. FR Report Quality Over Time

### Quantitative Comparison

| Metric | Early (runs 15-25) | Late (runs 73-90) | Change |
|--------|-------------------|-------------------|--------|
| Mean report length | 649 chars | 1,646 chars | +153% |
| Reports using `query_db` | 0 | 2 | New capability |
| Reports mentioning "false positive" | 0 | 9 (50%) | New diagnostic pattern |
| Reports mentioning "root cause" | 1 | 8 (44%) | Deeper analysis |
| Reports mentioning "scanner" | 0 | 8 (44%) | System-level awareness |

### Action Type Evolution

| Action Type | Early (15-25) | Late (73-90) |
|-------------|:------------:|:------------:|
| reset_task | 10 | 1 |
| trigger_wakeup | 8 | 16 |
| report_only | 2 | 16 |
| add_task_feedback | 0 | 5 |
| update_task | 0 | 4 |
| query_db | 0 | 2 |

**Finding T7 (NEW)**: Commit `d0c41e7` ("empower first responder agent with deep debugging capabilities") measurably improved diagnostic depth. Before `d0c41e7`: FR reports averaged 649 chars, never used `query_db`, never identified false positives, and relied exclusively on `reset_task` + `trigger_wakeup`. After `d0c41e7`: reports averaged 1,646 chars, used DB queries to verify runner state, identified 50% of idle_project alerts as false positives, and employed surgical actions (`update_task`, `add_task_feedback`).

**Finding T8 (NEW)**: The improvement created an ironic problem. Late-phase FR reports are qualitatively excellent -- run 73 correctly identified both idle_project alerts as false positives, run 86 diagnosed a race condition between task completion and scan timing, run 90 found and fixed a stuck `disputed` task. But the system had no way to ACT on the FR's own diagnosis of false positives. The FR wrote "these are false positives" in 9 reports and then issued `trigger_wakeup` anyway because it had no `suppress_anomaly` action (M9 in the primary audit). The diagnostic intelligence exists but is trapped without an action channel.

### Run 75 Parse Failure

Run 75 produced the longest report (3,294 chars) but its actions were lost. The FR output thinking text ("I now have a complete picture. Both projects have active runners...") BEFORE the JSON response. The parser (`parseFirstResponderResponse` at `investigator-agent.ts:90-153`) expects the entire output to be valid JSON or markdown-fenced JSON. The thinking preamble caused `JSON.parse` to fail, so the entire output (including the valid JSON blob) was stuffed into the `diagnosis` field and a `report_only: "Failed to parse response"` action was created.

**Finding T9 (NEW)**: The parse function at `investigator-agent.ts:90-106` has no fallback for "text + JSON" responses. If the LLM outputs reasoning before the JSON (which LLMs commonly do despite "respond with JSON only" instructions), all actions are lost. The fix: scan the raw output for the last `{...}` block that parses as valid JSON, rather than requiring the entire output to be JSON. This happened in 1 of 57 FR runs (1.8% failure rate), but the lost run contained the deepest single-run analysis of the entire dataset.

---

## 6. Cross-Project Contamination

### Direct Contamination: None Detected

Every FR-dispatched run addressed all projects that had anomalies. The `trigger_wakeup` action is project-agnostic (global), so all idle projects were covered even when the FR's report focused on one project.

### Indirect Contamination: Attention Displacement

| Project | FR report mentions | Task-level anomalies | idle_project anomalies |
|---------|:-----------------:|:-------------------:|:--------------------:|
| warehouse | 57 runs | 15 | 92 |
| prompter | 57 runs | 70 | 92 |
| steroids-cli | 4 runs | 3 | 3 |
| Technician | 2 runs | 21 | 0 |
| translatemy.world | 3 runs | 2 | 2 |
| monorepo | 1 run | 1 | 0 |

**Finding T10 (NEW)**: Technician had 21 task-level anomaly occurrences (all `high_invocations` for the Prisma schema task) across 15 runs but received FR attention in only 2 runs (15, 16). It was disabled at run 27 without the FR ever resetting or skipping the stuck task. The FR correctly diagnosed the issue in run 15 ("116 of 150 allowed invocations... strongly suggests a systemic problem") but issued `report_only` instead of `update_task` to skip it. This task burned 34+ more invocations (116 to 150) before hitting the cap.

**Finding T11 (NEW)**: The `project_disabled` mechanism (runs 27-57) created a form of cross-project contamination. When BOTH warehouse and prompter were disabled (all affected projects), the scan returned `project_disabled` without dispatching the FR. But task-level anomalies in those projects (repeated_failures, skipped_task) went unaddressed during disabled runs. Example: runs 39, 40, 45, 46, 50 each had 3 anomalies (including task-level) but the `project_disabled` outcome prevented any FR dispatch. The crude "all disabled = skip FR" logic was too coarse.

---

## 7. Cost Analysis

### Token Cost Estimate

| Component | Value |
|-----------|-------|
| FR invocations | 57 |
| Est. input tokens per invocation | ~1,100 (prompt template ~3,000 chars + scan data ~1,300 chars, /4) |
| Est. total input tokens | ~62,700 |
| Est. total output tokens | ~34,800 (reports + actions) |
| Est. cost at Claude Sonnet rates ($3/$15 per M) | **$0.71** |

The direct token cost is negligible. The real costs are:

### Wall Clock Cost

| Metric | Value |
|--------|-------|
| First FR dispatch | 2026-03-21 17:02:12 |
| Last FR dispatch | 2026-03-22 01:29:38 |
| Total wall clock (first to last FR) | 8.5 hours |
| FR runs during that window | 57 |
| Infinite chain wall clock (runs 59-91) | 2.2 hours |

### Waste Analysis

| Category | Runs | % of total |
|----------|------|-----------|
| Effective (meaningful task action) | 36 | 63.2% |
| Wasted (only trigger_wakeup/report_only) | 20 | 35.1% |
| Error (auth failure) | 3 | 5.3% |

**Finding T12 (NEW)**: 35% of all FR invocations were wasted -- they performed only `trigger_wakeup` (which never resolved idle_project across 92 runs) or `report_only` (no action). This 35% waste rate is concentrated in the infinite chain: 32 of the 57 FR runs (56%) were in the chain, and the chain's estimated cost is $0.43 (54.5% of total token cost).

### Cost by Phase

| Phase | FR runs | Report chars | Est. cost |
|-------|---------|-------------|-----------|
| First wave (15-22) | 6 | 4,564 | $0.06 |
| Remediation loop (23-58) | 19 | 9,788 | $0.18 |
| Infinite chain (59-90) | 32 | 51,329 | $0.43 |
| Total | 57 | 65,681 | $0.71 |

**Finding T13 (NEW)**: The infinite chain consumed 78% of all report output (51,329 of 65,681 chars) despite being only 56% of FR runs. Late-chain reports were 2.5x longer than early reports (due to deeper diagnostics from `d0c41e7`). Paradoxically, the best diagnostic reports were produced during the worst operational phase -- the chain was burning tokens on increasingly sophisticated analyses of problems it had already correctly diagnosed and couldn't fix.

---

## 8. The `project_disabled` / FR Alternation Pattern (NEW)

### What Happened

Runs 27-57 show a strict alternation pattern: `project_disabled` -> `first_responder_complete` -> `project_disabled` -> ...

The mechanism:
1. Scan finds anomalies in warehouse + prompter.
2. `countRemediationAttempts()` returns >= 3 for both projects.
3. Both projects are disabled via `disableProject()`.
4. Since all affected projects are disabled, outcome = `project_disabled`, no FR dispatched.
5. Next cron cycle: scan finds the same anomalies (disabled projects still have pending work).
6. But now `countRemediationAttempts()` count has been reset (or the fingerprint changed slightly due to a new task-level anomaly appearing), so the threshold is not met.
7. FR dispatches, performs `reset_task` + `trigger_wakeup`, records a new remediation attempt.
8. Next cycle: threshold met again -> `project_disabled`. Goto 4.

### Why It Stopped at Run 58

Commit `d0c41e7` (deployed as version 0.12.24 at 23:19:04 UTC) **removed the entire `project_disabled` code path** from `loop.ts`. The removal deleted:
- `disableProject()` function (lines 215-230)
- Remediation attempt threshold check in `monitorCheck()` (lines 261-280)
- Remediation attempt threshold check in `runMonitorCycle()` (lines 322-346)

Run 57 (23:14) was the last `project_disabled` run. Version 0.12.24 was published at 23:19:04. Run 58 (23:19:41) was the first run on the new version -- and the first run in the infinite chain.

**Finding T14 (CRITICAL, NEW)**: The `project_disabled` code path was a crude circuit breaker (threshold: 3 attempts). It was the ONLY thing preventing infinite FR dispatch loops for persistent anomalies. Commit `d0c41e7` removed it without replacing it with an alternative circuit breaker. This directly caused the infinite chain (M1 in the primary audit). The existing audit attributes the chain to the `manual: true` follow-up bypass, but the root cause is deeper: even without the follow-up chain, the cron-triggered scans (every 5 min) would have dispatched the FR indefinitely -- just slower (every 5 min instead of every 3 min). The `project_disabled` path was preventing this during runs 27-57.

### Impact

During the alternation phase (runs 27-57), the system dispatched FR in roughly every other cycle: 19 FR dispatches in 31 runs. After the circuit breaker removal (runs 59-91), the system dispatched FR in every single cycle: 32 FR dispatches in 33 runs. The circuit breaker, despite being crude, cut FR dispatch rate by ~40%.

---

## 9. Duplicate Scan Bypass (NEW)

### The Problem

39.1% of scans (36 of 91 consecutive pairs) were exact duplicates of the previous scan (same anomaly type + project + taskId fingerprint). The duplicate detection gate at `loop.ts:274-276` should skip these. But 21 of these 36 duplicate scans still dispatched the FR.

### Why Duplicates Still Dispatched

Two bypass paths:
1. **`manual: true`** (M1): The follow-up scan after FR completion passes `manual: true`, which explicitly bypasses `isDuplicateOfLastRun()`.
2. **`project_disabled` resets the comparison**: A `project_disabled` run breaks the duplicate chain because the previous run's outcome changes, even though the scan data is identical.

### The Longest Duplicate Chain

Runs 68-85: **18 consecutive scans** with the exact same fingerprint (`idle_project:prompter + idle_project:warehouse + skipped_task:prompter:d871ce3c`). All 18 dispatched the FR. All 18 produced reports. All 18 issued `trigger_wakeup` + `report_only`. Zero resolution.

**Finding T15 (NEW)**: The duplicate detection gate is rendered completely ineffective by the `manual: true` bypass. 21 of 36 duplicate scans (58%) still dispatched FR. The gate only works for cron-triggered scans, which are the minority of dispatches once the follow-up chain starts. The fix proposed in M1 (remove `manual: true`) would make the gate effective, but it should be combined with a "duplicate + FR already attempted" check that is immune to the manual flag.

---

## 10. Anomaly Flapping (NEW)

Several task-level anomalies appeared, disappeared, and reappeared across multiple runs:

| Anomaly | Project | Appearances | Total range | Notable gaps |
|---------|---------|:-----------:|:-----------:|-------------|
| skipped_task (d871ce3c) | prompter | 40 | 69 runs | Gaps at runs 25-32, 34-36, 38-39, 44-45, 48-50 |
| repeated_failures (various) | prompter | 8 | 33 runs | Max gap: 8 runs |
| blocked_task (d871ce3c) | prompter | 3 | 4 runs | Brief appearance in runs 64-67 |

**Finding T16 (NEW)**: Task `d871ce3c` (Android init) is the most flapping anomaly in the dataset. It appeared under 4 different anomaly types across its lifecycle: `skipped_task` (40 times), `repeated_failures` (via related prompter entries), `blocked_task` (3 times), `blocked_error` (via FR update_task). Each type change resets the duplicate detection fingerprint, causing a fresh FR dispatch even though it's the same underlying problem. The FR correctly diagnosed this as an infrastructure issue (cross-device link error) in run 63 but the system has no memory -- each new anomaly type triggers a fresh investigation.

---

## 11. Action Success Rates (NEW)

| Action | Success | Failure | Rate |
|--------|:-------:|:-------:|:----:|
| trigger_wakeup | 54 | 0 | 100% |
| reset_task | 39 | 0 | 100% |
| report_only | 24 | 0 | 100% |
| add_task_feedback | 17 | 0 | 100% |
| update_task | 15 | 0 | 100% |
| query_db | 8 | 0 | 100% |
| **reset_project** | **0** | **3** | **0%** |

**Finding T17 (NEW)**: `reset_project` failed in all 3 attempts (runs 24, 71, 71) with "tasks reset exited with code 1". The CLI command `steroids projects disable --path` or `steroids tasks reset` exits non-zero when invoked against these projects. Despite being offered in the prompt as an available action, it has a 0% success rate. The FR fell back to individual `reset_task` calls (which work) but wasted action slots on `reset_project` first.

---

## 12. Manual vs Automatic Trigger Pattern (NEW)

| Run | Outcome | Escalation reason | Trigger |
|-----|---------|------------------|---------|
| 15 | investigation_complete | None | Manual (WebUI "Try to Fix" button) |
| 16 | investigation_complete | None | Manual (WebUI) |
| 17 | anomalies_found | None | Cron (normal scan, no dispatch) |
| 18 | investigation_complete | 4 anomalies >= warning | **First automatic dispatch** |

Runs 15-16 have no `escalation_reason`, indicating manual trigger. The `investigation_complete` outcome (used in runs 15-22) was renamed to `first_responder_complete` in commit `acea428` ("normalize old investigation_complete outcome labels") at 18:11 UTC.

**Finding T18 (NEW)**: The first automatic FR dispatch was run 18, not run 15. The user manually triggered runs 15-16 from the WebUI after deploying the monitor feature. This means the 78-minute blind window (M10) was partially mitigated by manual intervention -- the user noticed the anomalies in the dashboard and triggered the FR manually at 17:02, 28 minutes before automatic dispatch would have kicked in (after the severity config change at ~17:24).

---

## 13. The `project_disabled` Ghost Outcome (NEW)

17 runs have outcome `project_disabled`. These runs:
- Have anomalies in their scan data (2-4 anomalies each)
- Have `escalation_reason` set (the system WANTED to dispatch FR)
- Have NO `first_responder_report`, NO `first_responder_actions`, NO `action_results`
- Were suppressed by the remediation attempt threshold check

**Finding T19 (NEW)**: 8 of the 17 `project_disabled` runs (39, 40, 42, 45, 46, 50, 54, 57) had task-level anomalies (`repeated_failures`, `skipped_task`) alongside the `idle_project` anomalies. The `project_disabled` logic checked remediation attempts at the PROJECT level, not the anomaly level. When the project hit 3 attempts for `idle_project`, ALL anomalies for that project were suppressed -- including task-level anomalies that had never been addressed. This is a granularity bug: the circuit breaker should operate per anomaly fingerprint, not per project.

---

## 14. Summary of New Findings

| ID | Severity | Finding |
|----|----------|---------|
| T1 | Low | No `completed_at` column in `monitor_runs` -- actual FR duration unmeasurable |
| T2 | Medium | 6.3-hour overnight blind spot (01:35-07:52) -- no monitor retry after auth failure |
| T3 | High | 3 projects (Technician, monorepo, translatemy.world) detected but NEVER acted upon |
| T4 | Medium | 78-minute blind window from default severity config (quantified) |
| T5 | Medium | Anomaly count never dropped below 2 -- permanent noise floor from S1 |
| T6 | Low | No correlation between FR actions and anomaly count reduction |
| T7 | Info | Commit d0c41e7 measurably improved report quality (+153% length, +50% false-positive detection) |
| T8 | Medium | FR diagnostic intelligence trapped without action channel (needs M9) |
| T9 | Medium | Parse failure in run 75 lost the deepest analysis; 1.8% parse failure rate |
| T10 | High | Technician burned 34+ extra invocations because FR used `report_only` instead of skip |
| T11 | Medium | `project_disabled` suppressed task-level anomalies as collateral damage |
| T12 | Medium | 35% of FR invocations wasted (only trigger_wakeup/report_only) |
| T13 | Info | Infinite chain produced 78% of all report output -- most tokens on best but futile analysis |
| T14 | **Critical** | d0c41e7 removed the only circuit breaker, directly causing the infinite chain |
| T15 | High | Duplicate detection gate rendered ineffective by `manual: true` bypass (58% bypass rate) |
| T16 | Medium | Task d871ce3c flapped across 4 anomaly types, defeating fingerprint-based dedup |
| T17 | Medium | `reset_project` action has 0% success rate (3/3 failures) |
| T18 | Info | First automatic dispatch was run 18 (not 15); user manually triggered runs 15-16 |
| T19 | High | Circuit breaker granularity bug: project-level suppression silenced task-level anomalies |
