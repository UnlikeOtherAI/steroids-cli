# Runners System

> Coordination layer for managing LLM agents and automated task execution.
> For task management, see [COMMANDS.md](./COMMANDS.md)

---

## Overview

Runners are **global coordinator objects** that manage LLM agents executing tasks. Unlike tasks (which are per-project), runners operate across all projects.

**Key responsibilities:**
- Coordinate LLM agent execution
- Prevent duplicate/overlapping runs
- Wake up stalled workflows
- Track execution state

---

## Core Concepts

### Runner vs Agent

| Concept | Description |
|---------|-------------|
| **Runner** | Global coordinator that manages agents |
| **Agent** | LLM instance executing a specific task |

A runner spawns and monitors agents. When an agent completes or fails, the runner decides what happens next.

### Runner State

```
┌──────────┐      ┌──────────┐      ┌───────────┐
│  idle    │──────│ running  │──────│ completed │
└──────────┘      └──────────┘      └───────────┘
     │                 │
     │                 ▼
     │           ┌───────────┐
     └───────────│  failed   │
                 └───────────┘
```

---

## Global Storage

Runners are stored globally (not per-project) in SQLite:

```
~/.steroids/
├── config.yaml
├── steroids.db              # Global database (runner state, projects)
└── runners/
    └── logs/
        ├── daemon-12345.log  # Log per daemon PID
        └── daemon-67890.log
```

### Runner State (in `~/.steroids/steroids.db`)

```sql
-- Global runners table
CREATE TABLE runners (
    id TEXT PRIMARY KEY,                    -- UUID
    status TEXT NOT NULL DEFAULT 'idle',    -- idle, running, completed, failed
    pid INTEGER,
    project_path TEXT,                      -- Which project this runner works on
    section_id TEXT,                        -- Optional: focused section
    current_task_id TEXT,
    started_at TEXT,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects registry
CREATE TABLE projects (
    path TEXT PRIMARY KEY,
    name TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
);
```

**Per-project isolation:** Each project can have one active runner. Different projects can run in parallel.

**Example runner query:**
```sql
SELECT id, status, project_path, current_task_id,
       datetime(heartbeat_at) as last_heartbeat
FROM runners
WHERE status = 'running';
```

---

## Cron Wake-Up System

A cron job runs every minute to ensure work continues even if an LLM "forgets" to start the next task.

### Cron Setup

```bash
# Install the cron job
steroids runners cron install

# This adds to crontab:
# * * * * * /usr/local/bin/steroids runners wakeup --quiet
```

### Wake-Up Logic

```
┌─────────────────────────────────────────────────────────────┐
│                   Every Minute Cron                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Check for active    │
                   │ runner (lock file)  │
                   └─────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ YES                           │ NO
              ▼                               ▼
    ┌──────────────────┐           ┌──────────────────┐
    │ Check heartbeat  │           │ Any pending      │
    │ (last 5 min?)    │           │ tasks anywhere?  │
    └──────────────────┘           └──────────────────┘
              │                               │
    ┌─────────┴─────────┐          ┌─────────┴─────────┐
    │ STALE      OK     │          │ YES          NO   │
    ▼              ▼               ▼              ▼
┌────────┐    ┌────────┐    ┌────────────┐   ┌────────┐
│ Kill   │    │ Do     │    │ Start new  │   │ Do     │
│ zombie │    │ nothing│    │ runner     │   │ nothing│
│ runner │    └────────┘    └────────────┘   └────────┘
└────────┘
     │
     ▼
┌────────────┐
│ Start new  │
│ runner     │
└────────────┘
```

### Preventing Pile-Up

Safeguards prevent running multiple runners on the same project:

1. **Per-project check**: `hasActiveRunnerForProject()` checks if a runner already exists for that project path
2. **Heartbeat check**: Runners update heartbeat every 30 seconds
3. **Zombie detection**: Runners with stale heartbeats (>5 min) are killed
4. **PID validation**: Check if PID in state is still running

**Note:** Multiple projects can run runners in parallel. Only one runner per project is allowed.

---

## CLI Commands

### List Runners

```bash
steroids runners list

# Output (shows all runners across all projects):
# RUNNERS
# ────────────────────────────────────────────────────────────────────────────────
# ID        STATUS      PID       PROJECT                    SECTION      HEARTBEAT
# ────────────────────────────────────────────────────────────────────────────────
# a47dd5a7  running     61623     /path/to/project-a         Phase 2      17:55:24
# b945449a  running     28681     /path/to/project-b         -            17:44:27
#
# ⚠️  MULTI-PROJECT WARNING: 2 different projects have runners.
#    Your current project: /path/to/project-a
#    DO NOT modify files in other projects.

# JSON output
steroids runners list --json
```

### Start Runner

```bash
# Start runner for current project
steroids runners start

# Start runner for specific project
steroids runners start --project /path/to/project

# Start with specific task
steroids runners start --task a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### Stop Runner

```bash
# Stop runner by ID
steroids runners stop f47ac10b-58cc-4372-a567-0e02b2c3d479

# Stop all runners
steroids runners stop --all

# Force stop (kill -9)
steroids runners stop --force
```

### Wake Up

```bash
# Manual wake-up (what cron calls)
steroids runners wakeup

# Dry run - show what would happen
steroids runners wakeup --dry-run

# Quiet mode (for cron)
steroids runners wakeup --quiet
```

### Cron Management

```bash
# Install cron job
steroids runners cron install

# Uninstall cron job
steroids runners cron uninstall

# Check cron status
steroids runners cron status
```

### Logs

```bash
# View runner logs
steroids runners logs f47ac10b-58cc-4372-a567-0e02b2c3d479

# Follow logs (tail -f)
steroids runners logs f47ac10b-58cc-4372-a567-0e02b2c3d479 --follow

# All recent logs
steroids runners logs --all --limit 100
```

---

## Runner JSON Schema

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [id, status]
properties:
  id:
    type: string
    format: uuid
  status:
    type: string
    enum: [idle, running, completed, failed]
  projectPath:
    type: string
    description: Absolute path to project being worked on
  currentTask:
    type: string
    format: uuid
    description: GUID of task currently being executed
  startedAt:
    type: string
    format: date-time
  completedAt:
    type: string
    format: date-time
  lastHeartbeat:
    type: string
    format: date-time
  pid:
    type: integer
    description: Process ID of runner
  error:
    type: string
    description: Error message if status is failed
```

---

## Integration with Tasks

When a runner picks up a task:

1. **Claim task**: Set task status to `in_progress`
2. **Execute**: Run LLM agent with task context
3. **Complete**: Set task status to `completed` or `review`
4. **Next**: Find next pending task or go idle

### Source File for Review

Each task can have a `sourceFile` linking to the original specification:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "title": "Implement user authentication",
  "sourceFile": "docs/SPEC.md#authentication",
  "status": "review"
}
```

The reviewer uses this link to verify the implementation matches the specification.

---

## Task Locking

**Critical:** Before starting ANY task, runners must check for locks.

### Lock Check Flow

```
1. Runner wants to start task "Fix login"
2. Query task_locks table in steroids.db
3. If lock exists:
   - Is it our lock? → Proceed
   - Is it another runner's lock? → Wait
   - Is it expired? → Take over (atomic UPDATE)
4. Acquire lock with our runner_id (INSERT)
5. Start work on task
6. Release lock when done (DELETE)
```

### Why Always Check?

Even after completing a task in the same section, you must re-check:
- Another runner may have claimed the next task
- Prevents parallel work on same section
- Ensures orderly task progression

### Lock Expiry

Locks auto-expire to handle crashed runners:
- Default: 60 minutes
- Configurable per-runner
- Expired locks can be claimed by any runner

See [LOCKING.md](./LOCKING.md) for complete lock structure and atomic acquisition.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Runner crashes | Locks expire, cron restarts runner |
| Task fails | Mark task as failed, release lock, continue |
| No pending tasks | Runner goes idle, releases all locks |
| Lock held by other | Wait for lock, then proceed |
| Lock expired | Claim lock, continue task |
| Agent timeout | Kill agent, release lock, mark failed |

---

## Configuration

In `~/.steroids/config.yaml`:

```yaml
runners:
  heartbeatInterval: 30s      # How often to update heartbeat
  staleTimeout: 5m            # When to consider runner process dead
  subprocessHangTimeout: 15m  # No log output for 15 min = hung subprocess
  maxConcurrent: 1            # Max concurrent runners (currently always 1)
  logRetention: 7d            # How long to keep logs

  wakeup:
    enabled: true             # Enable cron wake-up
    checkInterval: 1m         # Cron frequency
    projectPaths:             # Directories to scan for pending tasks
      - ~/Projects
```

### Subprocess Hang Detection

LLM subprocesses are monitored by their log output timestamps:
- Every log line includes a timestamp
- If no output for **15 minutes**, subprocess is considered hung
- Hung subprocesses are killed and task retries on next cron cycle

This allows long-running tasks (complex coding, test execution) while catching truly stuck processes.

---

## Related Documentation

- [COMMANDS.md](./COMMANDS.md) - Task commands
- [STORAGE.md](./STORAGE.md) - File storage specification
- [HOOKS.md](./HOOKS.md) - Hooks triggered on task completion
