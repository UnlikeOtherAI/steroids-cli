# Spec: Model Usage API Endpoint

## Design Doc
`docs/plans/2026-03-06-model-usage-page.md`

## What to Build

Create a new API route `GET /api/model-usage` that aggregates `task_invocations` data across all registered projects, grouped by `(provider, model)`. Register it in the API server.

## Files to Create/Edit

### 1. Create `API/src/routes/model-usage.ts` (~120 lines)

Follow the pattern in `API/src/routes/credit-alerts.ts`:
- Named export: `export const modelUsageRoutes = Router();`
- Reuse the `openProjectDb` helper pattern (open `<path>/.steroids/steroids.db` via `openSqliteForRead`)
- Multi-project iteration: `getRegisteredProjects(false).map(p => p.path)`, loop with try/catch/finally per project
- `skipped_projects` counter for DBs that fail to open or query

**SQL query** (use the exact query from the design doc, section "Data Source"):
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

**Query params:**
- `hours` (number, default 24): `parseInt`, clamp to 1-8760
- `project` (string, optional): filter to single project path

**Merge logic** (JS, after querying all project DBs):
- Key by `${provider}::${model}`
- Sum all raw count fields across projects
- After merge, derive:
  - `avg_duration_ms = Math.round(total_duration_ms / invocation_count)`
  - `success_rate = invocation_count > 0 ? Math.round((success_count / invocation_count) * 1000) / 10 : 0`
  - `cache_hit_rate = total_input_tokens > 0 ? Math.round(((total_cached_input_tokens + total_cache_read_tokens) / total_input_tokens) * 1000) / 10 : 0`

**Response shape:**
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
    "success_rate": 93.8,
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

### 2. Edit `API/src/index.ts` (3 lines)

Add import after line 47 (after credit-alerts import):
```typescript
import { modelUsageRoutes } from './routes/model-usage.js';
```

Add route mount after line 103 (after credit-alerts mount):
```typescript
app.use('/api/model-usage', modelUsageRoutes);
```

Add to endpoints list (after line 150, the credit-alerts entries):
```typescript
'GET /api/model-usage?hours=<hours>&project=<path>',
```

## Imports Reference

```typescript
import { Router, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteForRead } from '../utils/sqlite.js';
import { getRegisteredProjects } from '../../../dist/runners/projects.js';
```

## Edge Cases
- `token_usage_json` NULL or malformed: `json_valid()` guard returns 0
- Project DB missing/unreachable: skip, increment `skipped_projects`
- `hours` param invalid: `parseInt` + clamp 1-8760, default 24
- Division by zero in derived rates: guard with `invocation_count > 0` / `total_input_tokens > 0`
- No data in range: return empty `models` array, zeroed `summary`
