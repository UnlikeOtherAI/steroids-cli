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
  # Detection thresholds (seconds)
  orphanedTaskTimeout: 600          # 10 minutes
  maxCoderDuration: 1800            # 30 minutes
  maxReviewerDuration: 900          # 15 minutes
  runnerHeartbeatTimeout: 300       # 5 minutes
  toolExecutionStaleness: 300       # 5 minutes

  # Health check intervals
  checkInterval: 60                 # Check every 60 seconds
  runInBackground: true             # Run health checks in background

  # Recovery behavior
  autoRecover: true                 # Automatically attempt recovery
  maxRecoveryAttempts: 3            # Max retries before escalation
  autoRestartRunners: true          # Auto-restart dead/zombie runners

  # Escalation
  escalateAfterFailures: 3          # Escalate task after 3 failures
  notifyOnIncident: false           # Send notifications (future: email/slack)

  # Safety limits
  maxIncidentsPerHour: 10           # Stop auto-recovery if too many incidents
  pauseOnRepeatedFailures: true     # Pause runner if same task fails 3x
```

## Health Check Implementation

### 1. Health Check Service

```typescript
// src/health/health-check.ts

export class HealthCheckService {
  constructor(
    private readonly db: Database,
    private readonly config: SteroidsConfig
  ) {}

  async runHealthCheck(): Promise<HealthCheckReport> {
    const report: HealthCheckReport = {
      timestamp: new Date(),
      checks: [],
      incidents: [],
      actions: [],
    };

    // Check 1: Orphaned tasks
    const orphanedTasks = await this.detectOrphanedTasks();
    report.checks.push({
      type: 'orphaned_tasks',
      found: orphanedTasks.length,
      healthy: orphanedTasks.length === 0,
    });

    for (const task of orphanedTasks) {
      const action = await this.recoverOrphanedTask(task);
      report.incidents.push(this.createIncident(task, 'orphaned_task'));
      report.actions.push(action);
    }

    // Check 2: Hanging invocations
    const hangingInvocations = await this.detectHangingInvocations();
    report.checks.push({
      type: 'hanging_invocations',
      found: hangingInvocations.length,
      healthy: hangingInvocations.length === 0,
    });

    for (const invocation of hangingInvocations) {
      const action = await this.recoverHangingInvocation(invocation);
      report.incidents.push(this.createIncident(invocation, 'hanging_invocation'));
      report.actions.push(action);
    }

    // Check 3: Zombie runners
    const zombieRunners = await this.detectZombieRunners();
    report.checks.push({
      type: 'zombie_runners',
      found: zombieRunners.length,
      healthy: zombieRunners.length === 0,
    });

    for (const runner of zombieRunners) {
      const action = await this.recoverZombieRunner(runner);
      report.incidents.push(this.createIncident(runner, 'zombie_runner'));
      report.actions.push(action);
    }

    // Check 4: Dead runners
    const deadRunners = await this.detectDeadRunners();
    report.checks.push({
      type: 'dead_runners',
      found: deadRunners.length,
      healthy: deadRunners.length === 0,
    });

    for (const runner of deadRunners) {
      const action = await this.recoverDeadRunner(runner);
      report.incidents.push(this.createIncident(runner, 'dead_runner'));
      report.actions.push(action);
    }

    return report;
  }

  private async detectOrphanedTasks(): Promise<OrphanedTaskSignal[]> {
    const threshold = this.config.health?.orphanedTaskTimeout ?? 600;
    const cutoff = new Date(Date.now() - threshold * 1000).toISOString();

    const tasks = this.db.prepare(`
      SELECT
        t.id,
        t.title,
        t.status,
        t.started_at,
        t.updated_at,
        COUNT(i.id) as invocation_count,
        MAX(i.completed_at) as last_invocation_completed
      FROM tasks t
      LEFT JOIN invocations i ON i.task_id = t.id
      WHERE t.status = 'in_progress'
        AND t.started_at < ?
      GROUP BY t.id
    `).all(cutoff);

    const orphaned: OrphanedTaskSignal[] = [];

    for (const task of tasks) {
      // Check if there's an active coder/reviewer process
      const hasActiveProcess = await this.hasActiveProcess(task.id);

      if (!hasActiveProcess &&
          (task.invocation_count === 0 ||
           this.isInvocationStale(task.last_invocation_completed))) {
        orphaned.push({
          taskId: task.id,
          title: task.title,
          status: task.status,
          startedAt: new Date(task.started_at),
          invocationCount: task.invocation_count,
          lastInvocationCompleted: task.last_invocation_completed ?
            new Date(task.last_invocation_completed) : null,
          hasActiveProcess: false,
        });
      }
    }

    return orphaned;
  }

  private async recoverOrphanedTask(signal: OrphanedTaskSignal): Promise<RecoveryAction> {
    // Check failure count
    const task = getTaskById(this.db, signal.taskId);
    const failureCount = task.failure_count ?? 0;
    const maxAttempts = this.config.health?.maxRecoveryAttempts ?? 3;

    if (failureCount >= maxAttempts) {
      // Escalate: skip task, notify human
      updateTask(this.db, signal.taskId, {
        status: 'skipped',
        updated_at: new Date().toISOString(),
        actor: 'system:health-check',
      });

      return {
        type: 'escalate',
        taskId: signal.taskId,
        reason: `Task failed ${failureCount} times, skipping`,
        timestamp: new Date(),
      };
    }

    // Attempt recovery
    try {
      // Kill any lingering processes
      await this.killProcessesForTask(signal.taskId);

      // Reset task to pending
      updateTask(this.db, signal.taskId, {
        status: 'pending',
        started_at: null,
        updated_at: new Date().toISOString(),
        failure_count: failureCount + 1,
        last_failure_at: new Date().toISOString(),
        actor: 'system:health-check',
      });

      return {
        type: 'auto_restart',
        taskId: signal.taskId,
        reason: 'Orphaned task recovered, reset to pending',
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        type: 'failed',
        taskId: signal.taskId,
        reason: `Recovery failed: ${error.message}`,
        timestamp: new Date(),
      };
    }
  }

  private async detectHangingInvocations(): Promise<HangingInvocationSignal[]> {
    const coderTimeout = this.config.health?.maxCoderDuration ?? 1800;
    const reviewerTimeout = this.config.health?.maxReviewerDuration ?? 900;

    const invocations = this.db.prepare(`
      SELECT
        i.id,
        i.task_id,
        i.phase,
        i.started_at,
        i.completed_at,
        i.last_tool_execution
      FROM invocations i
      WHERE i.completed_at IS NULL
        AND i.started_at IS NOT NULL
    `).all();

    const hanging: HangingInvocationSignal[] = [];

    for (const inv of invocations) {
      const duration = Date.now() - new Date(inv.started_at).getTime();
      const maxDuration = inv.phase === 'coder' ? coderTimeout : reviewerTimeout;

      if (duration > maxDuration * 1000) {
        const processAlive = await this.isInvocationProcessAlive(inv.id);
        const lastToolStale = inv.last_tool_execution ?
          this.isToolExecutionStale(inv.last_tool_execution) : true;

        if (lastToolStale) {
          hanging.push({
            invocationId: inv.id,
            taskId: inv.task_id,
            phase: inv.phase,
            startedAt: new Date(inv.started_at),
            duration: Math.floor(duration / 1000),
            lastToolExecution: inv.last_tool_execution ?
              new Date(inv.last_tool_execution) : null,
            processAlive,
          });
        }
      }
    }

    return hanging;
  }

  private async recoverHangingInvocation(signal: HangingInvocationSignal): Promise<RecoveryAction> {
    try {
      // Kill the hanging process
      await this.killInvocationProcess(signal.invocationId);

      // Mark invocation as failed
      this.db.prepare(`
        UPDATE invocations
        SET completed_at = ?,
            status = 'failed',
            error = ?
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        `Timeout after ${signal.duration}s`,
        signal.invocationId
      );

      // Check task failure count
      const task = getTaskById(this.db, signal.taskId);
      const failureCount = (task.failure_count ?? 0) + 1;
      const maxAttempts = this.config.health?.maxRecoveryAttempts ?? 3;

      if (failureCount >= maxAttempts) {
        // Skip task
        updateTask(this.db, signal.taskId, {
          status: 'skipped',
          failure_count: failureCount,
          last_failure_at: new Date().toISOString(),
          actor: 'system:health-check',
        });

        return {
          type: 'escalate',
          taskId: signal.taskId,
          reason: `Task exceeded timeout ${failureCount} times, skipping`,
          timestamp: new Date(),
        };
      }

      // Reset to pending
      updateTask(this.db, signal.taskId, {
        status: 'pending',
        started_at: null,
        failure_count: failureCount,
        last_failure_at: new Date().toISOString(),
        actor: 'system:health-check',
      });

      return {
        type: 'auto_restart',
        taskId: signal.taskId,
        reason: `Hanging ${signal.phase} killed, task reset`,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        type: 'failed',
        taskId: signal.taskId,
        reason: `Recovery failed: ${error.message}`,
        timestamp: new Date(),
      };
    }
  }

  // Helper methods
  private async hasActiveProcess(taskId: string): Promise<boolean> {
    // Check for claude/codex/gemini processes with this task ID in command line
    // Implementation depends on platform (ps + grep on Unix)
    return false; // Placeholder
  }

  private isInvocationStale(lastCompleted: string | null): boolean {
    if (!lastCompleted) return true;
    const threshold = this.config.health?.toolExecutionStaleness ?? 300;
    const elapsed = Date.now() - new Date(lastCompleted).getTime();
    return elapsed > threshold * 1000;
  }

  private async killProcessesForTask(taskId: string): Promise<void> {
    // Find and kill processes related to this task
    // Implementation: ps aux | grep taskId | kill
  }

  private async killInvocationProcess(invocationId: string): Promise<void> {
    // Kill specific invocation process
  }
}
```

### 2. Health Check Daemon

```typescript
// src/health/daemon.ts

export class HealthCheckDaemon {
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly service: HealthCheckService,
    private readonly config: SteroidsConfig
  ) {}

  start(): void {
    if (this.running) {
      throw new Error('Health check daemon already running');
    }

    const interval = (this.config.health?.checkInterval ?? 60) * 1000;

    this.running = true;
    this.intervalId = setInterval(async () => {
      try {
        const report = await this.service.runHealthCheck();
        this.logReport(report);
      } catch (error) {
        console.error('Health check failed:', error);
      }
    }, interval);

    console.log(`Health check daemon started (interval: ${interval}ms)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
  }

  private logReport(report: HealthCheckReport): void {
    if (report.incidents.length > 0) {
      console.warn(`⚠️  Health check found ${report.incidents.length} incident(s):`);
      for (const incident of report.incidents) {
        console.warn(`   - ${incident.failure_mode}: ${incident.task_id}`);
      }
      console.warn(`   Actions taken: ${report.actions.length}`);
    }
  }
}
```

## CLI Commands

### Check Health

```bash
# Run health check once
steroids health check

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

# View incident history
steroids health incidents

# View incidents for a specific task
steroids health incidents --task 9cefe1b1

# Clear resolved incidents (older than 7 days)
steroids health incidents --clear
```

### Configure Health Checks

```bash
# Enable auto-recovery
steroids config set health.autoRecover true

# Set timeouts
steroids config set health.orphanedTaskTimeout 600  # 10 minutes
steroids config set health.maxCoderDuration 1800    # 30 minutes

# Set check interval
steroids config set health.checkInterval 60  # Check every 60 seconds

# Disable auto-restart
steroids config set health.autoRestartRunners false
```

## Integration with Orchestrator Loop

The orchestrator loop should include health checks:

```typescript
// src/commands/loop.ts

async function runLoop() {
  const healthCheck = new HealthCheckService(db, config);

  while (true) {
    // Run health check every N iterations
    if (iteration % 10 === 0) {
      const report = await healthCheck.runHealthCheck();
      if (report.incidents.length > 0) {
        logWarning(`Health check found ${report.incidents.length} incidents`);
        // Actions already taken by health check service
      }
    }

    // Continue with normal loop logic
    const task = getNextPendingTask(db);
    if (!task) {
      await sleep(30000);
      continue;
    }

    await executeTask(task);
  }
}
```

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
