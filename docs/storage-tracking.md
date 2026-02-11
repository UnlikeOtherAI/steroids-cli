# Storage Tracking & Cleanup

## Problem Statement

As projects accumulate invocation logs, activity logs, backups, and database entries, the `.steroids/` folder grows unboundedly. Users have no visibility into how much disk space each project consumes, and no easy way to reclaim space from the WebUI. The only cleanup path today is via CLI commands (`steroids cleanup logs`, `steroids gc`, `steroids purge`), which most users won't discover until disk pressure becomes a problem.

**Current state:**
- No size information displayed anywhere in the WebUI
- No warnings when storage grows large
- Cleanup requires CLI knowledge
- The `.steroids/` folder can grow to hundreds of MB on active projects (primarily from invocation logs)

**Desired state:**
- Project cards show folder size in small text at the bottom
- Project detail page shows size breakdown
- Warning + cleanup button appears when size exceeds thresholds (50MB, 100MB)
- One-click "Clear old logs" from the WebUI
- Database and task data is preserved; only logs are cleared

---

## What Lives in .steroids/ and What Grows

| Directory/File | Purpose | Growth Rate | Safe to Clear |
|---------------|---------|-------------|---------------|
| `steroids.db` | Tasks, sections, disputes, audit trail, incidents | Slow (~1KB per task) | NO — core data |
| `steroids.db-wal` | SQLite write-ahead log | Fluctuates, cleared on checkpoint | NO — active DB |
| `steroids.db-shm` | SQLite shared memory | Fixed (~32KB) | NO — active DB |
| `config.yaml` | Project config | Static | NO — user config |
| `invocations/*.log` | JSONL activity logs per invocation | **Fast** — 10-500KB each, dozens per day | YES — old logs |
| `logs/YYYY-MM-DD/` | Text invocation logs by date | **Fast** — similar to invocations | YES — old logs |
| `backup/` | Full snapshots (DB + config + optional logs) | Per-backup (~1-10MB each) | YES — old backups |
| `tmp/` | Temporary files | Cleaned automatically (>1hr) | YES |
| `*.lock` | Lock files | Cleaned automatically (>10min) | YES |

**Primary growth driver:** `invocations/` and `logs/` directories. A project running 20 tasks/day with coder+reviewer cycles generates ~50-200MB/month of logs.

---

## Design

### Part 1: API — Storage Size Endpoint

**File:** `API/src/routes/projects.ts`

Add a new endpoint that computes storage breakdown for a project:

```
GET /api/projects/storage?path=<project-path>
```

Response:
```json
{
  "total_bytes": 52428800,
  "total_human": "50.0 MB",
  "breakdown": {
    "database": { "bytes": 2097152, "human": "2.0 MB" },
    "invocations": { "bytes": 35651584, "human": "34.0 MB", "file_count": 847 },
    "logs": { "bytes": 12582912, "human": "12.0 MB", "file_count": 423 },
    "backups": { "bytes": 2097152, "human": "2.0 MB", "backup_count": 3 },
    "other": { "bytes": 0, "human": "0 B" }
  },
  "clearable_bytes": 48234496,
  "clearable_human": "46.0 MB",
  "threshold_warning": "orange"
}
```

**Threshold levels:**
- `null` — under 50MB (no warning)
- `"orange"` — 50-100MB (gentle nudge)
- `"red"` — over 100MB (prominent warning)

**Implementation:**
- Use `fs.statSync()` recursively on the `.steroids/` directory
- Categorize files into database, invocations, logs, backups, other
- `clearable_bytes` = invocations + logs + backups (everything safe to delete)
- Cache the result for 60 seconds (disk scan is expensive on large directories)

#### Lightweight Size for Project List

For the project cards, we don't need a full breakdown — just the total size. Add `storage_bytes` to the existing `GET /api/projects` response:

```json
{
  "path": "/path/to/project",
  "name": "my-project",
  "storage_bytes": 52428800,
  "storage_human": "50.0 MB",
  "storage_warning": "orange",
  ...existing fields...
}
```

**Performance consideration:** Computing sizes for all projects on every list request would be slow. Instead:
- Compute storage size lazily (only when the `.steroids/` directory exists)
- Use a 5-minute cache per project path
- On first load, return `null` for storage and let the frontend treat it as "calculating..."

### Part 2: API — Clear Logs Endpoint

**File:** `API/src/routes/projects.ts`

```
POST /api/projects/clear-logs
```

Request:
```json
{
  "path": "/path/to/project",
  "retention_days": 7
}
```

Response:
```json
{
  "ok": true,
  "deleted_files": 423,
  "freed_bytes": 48234496,
  "freed_human": "46.0 MB"
}
```

**Implementation:**
- Reuse the existing `cleanupInvocationLogs()` from `src/cleanup/invocation-logs.ts`
- Also clean `logs/` directory (date-based text logs) with same retention
- Default retention: 7 days (keep last week of logs)
- Do NOT touch: `steroids.db`, `config.yaml`, `backup/`

---

### Part 3: Project Card — Size Indicator

**File:** `WebUI/src/components/molecules/ProjectCard.tsx`

Add a small size indicator at the bottom of each project card, below the existing "Last activity" footer:

```tsx
{/* Footer — existing */}
<div className="text-xs text-text-muted mt-2">
  Last activity: {lastActivity}
</div>

{/* Storage indicator — new */}
{project.storage_human && (
  <div className="flex items-center gap-1.5 text-xs text-text-muted mt-1">
    <i className="fa-solid fa-database text-[10px]" />
    <span>{project.storage_human}</span>
    {project.storage_warning === 'red' && (
      <span className="text-danger font-medium">cleanup recommended</span>
    )}
  </div>
)}
```

**Visual spec:**
- Font: `text-xs` (12px), `text-text-muted` color (same as "Last activity")
- Icon: `fa-database` at 10px, subtle
- When over 100MB: append "cleanup recommended" in `text-danger` (red)
- When under 50MB or null: just show the size, no warning
- When null (still calculating): show nothing (don't flash "calculating...")

---

### Part 4: Project Detail Page — Storage Section

**File:** `WebUI/src/pages/ProjectDetailPage.tsx`

Add a "Storage" section below the existing "Current Queue" stats, before "Sections":

```tsx
{/* Storage Section */}
<div className="bg-bg-surface rounded-xl p-4">
  <div className="flex items-center justify-between mb-3">
    <h3 className="text-sm font-semibold text-text-primary">Storage</h3>
    {storage && storage.total_bytes > 0 && (
      <span className="text-lg font-semibold text-text-primary">
        {storage.total_human}
      </span>
    )}
  </div>

  {/* Breakdown bars */}
  <div className="space-y-2">
    <StorageBar label="Database" item={storage.breakdown.database} color="bg-info" />
    <StorageBar label="Invocation Logs" item={storage.breakdown.invocations} color="bg-warning" />
    <StorageBar label="Text Logs" item={storage.breakdown.logs} color="bg-accent" />
    <StorageBar label="Backups" item={storage.breakdown.backups} color="bg-success" />
  </div>

  {/* Warning + cleanup button */}
  {storage.threshold_warning && (
    <div className={`mt-4 p-3 rounded-lg flex items-center justify-between ${
      storage.threshold_warning === 'red'
        ? 'bg-danger-soft'
        : 'bg-warning-soft'
    }`}>
      <div className="flex items-center gap-2">
        <i className="fa-solid fa-triangle-exclamation text-sm" />
        <span className="text-sm">
          {storage.clearable_human} of old logs can be cleared
        </span>
      </div>
      <button
        onClick={handleClearLogs}
        className="px-3 py-1.5 text-sm font-medium bg-bg-elevated
                   rounded-lg hover:bg-bg-surface2 transition-colors"
      >
        Clear Old Logs
      </button>
    </div>
  )}
</div>
```

**StorageBar sub-component** (inline, not a separate file):
```tsx
function StorageBar({ label, item, color, total }: {
  label: string;
  item: { bytes: number; human: string; file_count?: number };
  color: string;
  total: number;
}) {
  const pct = total > 0 ? (item.bytes / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs text-text-secondary mb-0.5">
        <span>{label}</span>
        <span>{item.human}{item.file_count ? ` (${item.file_count} files)` : ''}</span>
      </div>
      <div className="h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`}
             style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
    </div>
  );
}
```

**Behavior:**
- Fetches storage data from `GET /api/projects/storage?path=...` on page load
- Shows a horizontal bar chart with proportional widths
- "Clear Old Logs" button appears only when `threshold_warning` is set (50MB+)
- Button color: orange warning background at 50-100MB, red danger background at 100MB+
- After clearing: refetch storage data to update the display

**Clear Logs Flow:**
1. User clicks "Clear Old Logs"
2. Button shows spinner, disabled state
3. `POST /api/projects/clear-logs` with project path and 7-day retention
4. On success: show brief success message ("Freed 46.0 MB"), refetch storage
5. On error: show inline error message

---

### Part 5: API Client Additions

**File:** `WebUI/src/services/api.ts`

```typescript
export const projectsApi = {
  // ...existing methods...

  async getStorage(projectPath: string): Promise<StorageInfo> {
    return fetchJson(`/api/projects/storage?path=${encodeURIComponent(projectPath)}`);
  },

  async clearLogs(projectPath: string, retentionDays = 7): Promise<ClearLogsResult> {
    return fetchJson('/api/projects/clear-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, retention_days: retentionDays }),
    });
  },
};
```

---

## Implementation Order

### Phase 1: Backend
1. Add `getDirectorySize()` utility function (recursive, categorized)
2. Add `GET /api/projects/storage` endpoint with caching
3. Add `storage_bytes` / `storage_human` / `storage_warning` to `GET /api/projects` response
4. Add `POST /api/projects/clear-logs` endpoint (reuses existing cleanup logic)

### Phase 2: Frontend
5. Update `ProjectCard.tsx` — add size indicator at bottom
6. Update `ProjectDetailPage.tsx` — add Storage section with breakdown bars
7. Add "Clear Old Logs" button with confirmation + success feedback
8. Add API client methods to `api.ts`

### Phase 3: Testing
9. Unit test for `getDirectorySize()` utility
10. API test for storage and clear-logs endpoints

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| .steroids/ doesn't exist | Return `total_bytes: 0`, no warning |
| Project path is invalid/missing | Return 404 |
| Logs directory is empty | Show 0 B for logs, no cleanup button |
| Runner is actively writing logs | Skip files modified in last 60 seconds |
| Very large directory (10K+ files) | Cache result for 5 minutes, async compute |
| Clear logs while runner is active | Safe — only deletes files older than retention period |
| Multiple clear requests in quick succession | Idempotent — second request finds fewer/no files |
| Database WAL file is large (temp) | Include in "database" category but don't offer to clear |

---

## Non-Goals

- Real-time file watching (polling on page load is sufficient)
- Auto-cleanup schedules from the WebUI (CLI cron handles this)
- Clearing the database itself (too destructive for a UI button)
- Per-task storage breakdown (too granular, low value)
- Clearing backups from the WebUI (use `steroids backup clean` CLI)

---

## Appendix: Cross-Provider Design Review

*Reviewed by Codex (gpt-5.3-codex). Findings below with our assessment of each.*

### Finding 1: Backup policy inconsistency
**Codex says:** The table says backups are "safe to clear" but Part 2 says "do NOT touch backup/".
**Assessment: VALID.** This is a genuine inconsistency. Decision: backups are NOT cleared by the "Clear Old Logs" button — the button only clears invocations/ and logs/ directories. The table should say "YES — old backups (via CLI only)" to clarify that backup cleanup is available but not from this UI flow. Updated the table in the design.

### Finding 2: Sync vs async file scanning
**Codex says:** `fs.statSync()` blocks the event loop; the doc mentions "async compute" but implementation uses sync.
**Assessment: VALID.** Use `fs.promises.stat()` with async recursion. The API is Express so async handlers are natural. The doc pseudo-code was illustrative, not prescriptive — implementation should use async fs operations.

### Finding 3: N-project cold cache latency
**Codex says:** `GET /api/projects` could trigger N scans on cold cache.
**Assessment: VALID but mitigated.** The design already specifies returning `null` on first load. The async background computation + 5-minute cache per path handles this. Implementation should use a background worker pattern: return cached/null immediately, trigger async recompute if stale.

### Finding 4: Cache invalidation after cleanup
**Codex says:** Missing explicit cache bust after `POST /clear-logs`.
**Assessment: VALID.** Simple fix: clear the cache entry for the project path after successful cleanup. Added to implementation notes.

### Finding 5: Threshold based on clearable bytes, not total
**Codex says:** Warning based on total bytes could trigger when DB is large but nothing is clearable.
**Assessment: VALID and smart.** Change thresholds to be based on `clearable_bytes` instead of `total_bytes`. A 90MB project with 88MB database and 2MB logs shouldn't show a warning.

### Finding 6: Path traversal security
**Codex says:** User-supplied `path` could target unintended directories. Canonicalize, validate against known projects, reject symlinks.
**Assessment: VALID.** The clear-logs endpoint must verify the path is a registered project before deleting anything. Check against the `projects` table in the global DB. Use `fs.realpathSync()` to resolve symlinks before comparison.

### Finding 7: StorageBar missing `total` prop
**Codex says:** JSX calls to `StorageBar` omit the required `total` prop.
**Assessment: VALID.** Pseudo-code bug — pass `total={storage.total_bytes}` to each `StorageBar`. Trivial fix in implementation.

### Finding 8: Simplify scanning to known subpaths
**Codex says:** Instead of full recursive categorization, directly measure known subpaths (`steroids.db*`, `invocations/`, `logs/`, `backup/`).
**Assessment: ADOPT.** This is both simpler and faster — we know exactly which directories matter. Scan only those 4 categories + sum the rest as "other". No need for generic recursive categorization.

### Finding 9: Shared cleanup service for CLI + API
**Codex says:** Reuse one shared service to avoid drift between CLI and API cleanup paths.
**Assessment: ADOPT.** The existing `cleanupInvocationLogs()` in `src/cleanup/invocation-logs.ts` should be the single source of truth. The API endpoint calls it directly. Add a sibling function for text logs cleanup in the same file.

### Finding 10: dry_run mode for clear-logs
**Codex says:** Add `dry_run=true` so UI can preview what would be freed.
**Assessment: DEFER.** The storage endpoint already shows `clearable_bytes` which serves the same purpose. A separate dry-run adds complexity without clear UX benefit for V1. Can add later if users request it.

### Summary of Adopted Changes

| Change | Source |
|--------|--------|
| Backup policy: clarify backups NOT cleared by UI button | Codex finding 1 |
| Use async fs operations, not sync | Codex finding 2 |
| Bust cache after cleanup | Codex finding 4 |
| Base thresholds on clearable_bytes, not total | Codex finding 5 |
| Validate path against registered projects | Codex finding 6 |
| Scan known subpaths instead of full recursion | Codex finding 8 |
| Reuse shared cleanup service for CLI + API | Codex finding 9 |
