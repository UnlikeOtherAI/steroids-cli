# Spec: Model Usage Frontend Types, API Client, and Format Utils

## Design Doc
`docs/plans/2026-03-06-model-usage-page.md`

## What to Build

Add TypeScript types for the model-usage API response, an API client method, and shared formatting helpers. This is the plumbing layer the page components will consume.

## Files to Create/Edit

### 1. Create `WebUI/src/types/model-usage.ts` (~40 lines)

Follow the pattern in `WebUI/src/types/activity.ts`.

```typescript
export interface ModelUsageTokens {
  input: number;
  output: number;
  cached_input: number;
  cache_read: number;
  cache_creation: number;
}

export interface ModelUsageEntry {
  provider: string;
  model: string;
  invocation_count: number;
  coder_count: number;
  reviewer_count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  success_count: number;
  failed_count: number;
  timeout_count: number;
  success_rate: number;
  tokens: ModelUsageTokens;
  cache_hit_rate: number;
  total_cost_usd: number;
}

export interface ModelUsageSummary {
  total_duration_ms: number;
  total_invocations: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface ModelUsageResponse {
  summary: ModelUsageSummary;
  models: ModelUsageEntry[];
  skipped_projects: number;
}
```

### 2. Edit `WebUI/src/types/index.ts` (1 line)

Add after line 7 (after the task export):
```typescript
export * from './model-usage';
```

### 3. Edit `WebUI/src/services/api.ts` (~10 lines)

Add import of the new type at the top (add `ModelUsageResponse` to the imports from `'../types'`).

Add API client object before the `configApi` export (around line 470):

```typescript
export const modelUsageApi = {
  async getUsage(hours: number, projectPath?: string): Promise<ModelUsageResponse> {
    let url = `/api/model-usage?hours=${hours}`;
    if (projectPath) {
      url += `&project=${encodeURIComponent(projectPath)}`;
    }
    return fetchJson<ModelUsageResponse>(url);
  },
};
```

Follow the `activityApi.getStats` pattern — same URL construction style with optional project param.

### 4. Create `WebUI/src/utils/format.ts` (~30 lines)

This directory does not exist yet — create `WebUI/src/utils/` first.

```typescript
export function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(usd: number): string {
  return usd === 0 ? '--' : `$${usd.toFixed(2)}`;
}
```

## Acceptance Criteria
- `npm run build` passes in the WebUI project with no type errors
- `ModelUsageResponse` is importable from `'../types'`
- `modelUsageApi.getUsage(24)` returns a typed response
- Format helpers produce: `formatDuration(3661000)` → `"1h 1m"`, `formatTokens(1500000)` → `"1.5M"`, `formatCost(0)` → `"--"`, `formatCost(12.5)` → `"$12.50"`
