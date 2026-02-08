# Reporting Improvements Specification

## Problem Statement

Currently, monitoring Steroids requires:
1. Running `steroids loop` interactively and watching output
2. Manually running `steroids tasks list` to check status
3. Tailing log files with no structured format
4. No easy way to get a quick summary for scripts/dashboards

## Goals

1. **Non-interactive status command** - Get current state without running loop
2. **Structured log output** - Machine-readable logs for parsing
3. **Live log following** - `tail -f` style output for real-time monitoring
4. **Summary/digest view** - Quick overview of what's happening

---

## Proposed Commands

### 1. `steroids status`

Quick non-interactive status check **for the current project**.

> **Note:** This differs from `steroids runners status` which shows runners across ALL registered projects. `steroids status` is project-scoped and provides task-level detail.

```bash
# Human-readable summary
steroids status

# Output:
# Runner: ACTIVE (PID 12345, running for 2h 15m)
# Current Task: Implementing steroids projects command
# Progress: 58/139 tasks complete (42%)
# Phase 0.4: 5/16 complete
# Rejections: 3 active tasks have rejections
# Last activity: 2 minutes ago

# Machine-readable
steroids status --json
```

**Implementation:**
- Reads from `.steroids/steroids.db` (project database)
- References `~/.steroids/steroids.db` for runner state
- No side effects, purely informational
- Exit code 0 if healthy, non-zero if issues detected

**Comparison:**
| Command | Scope | Shows |
|---------|-------|-------|
| `steroids status` | Current project | Tasks, sections, current activity |
| `steroids runners status` | All projects | Runner PIDs, heartbeats, lock state |

### 2. `steroids logs tail`

Real-time log following with filtering.

> **Note:** Basic `steroids logs tail` exists. Enhancements add filtering and structured output. Related tasks in Phase 11 (Watch Command).

```bash
# Follow all logs
steroids logs tail

# Follow specific task
steroids logs tail --task edff642c

# Follow by role (coder/reviewer)
steroids logs tail --role coder

# Follow with timestamps
steroids logs tail --timestamps

# JSON output for piping
steroids logs tail --json
```

**Output format (default):**
```
[12:45:02] CODER    Starting: Overhaul wakeup.ts...
[12:45:15] CODER    Reading src/runners/wakeup.ts
[12:46:30] CODER    Submitting for review
[12:46:35] REVIEWER Starting review
[12:47:20] REVIEWER APPROVED
```

**Output format (--json):**
```json
{"timestamp":"2026-02-08T12:45:02Z","role":"coder","event":"start","task_id":"edff642c","message":"Starting task"}
{"timestamp":"2026-02-08T12:45:15Z","role":"coder","event":"file_read","path":"src/runners/wakeup.ts"}
```

### 3. `steroids report`

Generate summary reports.

```bash
# Today's activity
steroids report

# Specific date range
steroids report --since "2 hours ago"
steroids report --since 2026-02-08 --until 2026-02-09

# Section-focused report
steroids report --section 7c93b3c4

# JSON output
steroids report --json
```

**Output format:**
```
STEROIDS ACTIVITY REPORT
========================
Period: Last 2 hours

Tasks Completed: 5
Tasks Rejected: 2 (1 approved on retry)
Total Rejections: 8

Most Rejected Task:
  - "Overhaul wakeup.ts" - 4 rejections (in progress)

Section Progress:
  Phase 0.4: 5/16 complete (+3 this period)
  Phase 0.5: 0/8 complete

Active Now:
  - Task: Overhaul wakeup.ts
  - Status: in_progress
  - Coder active since: 12:19 PM
```

---

## Log Storage

### Current State
- Audit trail in `task_audit` table (status transitions only)
- No detailed execution logs stored

### Proposed Enhancement

Add `execution_logs` table:

```sql
CREATE TABLE execution_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  role TEXT NOT NULL,  -- 'coder', 'reviewer', 'orchestrator'
  event TEXT NOT NULL, -- 'start', 'file_read', 'file_write', 'command', 'decision', etc.
  message TEXT,
  metadata TEXT,       -- JSON blob for structured data

  INDEX idx_logs_task (task_id),
  INDEX idx_logs_timestamp (timestamp)
);
```

### Log Rotation
- Keep last 7 days by default
- Configurable via `steroids.config.json`:
  ```json
  {
    "logs": {
      "retention_days": 7,
      "max_size_mb": 100
    }
  }
  ```

---

## Real-time Monitoring Architecture

### Option A: File-based (Simple)
- Write logs to `.steroids/logs/current.log`
- `steroids logs tail` uses `fs.watch` + `readline`
- Rotation: `current.log` -> `YYYY-MM-DD.log` at midnight

### Option B: SQLite-based (Structured)
- Write to `execution_logs` table
- `steroids logs tail` polls with `WHERE timestamp > ?`
- Better for filtering, querying, and reporting

### Recommendation: Option B
SQLite provides better querying, filtering, and integration with existing tooling. Polling every 500ms is sufficient for real-time feel.

---

## Integration with Existing Tools

### Watch Command Enhancement
The existing `steroids watch` command should integrate these:

```bash
steroids watch              # Interactive TUI (existing)
steroids watch --simple     # Non-interactive, updates in place
steroids watch --json       # JSON stream for dashboards
```

### Cron/Automation Integration
For headless environments:

```bash
# Run in cron, email if issues
0 * * * * steroids status --json | jq -e '.healthy' || mail -s "Steroids Alert" admin@example.com

# Dashboard integration
steroids status --json | curl -X POST -d @- https://dashboard.example.com/steroids
```

---

## Implementation Priority

1. **Phase 1: `steroids status`** (Non-interactive status)
   - Quick win, no new infrastructure needed
   - Reads existing database state

2. **Phase 2: Execution logs table**
   - Add migration for `execution_logs`
   - Instrument coder/reviewer invocation

3. **Phase 3: `steroids logs tail`**
   - Real-time log following
   - Filtering by task/role

4. **Phase 4: `steroids report`**
   - Summary generation
   - Date range filtering

---

## Related Documentation

This feature relates to:
- Section Task Context (reviewer sees other tasks in section)
- Global Runner Registry (cross-project monitoring)
- Watch Command (interactive monitoring)
