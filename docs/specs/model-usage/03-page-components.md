# Spec: Model Usage Page Components and Routing

## Design Doc
`docs/plans/2026-03-06-model-usage-page.md`

## What to Build

Three new page components for the Model Usage view, plus routing and sidebar registration. The page displays per-model/provider cards with execution time, invocation counts, success rates, token usage, and costs — all from `task_invocations` data.

## Files to Create/Edit

### 1. Create `WebUI/src/pages/ModelUsagePage.tsx` (~100 lines)

Page orchestrator. Follow the pattern in `DashboardPage.tsx`:
- Named export: `export const ModelUsagePage: React.FC<Props>`
- Props: `{ project?: Project | null }`
- Uses `useProject()` context (same as Dashboard — the project comes from props)
- State: `selectedRange` (TimeRangeOption, default `TIME_RANGE_OPTIONS[1]` = 24h), `data` (ModelUsageResponse | null), `loading`, `error`
- Fetches via `modelUsageApi.getUsage(selectedRange.hours, project?.path)` in a `useCallback` + `useEffect` pattern (same as DashboardPage lines 30-41)
- Re-fetches when `selectedRange.hours` or `project?.path` changes

Layout:
```
<div className="p-8 max-w-6xl mx-auto">
  {/* Header */}
  <div className="card p-6 mb-6">
    <div className="flex items-center justify-between">
      <h1 className="text-3xl font-bold text-text-primary">Model Usage</h1>
      <TimeRangeSelector value={selectedRange.value} onChange={setSelectedRange} />
    </div>
  </div>

  {/* Loading state */}
  {loading && !data && <loading spinner/>}

  {/* Error state */}
  {error && <error message/>}

  {/* Summary row */}
  {data && <ModelUsageSummary summary={data.summary} />}

  {/* Cards grid */}
  {data && data.models.length > 0 && (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {data.models.map(entry => (
        <ModelUsageCard key={`${entry.provider}::${entry.model}`} entry={entry} />
      ))}
    </div>
  )}

  {/* Empty state */}
  {data && data.models.length === 0 && (
    <div className="card p-12 text-center text-text-muted">
      No model usage data for the selected time range
    </div>
  )}

  {/* Skipped projects warning */}
  {data && data.skipped_projects > 0 && (
    <div className="text-xs text-text-muted mt-4">
      {data.skipped_projects} project(s) could not be queried
    </div>
  )}
</div>
```

Imports:
```typescript
import React, { useEffect, useState, useCallback } from 'react';
import { Project, TimeRangeOption, TIME_RANGE_OPTIONS, ModelUsageResponse } from '../types';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { modelUsageApi } from '../services/api';
import { ModelUsageSummary } from './ModelUsageSummary';
import { ModelUsageCard } from './ModelUsageCard';
```

### 2. Create `WebUI/src/pages/ModelUsageSummary.tsx` (~40 lines)

Summary StatTile row showing 4 aggregate metrics.

```typescript
import React from 'react';
import { ModelUsageSummary as SummaryData } from '../types';
import { StatTile } from '../components/molecules/StatTile';
import { formatDuration, formatTokens, formatCost } from '../utils/format';

interface Props {
  summary: SummaryData;
}

export const ModelUsageSummary: React.FC<Props> = ({ summary }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
    <StatTile
      label="Total Exec Time"
      value={formatDuration(summary.total_duration_ms)}
    />
    <StatTile
      label="Invocations"
      value={summary.total_invocations}
    />
    <StatTile
      label="Cost"
      value={formatCost(summary.total_cost_usd)}
    />
    <StatTile
      label="Tokens"
      value={formatTokens(summary.total_input_tokens + summary.total_output_tokens)}
      description={`${formatTokens(summary.total_input_tokens)} in / ${formatTokens(summary.total_output_tokens)} out`}
    />
  </div>
);
```

### 3. Create `WebUI/src/pages/ModelUsageCard.tsx` (~80 lines)

Individual model/provider card. Uses Tailwind classes consistent with existing cards.

```typescript
import React from 'react';
import { ModelUsageEntry } from '../types';
import { formatDuration, formatTokens, formatCost } from '../utils/format';

interface Props {
  entry: ModelUsageEntry;
}

export const ModelUsageCard: React.FC<Props> = ({ entry }) => {
  const successColor = entry.success_rate >= 90 ? 'text-success'
    : entry.success_rate >= 70 ? 'text-warning' : 'text-danger';

  return (
    <div className="card p-5">
      {/* Header: provider badge + model name */}
      <div className="flex items-center gap-2 mb-4">
        <span className="badge-accent text-xs">{entry.provider}</span>
        <span className="text-sm font-semibold text-text-primary truncate">{entry.model}</span>
      </div>

      {/* Metrics grid */}
      <div className="space-y-3 text-sm">
        {/* Execution time */}
        <div className="flex justify-between">
          <span className="text-text-secondary">Exec Time</span>
          <span className="font-medium text-text-primary">{formatDuration(entry.total_duration_ms)}</span>
        </div>

        {/* Invocations with coder/reviewer breakdown */}
        <div className="flex justify-between">
          <span className="text-text-secondary">Invocations</span>
          <span className="text-text-primary">
            <span className="font-medium">{entry.invocation_count}</span>
            <span className="text-text-muted text-xs ml-1">
              ({entry.coder_count}c / {entry.reviewer_count}r)
            </span>
          </span>
        </div>

        {/* Success rate */}
        <div className="flex justify-between">
          <span className="text-text-secondary">Success Rate</span>
          <span className={`font-medium ${successColor}`}>{entry.success_rate}%</span>
        </div>

        {/* Avg duration */}
        <div className="flex justify-between">
          <span className="text-text-secondary">Avg Duration</span>
          <span className="text-text-primary">{formatDuration(entry.avg_duration_ms)}</span>
        </div>

        {/* Tokens */}
        <div className="flex justify-between">
          <span className="text-text-secondary">Tokens</span>
          <span className="text-text-primary">
            {formatTokens(entry.tokens.input)} in / {formatTokens(entry.tokens.output)} out
          </span>
        </div>

        {/* Cache hit rate */}
        {entry.cache_hit_rate > 0 && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Cache Hit Rate</span>
            <span className="text-text-primary">{entry.cache_hit_rate}%</span>
          </div>
        )}

        {/* Cost */}
        <div className="flex justify-between">
          <span className="text-text-secondary">Cost</span>
          <span className="font-medium text-text-primary">{formatCost(entry.total_cost_usd)}</span>
        </div>

        {/* Failed/timeout badges — only shown if > 0 */}
        {(entry.failed_count > 0 || entry.timeout_count > 0) && (
          <div className="flex gap-2 pt-1">
            {entry.failed_count > 0 && (
              <span className="badge-danger text-xs">{entry.failed_count} failed</span>
            )}
            {entry.timeout_count > 0 && (
              <span className="badge-warning text-xs">{entry.timeout_count} timeout</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
```

### 4. Edit `WebUI/src/App.tsx` (3 lines)

Add lazy import after line 20 (after SystemLogsPage):
```typescript
const ModelUsagePage = lazy(() => import('./pages/ModelUsagePage').then(({ ModelUsagePage }) => ({ default: ModelUsagePage })));
```

Add route after line 131 (after the Dashboard route):
```typescript
<Route path="/model-usage" element={<ModelUsagePage project={selectedProject} />} />
```

Add to `getPageTitle()` switch statement (before `default`):
```typescript
case '/model-usage': return 'Model Usage';
```

### 5. Edit `WebUI/src/components/layouts/Sidebar.tsx` (2 lines)

Add import of `ChartBarIcon` to the heroicons import (line 3-14):
```typescript
ChartBarIcon,
```

Add nav item after the Dashboard entry (line 50, after `{ to: '/', icon: HomeIcon, label: 'Dashboard' }`):
```typescript
{ to: '/model-usage', icon: ChartBarIcon, label: 'Model Usage' },
```

## Acceptance Criteria
- `npm run build` passes for the full project (API + WebUI)
- Navigate to `/model-usage` in the browser — page renders with header + time range selector
- Cards populate from existing `task_invocations` data
- Time range switching (12h/24h/1w/1m) re-fetches and updates
- Project filtering via ProjectSelector in AppShell works (passes project prop)
- Empty state shows "No model usage data" when no invocations in range
- Sidebar shows "Model Usage" entry with ChartBarIcon after Dashboard
- Cards show color-coded success rate (green >= 90%, yellow >= 70%, red < 70%)
- Failed/timeout badges only appear when counts > 0
- Cache hit rate row hidden when 0%
