# Stuck Task Detection & Recovery System

## Problem Statement

Tasks can become stuck in various failure modes:

1. **Silent coder/reviewer crash** - Process dies after task marked `in_progress`, leaving task orphaned
2. **Hanging invocations** - AI provider API hangs/times out, process waits indefinitely
3. **Zombie runners** - Runner process alive but loop stopped executing
4. **Process death** - Runner process dies but task remains `in_progress`
5. **Database inconsistency** - Task marked `in_progress` but no invocation record exists

These failures are invisible to users until manually checking. They waste time and block progress on sections.

## Solution Overview

Implement a **multi-layered detection and recovery system** that:

1. **Detects** stuck tasks through multiple signals
2. **Diagnoses** the specific failure mode
3. **Recovers** automatically with safety limits
4. **Reports** incidents for analysis
5. **Escalates** to humans after repeated failures

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ DETECTION LAYER (Multiple Signals)                         │
├─────────────────────────────────────────────────────────────┤
│ 1. Heartbeat Monitor - checks runner heartbeats            │
│ 2. Task Duration Monitor - checks task age vs expected     │
│ 3. Invocation Monitor - checks last tool execution         │
│ 4. Process Monitor - checks runner/coder/reviewer alive    │
│ 5. Progress Monitor - checks if work is actually happening │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ DIAGNOSIS LAYER (Root Cause Analysis)                      │
├─────────────────────────────────────────────────────────────┤
│ • Check task state + invocation records                    │
│ • Check runner process alive/dead                          │
│ • Check active coder/reviewer processes                    │
│ • Check daemon log last update time                        │
│ • Identify failure mode from signals                       │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ RECOVERY LAYER (Graduated Response)                        │
├─────────────────────────────────────────────────────────────┤
│ • Attempt 1: Gentle restart (kill stuck process, retry)   │
│ • Attempt 2: Hard reset (kill all, reset task to pending)  │
│ • Attempt 3: Skip task (mark with incident, move to next)  │
│ • Attempt 4: Stop runner (escalate to human)               │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ REPORTING LAYER (Incident Tracking)                        │
├─────────────────────────────────────────────────────────────┤
│ • Log to incidents table (task, failure mode, timestamp)   │
│ • Increment task failure counter                           │
│ • Alert dashboard/monitor                                  │
│ • Generate incident report for analysis                    │
└─────────────────────────────────────────────────────────────┘
```

## Detection Scenarios

### 1. Orphaned Task (Silent Crash)

**Signals:**
- Task status: `in_progress`
- Invocation count: 0 or last invocation completed >X minutes ago
- No active coder/reviewer process for this task
- Runner process may be alive but working on nothing

**Thresholds:**
- Default: 10 minutes since task marked `in_progress` with no invocation
- Configurable: `health.orphanedTaskTimeout` (seconds)

**Example Detection:**
```typescript
interface OrphanedTaskSignal {
  taskId: string;
  status: 'in_progress';
  lastStateChange: Date;
  timeSinceStateChange: number; // seconds
  invocationCount: number;
  lastInvocationCompleted: Date | null;
  hasActiveProcess: boolean;
}

function detectOrphanedTask(task: Task): boolean {
  const timeSinceInProgress = Date.now() - task.startedAt.getTime();
  const threshold = config.health.orphanedTaskTimeout ?? 600; // 10 min default

  return (
    task.status === 'in_progress' &&
    timeSinceInProgress > threshold * 1000 &&
    (task.invocationCount === 0 || lastInvocationStale(task)) &&
    !hasActiveCoderOrReviewer(task.id)
  );
}
```

**Recovery Action:**
1. Kill any lingering processes for this task
2. Reset task to `pending`
3. Log incident: `orphaned_task`
4. Runner will pick it up again on next iteration

### 2. Hanging Invocation

**Signals:**
- Task status: `in_progress`
- Invocation exists with `started_at` but no `completed_at`
- Time since invocation started > expected duration
- Process may still be alive but making no progress

**Thresholds:**
- Default: 30 minutes for coder, 15 minutes for reviewer
- Configurable: `health.maxCoderDuration`, `health.maxReviewerDuration` (seconds)

**Example Detection:**
```typescript
interface HangingInvocationSignal {
  invocationId: string;
  taskId: string;
  phase: 'coder' | 'reviewer';
  startedAt: Date;
  duration: number; // seconds
  lastToolExecution: Date | null;
  processAlive: boolean;
}

function detectHangingInvocation(invocation: Invocation): boolean {
  const duration = Date.now() - invocation.startedAt.getTime();
  const maxDuration = invocation.phase === 'coder'
    ? config.health.maxCoderDuration ?? 1800  // 30 min
    : config.health.maxReviewerDuration ?? 900; // 15 min

  return (
    invocation.completedAt === null &&
    duration > maxDuration * 1000 &&
    (invocation.lastToolExecution === null ||
     isStale(invocation.lastToolExecution, 300)) // 5 min since last tool
  );
}
```

**Recovery Action:**
1. Kill coder/reviewer process (SIGTERM, then SIGKILL)
2. Mark invocation as `failed` with reason: `timeout`
3. Increment task failure counter
4. If failures < 3: reset task to `pending`, retry
5. If failures >= 3: mark task as `skipped`, log incident, move to next task

### 3. Zombie Runner

**Signals:**
- Runner registered in database
- Runner PID exists and process is alive
- Runner heartbeat hasn't updated in >X minutes
- Daemon log hasn't been written to in >X minutes

**Thresholds:**
- Default: 5 minutes since last heartbeat
- Configurable: `health.runnerHeartbeatTimeout` (seconds)

**Example Detection:**
```typescript
interface ZombieRunnerSignal {
  runnerId: string;
  pid: number;
  lastHeartbeat: Date;
  timeSinceHeartbeat: number; // seconds
  processAlive: boolean;
  daemonLogLastModified: Date;
}

function detectZombieRunner(runner: Runner): boolean {
  const timeSinceHeartbeat = Date.now() - runner.lastHeartbeat.getTime();
  const threshold = config.health.runnerHeartbeatTimeout ?? 300; // 5 min

  return (
    runner.status === 'running' &&
    timeSinceHeartbeat > threshold * 1000 &&
    isProcessAlive(runner.pid) &&
    !hasRecentDaemonLogActivity(runner.pid, 300) // 5 min
  );
}
```

**Recovery Action:**
1. Kill runner process (SIGTERM, then SIGKILL after 10s)
2. Mark runner as `stopped`
3. Check for orphaned tasks, reset to `pending`
4. Log incident: `zombie_runner`
5. Auto-restart runner if `autoRestart: true` in config

### 4. Dead Runner (Process Death)

**Signals:**
- Runner registered in database with status `running`
- Runner PID does not exist (process dead)
- May have orphaned tasks in `in_progress`

**Example Detection:**
```typescript
function detectDeadRunner(runner: Runner): boolean {
  return (
    runner.status === 'running' &&
    !isProcessAlive(runner.pid)
  );
}
```

**Recovery Action:**
1. Mark runner as `stopped`
2. Find all tasks with this runner, reset to `pending`
3. Log incident: `dead_runner`
4. Auto-restart runner if `autoRestart: true` in config

### 5. Database Inconsistency

**Signals:**
- Task status: `in_progress`
- No invocations table record (or 0 invocations)
- Task updated_at is recent (not truly stuck, just missing data)

**Example Detection:**
```typescript
function detectDatabaseInconsistency(task: Task): boolean {
  const timeSinceUpdate = Date.now() - task.updatedAt.getTime();

  return (
    task.status === 'in_progress' &&
    task.invocationCount === 0 &&
    timeSinceUpdate < 60000 // Less than 1 minute (recently updated)
  );
}
```

**Recovery Action:**
1. Log warning (not an incident - likely transient)
2. Wait for next health check cycle
3. If persists >5 minutes, treat as orphaned task

## Database Schema

### Incidents Table

```sql
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  runner_id TEXT REFERENCES runners(id),
  failure_mode TEXT NOT NULL, -- 'orphaned_task' | 'hanging_invocation' | 'zombie_runner' | 'dead_runner'
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT, -- 'auto_restart' | 'manual_reset' | 'skipped' | 'escalated'
  details TEXT, -- JSON: {duration, lastHeartbeat, processState, etc.}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_incidents_task ON incidents(task_id);
CREATE INDEX idx_incidents_detected ON incidents(detected_at);
CREATE INDEX idx_incidents_unresolved ON incidents(resolved_at) WHERE resolved_at IS NULL;
```

### Task Failure Counter

```sql
-- Add to tasks table
ALTER TABLE tasks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_failure_at TEXT;

CREATE INDEX idx_tasks_failures ON tasks(failure_count) WHERE failure_count > 0;
```

### Runner Health

```sql
-- Add to runners table
ALTER TABLE runners ADD COLUMN last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE runners ADD COLUMN health_check_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_runners_heartbeat ON runners(last_heartbeat);
```

## Configuration Schema

```yaml
health:
  # Health scoring (steroids health)
  threshold: 80                    # Minimum passing score (0-100)
  checks:
    git: true
    deps: true
    tests: true
    lint: true

  # Stuck-task detection & recovery (steroids health check, steroids runners wakeup)
  # All values below are seconds unless otherwise noted.
  orphanedTaskTimeout: 600          # 10 minutes
  maxCoderDuration: 1800            # 30 minutes
  maxReviewerDuration: 900          # 15 minutes
  runnerHeartbeatTimeout: 300       # 5 minutes
  invocationStaleness: 600          # 10 minutes (task_invocations.created_at based)
  autoRecover: true                 # Attempt safe recovery actions
  maxRecoveryAttempts: 3            # Escalate by skipping task after N failures
  maxIncidentsPerHour: 10           # Safety limit: stop auto-recovery if too many incidents/hour
```

## Health Check Implementation (Current Repo)

The design sections above describe the intended behaviors and signals. The current implementation in this repo is split into:

- Detection-only: `src/health/stuck-task-detector.ts`
- Recovery actions: `src/health/stuck-task-recovery.ts`
- CLI wiring/output: `src/commands/health-stuck.ts` (`steroids health check`, `steroids health incidents`)
- Background automation: `src/runners/wakeup.ts` (`steroids runners wakeup`)

### Important Implementation Notes

1. The current project DB schema does not store explicit "invocation started/completed" timestamps.
   Detection approximates "staleness" using existing timestamps:
   - `tasks.updated_at`
   - `task_invocations.created_at`
   - global runners DB `runners.heartbeat_at`
2. `health.autoRecover` controls whether `steroids health check` / `steroids runners wakeup` will mutate databases (unless `--dry-run` is provided).
3. Safety limit: if `health.maxIncidentsPerHour` is hit, recovery is skipped to avoid flapping; detection still runs and reports signals.

## CLI Commands

### Check Health

```bash
# Run stuck-task health check once (detect + recover if health.autoRecover=true)
steroids health check

# Preview recovery actions without making changes
steroids health check --dry-run

# Output:
# ┌─────────────────────────────────────────────────────────────┐
# │ HEALTH CHECK REPORT                                         │
# ├─────────────────────────────────────────────────────────────┤
# │ Timestamp: 2026-02-10 13:45:00                             │
# │                                                              │
# │ Orphaned Tasks:        0 ✓                                  │
# │ Hanging Invocations:   1 ✗                                  │
# │ Zombie Runners:        0 ✓                                  │
# │ Dead Runners:          0 ✓                                  │
# │                                                              │
# │ Incidents Found: 1                                          │
# │   - hanging_invocation: task-9cefe1b1 (coder, 35min)       │
# │                                                              │
# │ Actions Taken: 1                                            │
# │   - auto_restart: killed hanging coder, reset task pending │
# └─────────────────────────────────────────────────────────────┘

# Run health check in watch mode
steroids health check --watch

# Customize the watch interval (defaults to 5s)
steroids health check --watch --watch-interval 10s

# Machine-readable output (global flag)
steroids health check --json

# View incident history
steroids health incidents

# View incidents for a specific task
steroids health incidents --task 9cefe1b1

# Limit rows
steroids health incidents --limit 200

# Clear resolved incidents (older than 7 days)
steroids health incidents --clear

# Preview incident deletion (global flag)
steroids health incidents --clear --dry-run
```

### Configure Health Checks

```bash
# Enable auto-recovery
steroids config set health.autoRecover true

# Set timeouts
steroids config set health.orphanedTaskTimeout 600  # 10 minutes
steroids config set health.invocationStaleness 600  # 10 minutes
steroids config set health.maxCoderDuration 1800    # 30 minutes
steroids config set health.maxReviewerDuration 900  # 15 minutes

# Escalation behavior
steroids config set health.maxRecoveryAttempts 3

# Safety limit (set to 0 to disable the hourly safety limit)
steroids config set health.maxIncidentsPerHour 10

# Write to global config instead of project config
steroids config set health.autoRecover false --global
```

## Integration with Wakeup

Stuck-task recovery is invoked in two places:

1. Manual on-demand checks: `steroids health check`
2. Background automation via wakeup: `steroids runners wakeup`

To run recovery continuously, schedule wakeups (macOS uses launchd; Linux uses cron):

```bash
steroids runners cron install
steroids runners cron status
steroids runners cron uninstall
```

Note: `steroids runners wakeup` runs stuck-task recovery before it decides whether to restart a runner for a project with pending work.

## Dashboard/Monitor Integration

The health check system should expose data for the Monitor app:

```typescript
// API endpoint: GET /api/health?project=<path>
{
  "success": true,
  "project": "<path>",
  "health": {
    "status": "healthy" | "degraded" | "unhealthy",
    "lastCheck": "2026-02-10T13:45:00Z",
    "checks": [
      {
        "type": "orphaned_tasks",
        "healthy": true,
        "found": 0
      },
      {
        "type": "hanging_invocations",
        "healthy": false,
        "found": 1
      }
    ],
    "activeIncidents": 1,
    "recentIncidents": 3  // last 24 hours
  }
}
```

Incidents are exposed for history views:

```typescript
// API endpoint: GET /api/incidents?project=<path>&limit=<n>&task=<prefix>&unresolved=<true|false>
{
  "success": true,
  "project": "<path>",
  "total": 2,
  "incidents": [
    {
      "id": "i1",
      "task_id": "t1",
      "task_title": "Task title",
      "runner_id": null,
      "failure_mode": "orphaned_task",
      "detected_at": "2026-02-10 13:45:00",
      "resolved_at": null,
      "resolution": null,
      "details": null,
      "created_at": "2026-02-10 13:45:00"
    }
  ]
}
```

## Testing Strategy

### Unit Tests

```typescript
describe('HealthCheckService', () => {
  it('detects orphaned tasks', async () => {
    // Create task marked in_progress 20 minutes ago
    // Assert detectOrphanedTasks() finds it
  });

  it('does not flag tasks with active processes', async () => {
    // Create task with active coder process
    // Assert detectOrphanedTasks() does NOT find it
  });

  it('recovers orphaned task on first failure', async () => {
    // Create orphaned task with failure_count = 0
    // Assert recovery resets to pending
  });

  it('skips task after max failures', async () => {
    // Create orphaned task with failure_count = 3
    // Assert recovery marks as skipped
  });
});
```

### Integration Tests

```typescript
describe('Health Check Integration', () => {
  it('detects and recovers from silent coder crash', async () => {
    // Start task, simulate coder crash
    // Wait for health check to run
    // Assert task is reset to pending
  });

  it('kills hanging invocation and retries', async () => {
    // Start task, simulate hanging API call
    // Wait for timeout threshold
    // Assert process is killed and task reset
  });
});
```

## Migration Guide

```sql
-- 001_add_health_monitoring.sql
BEGIN TRANSACTION;

-- Incidents table
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  runner_id TEXT REFERENCES runners(id),
  failure_mode TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_incidents_task ON incidents(task_id);
CREATE INDEX idx_incidents_detected ON incidents(detected_at);
CREATE INDEX idx_incidents_unresolved ON incidents(resolved_at) WHERE resolved_at IS NULL;

-- Add failure tracking to tasks
ALTER TABLE tasks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_failure_at TEXT;
CREATE INDEX idx_tasks_failures ON tasks(failure_count) WHERE failure_count > 0;

-- Add health tracking to runners
ALTER TABLE runners ADD COLUMN last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE runners ADD COLUMN health_check_failures INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_runners_heartbeat ON runners(last_heartbeat);

-- Add tool execution tracking to invocations
ALTER TABLE invocations ADD COLUMN last_tool_execution TEXT;

COMMIT;
```

## Implementation Checklist

### Phase 1: Core Detection (3-4 hours)
- [ ] Create `src/health/` module
- [ ] Implement `HealthCheckService` class
- [ ] Implement orphaned task detection
- [ ] Implement hanging invocation detection
- [ ] Implement zombie runner detection
- [ ] Implement dead runner detection
- [ ] Add database migration for incidents/health tables
- [ ] Unit tests for detection logic

### Phase 2: Recovery Actions (2-3 hours)
- [ ] Implement process killing utilities
- [ ] Implement orphaned task recovery
- [ ] Implement hanging invocation recovery
- [ ] Implement zombie runner recovery
- [ ] Implement dead runner recovery
- [ ] Add failure count tracking
- [ ] Add safety limits (max incidents per hour)
- [ ] Unit tests for recovery logic

### Phase 3: Health Check Daemon (1-2 hours)
- [ ] Implement `HealthCheckDaemon` class
- [ ] Integrate with orchestrator loop
- [ ] Add configuration loading
- [ ] Add report logging
- [ ] Test daemon in background mode

### Phase 4: CLI Commands (2-3 hours)
- [ ] Implement `steroids health check`
- [ ] Implement `steroids health incidents`
- [ ] Implement `steroids health incidents --clear`
- [ ] Add health check output formatting
- [ ] Test all CLI commands

### Phase 5: API Integration (1-2 hours)
- [ ] Add `/api/health` endpoint
- [ ] Add `/api/incidents` endpoint
- [ ] Test API responses
- [ ] Document API schema

### Phase 6: Testing (2-3 hours)
- [ ] Integration tests for detection
- [ ] Integration tests for recovery
- [ ] Test with all failure modes
- [ ] Test escalation after max failures
- [ ] Test safety limits

### Phase 7: Documentation (1 hour)
- [ ] Update README with health check section
- [ ] Document configuration options
- [ ] Add troubleshooting guide
- [ ] Update architecture docs

**Total Estimated Time: 12-18 hours**

## Future Enhancements

### Smart Failure Analysis
- Pattern detection (same task failing repeatedly)
- Root cause analysis (provider API issues, task complexity)
- Automatic task splitting for complex tasks

### Proactive Prevention
- Predict task duration based on historical data
- Warn when task exceeds expected duration
- Suggest task decomposition for long-running tasks

### Advanced Recovery
- Checkpoint/resume for long-running tasks
- Partial result recovery (save progress before killing)
- Alternative provider fallback (switch to different AI provider on failure)

### Monitoring & Alerting
- Email/Slack notifications on incidents
- Dashboard with health trends
- Weekly health reports
