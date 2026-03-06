# Design: Model Usage Page

## Problem Statement

The dashboard shows aggregate task stats (completed/failed/skipped counts, tasks per hour, success rate) but provides zero visibility into per-model, per-provider execution details. Users cannot see which models consume the most time, have the highest failure rates, cost the most, or use the most tokens. All the raw data exists in the `task_invocations` table — it just needs aggregation and a UI.

## Current Behavior

- **Dashboard** (`WebUI/src/pages/DashboardPage.tsx`): Shows only task-level stats — completed/failed/skipped counts, queue status, runner status, progress bar. No model or provider breakdown.
- **`task_invocations` table** (`src/database/schema.ts:164-189`): Already captures `provider`, `model`, `role`, `duration_ms`, `started_at_ms`, `completed_at_ms`, `status`, `success`, `token_usage_json` per invocation. Never queried for aggregation.

## Desired Behavior

A new dedicated **Model Usage** page accessible from the sidebar showing per model/provider cards with: actual execution time (not queue/idle time), invocation counts, success rates, token usage, and costs. All sourced from `task_invocations` across registered projects.

Dashboard remains unchanged — summary only.

## Design

### Data Source: `task_invocations` table

SQL aggregation grouped by `(provider, model)`, filtered by time range. Uses `created_at` index (existing `idx_task_invocations_created`) instead of `started_at_ms` (no index) to avoid full table scans:

```sql
SELECT
  provider, model,
  COUNT(*) AS invocation_count,
  SUM(CASE WHEN role='coder' THEN 1 ELSE 0 END) AS coder_count,
  SUM(CASE WHEN role='reviewer' THEN 1 ELSE 0 END) AS reviewer_count,
  SUM(duration_ms) AS total_duration_ms,
  SUM(success) AS success_count,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_count,
  SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) AS timeout_count,
  COALESCE(SUM(CASE WHEN json_valid(token_usage_json) THEN json_extract(token_usage_json,'$.inputTokens') ELSE 0 END),0) AS total_input_tokens,
  COALESCE(SUM(CASE WHEN json_valid(token_usage_json) THEN json_extract(token_usage_json,'$.outputTokens') ELSE 0 END),0) AS total_output_tokens,
  COALESCE(SUM(CASE WHEN json_valid(token_usage_json) THEN json_extract(token_usage_json,'$.cachedInputTokens') ELSE 0 END),0) AS total_cached_input_tokens,
  COALESCE(SUM(CASE WHEN json_valid(token_usage_json) THEN json_extract(token_usage_json,'$.cacheReadTokens') ELSE 0 END),0) AS total_cache_read_tokens,
  COALESCE(SUM(CASE WHEN json_valid(token_usage_json) THEN json_extract(token_usage_json,'$.cacheCreationTokens') ELSE 0 END),0) AS total_cache_creation_tokens,
  COALESCE(SUM(CASE WHEN json_valid(token_usage_json) THEN json_extract(token_usage_json,'$.totalCostUsd') ELSE 0 END),0) AS total_cost_usd
FROM task_invocations
WHERE created_at >= datetime('now', '-' || ? || ' hours')
  AND status IN ('completed', 'failed', 'timeout')
GROUP BY provider, model
ORDER BY total_duration_ms DESC
```

Key changes from initial draft (per cross-provider review):
- **`json_valid()` guard** — protects against malformed JSON crashing the entire query
- **Removed `running_count`** — `WHERE status IN (...)` excludes running rows, so counting them was always 0 (logic error caught in review)
- **Removed `avg_duration_ms`** — cannot be summed across project DBs; compute in JS as `total_duration_ms / invocation_count`
- **Uses `created_at` index** — avoids full table scan on `started_at_ms` (no standalone index)

Pattern follows `API/src/routes/credit-alerts.ts`: iterate `getRegisteredProjects()`, open each DB with `openSqliteForRead`, run query, merge results by `(provider, model)` key in JS. Derived metrics (`avg_duration_ms`, `success_rate`, `cache_hit_rate`) computed after merge from raw counts.

### API Endpoint

**`GET /api/model-usage?hours=24&project=<path>`**

Query params:
- `hours` (number, default 24, validated: `parseInt`, clamped 1-8760)
- `project` (string, optional — filter to single project)

Response:
```json
{
  "summary": {
    "total_duration_ms": 3600000,
    "total_invocations": 150,
    "total_cost_usd": 12.50,
    "total_input_tokens": 500000,
    "total_output_tokens": 120000
  },
  "models": [{
    "provider": "claude",
    "model": "claude-sonnet-4-6",
    "invocation_count": 80,
    "coder_count": 50,
    "reviewer_count": 30,
    "total_duration_ms": 2400000,
    "avg_duration_ms": 30000,
    "success_count": 75,
    "failed_count": 3,
    "timeout_count": 2,
    "success_rate": 93.75,
    "tokens": {
      "input": 300000,
      "output": 80000,
      "cached_input": 50000,
      "cache_read": 40000,
      "cache_creation": 10000
    },
    "cache_hit_rate": 30.0,
    "total_cost_usd": 8.50
  }],
  "skipped_projects": 0
}
```

- `avg_duration_ms` — computed in JS: `Math.round(total_duration_ms / invocation_count)`
- `success_rate` — computed in JS: `(success_count / invocation_count) * 100`, rounded to 1 decimal
- `cache_hit_rate` — computed in JS: `((cached_input + cache_read) / input) * 100`. Provider-aware: Claude uses `cache_read`, Codex/Gemini use `cached_input`. The formula `(cached_input + cache_read) / input` works for all since providers only populate their own field.
- `skipped_projects` — count of project DBs that failed to open or query (partial failure transparency)

### Page Layout

```
Page: /model-usage
Nav: ChartBarIcon, "Model Usage" (after Dashboard in sidebar)

+-- Header: "Model Usage" + TimeRangeSelector (reuse existing)
|
+-- Summary row (4 StatTile cards)
|   Total Exec Time (Xh Ym) | Invocations | Cost ($X.XX) | Tokens (XM)
|
+-- Card grid (grid-cols-1 md:grid-cols-2 lg:grid-cols-3)
    Per provider+model card:
      Header: provider badge + model name
      - Execution time (purely active, from duration_ms)
      - Invocations (total, coder: N / reviewer: N)
      - Success rate (green >=90%, yellow >=70%, red <70%)
      - Avg duration per invocation
      - Tokens in/out (formatted K/M)
      - Cache hit rate (%)
      - Cost (if available)
      - Failed/timeout counts (red/orange badges, hidden if 0)
```

### Component Structure (per review finding I5)

Split into focused components to stay well under 500-line limit:

- `ModelUsagePage.tsx` — orchestrator: time range state, data fetching, layout (~100 lines)
- `ModelUsageSummary.tsx` — summary StatTile row (~40 lines)
- `ModelUsageCard.tsx` — individual model/provider card (~80 lines)
- `WebUI/src/utils/format.ts` — shared helpers: `formatDuration`, `formatTokens`, `formatCost` (~30 lines)
- `WebUI/src/types/model-usage.ts` — types (~40 lines)

### Formatting Helpers

```typescript
function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  return usd === 0 ? '--' : `$${usd.toFixed(2)}`;
}
```

## Implementation Order

1. **`API/src/routes/model-usage.ts`** — New file (~120 lines). SQL query + multi-project iteration + merge + derive.
2. **`API/src/index.ts`** — Register route (3 lines).
3. **`WebUI/src/types/model-usage.ts`** — New file (~40 lines). TypeScript interfaces.
4. **`WebUI/src/types/index.ts`** — Export (1 line).
5. **`WebUI/src/services/api.ts`** — Add `modelUsageApi` (~10 lines).
6. **`WebUI/src/utils/format.ts`** — New file (~30 lines). Shared formatting helpers.
7. **`WebUI/src/pages/ModelUsagePage.tsx`** — New file (~100 lines). Page orchestrator.
8. **`WebUI/src/pages/ModelUsageSummary.tsx`** — New file (~40 lines). Summary row.
9. **`WebUI/src/pages/ModelUsageCard.tsx`** — New file (~80 lines). Individual card.
10. **`WebUI/src/App.tsx`** — Lazy import + route + title (3 lines).
11. **`WebUI/src/components/layouts/Sidebar.tsx`** — Nav item + icon import (2 lines).

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No invocations in time range | "No data for selected range" empty state |
| `token_usage_json` is NULL | `json_valid()` returns false, `CASE` falls to 0 |
| `token_usage_json` is malformed JSON | `json_valid()` returns false, `CASE` falls to 0 |
| Project DB missing/unreachable | Skip, increment `skipped_projects` counter |
| Multiple projects with same provider/model | Merge by summing raw counts; derive rates after merge |
| Division by zero in success_rate | Guard: if `invocation_count == 0`, rate is 0 |
| `duration_ms` is 0 or NULL | Still counted; avg reflects this |
| `hours` param invalid | `parseInt` + clamp to 1-8760, default 24 |

## Non-Goals

- No charts or graphs (no charting library installed)
- No historical trend visualization
- No per-task breakdown (exists in TaskDetailPage)
- No editing/configuration from this page
- No real-time streaming — fetch on page load and time range change
- No new database schema changes or migrations
- No external CLI usage data (deferred — see Cross-Provider Review)

## Cross-Provider Review

Reviewed by Claude (`superpowers:code-reviewer`) and Codex (`codex exec`) in parallel.

| Finding | Reviewer | Severity | Decision | Rationale |
|---------|----------|----------|----------|-----------|
| `execFileNoThrow` doesn't exist | Claude | CRITICAL | Adopt (moot) | Resolved by deferring external source |
| Missing `npx -y` flag | Claude | CRITICAL | Adopt (moot) | Resolved by deferring external source |
| `npx @latest` from API handler is unsound | Both | CRITICAL | **Adopt** | Deferred external source to follow-up. Internal data covers all providers already. |
| Home-dir data on unauthenticated LAN API | Codex | CRITICAL | **Adopt** | Security risk. External data deferred entirely. |
| `running_count` always 0 (logic error) | Both | CRITICAL | **Adopt** | Removed from query. `WHERE status IN (...)` excludes running. |
| Gemini parsing underspecified | Claude | IMPORTANT | **Defer** | Ship internal first; revisit when external source is added |
| `avg_duration_ms` can't be summed | Claude | IMPORTANT | **Adopt** | Removed from SQL, computed in JS after merge |
| No index on `started_at_ms` | Claude | IMPORTANT | **Adopt** | Switched to `created_at` which has existing DESC index |
| Cache hit rate needs provider-aware logic | Claude | IMPORTANT | **Adopt** | Formula: `(cached_input + cache_read) / input` works for all |
| Page 350 lines — plan splitting | Claude | IMPORTANT | **Adopt** | Split into Page + Summary + Card components |
| `json_valid()` guard needed | Codex | HIGH | **Adopt** | Added `CASE WHEN json_valid(...) THEN ... ELSE 0 END` |
| Partial failure metadata | Codex | MEDIUM | **Adopt** | Added `skipped_projects` to response |
| Merge logic underspecified | Codex | MEDIUM | **Adopt** | Merge only raw counts, derive rates after |
| `hours` input validation | Claude | LOW | **Adopt** | Added parseInt + clamp |
| No test strategy | Codex | LOW | **Defer** | Follow-up task after implementation |
| Response cache | Claude | LOW | **Defer** | Premature for v1 |

### Deferred Follow-Up: External CLI Usage

A future phase can add per-provider CLI usage cards by:
1. Installing `ccusage` and `@ccusage/codex` as project dependencies (not `npx @latest`)
2. Calling their APIs programmatically (not subprocess)
3. Adding Gemini file parsing with documented schema
4. Gating external data behind opt-in config or localhost-only access
5. Adding in-memory cache with 60s TTL

This is tracked separately and not required for the initial Model Usage page.
