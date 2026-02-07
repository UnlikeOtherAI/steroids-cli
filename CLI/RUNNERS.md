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

Runners are stored globally (not per-project):

```
~/.steroids/
├── config.yaml
├── hooks.yaml
└── runners/
    ├── state.json           # Current runner states
    ├── lock                  # Singleton lock file
    └── logs/
        ├── runner-001.log
        └── runner-002.log
```

### State File (~/.steroids/runners/state.json)

```json
{
  "version": 1,
  "runners": {
    "f47ac10b-58cc-4372-a567-0e02b2c3d479": {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "status": "running",
      "projectPath": "/Users/dev/my-project",
      "currentTask": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "startedAt": "2024-01-15T10:30:00Z",
      "lastHeartbeat": "2024-01-15T10:35:00Z",
      "pid": 12345
    }
  },
  "lastWakeup": "2024-01-15T10:35:00Z"
}
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

Multiple safeguards prevent running multiple coordinators:

1. **Lock file**: Only one runner can hold `~/.steroids/runners/lock`
2. **Heartbeat check**: Runners update heartbeat every 30 seconds
3. **Zombie detection**: Runners with stale heartbeats (>5 min) are killed
4. **PID validation**: Check if PID in state is still running

```bash
# Lock acquisition (atomic)
if ! mkdir ~/.steroids/runners/lock 2>/dev/null; then
  # Lock exists - check if holder is alive
  PID=$(cat ~/.steroids/runners/lock/pid)
  if kill -0 $PID 2>/dev/null; then
    # Runner still alive
    exit 0
  else
    # Zombie - clean up and proceed
    rm -rf ~/.steroids/runners/lock
    mkdir ~/.steroids/runners/lock
  fi
fi
echo $$ > ~/.steroids/runners/lock/pid
```

---

## CLI Commands

### List Runners

```bash
steroids runners list

# Output:
# ID                                    STATUS    PROJECT              TASK         STARTED
# f47ac10b-58cc-4372-a567-0e02b2c3d479  running   my-project           Fix login    5m ago
# a1b2c3d4-e5f6-7890-abcd-ef1234567890  idle      -                    -            -

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
2. Check task.lock in tasks.json
3. If lock exists:
   - Is it our lock? → Proceed
   - Is it another runner's lock? → Wait
   - Is it expired? → Take over
4. Acquire lock with our runnerId
5. Start work on task
6. Release lock when done
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

See [STORAGE.md](./STORAGE.md) for complete lock structure.

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
  staleTimeout: 5m            # When to consider runner dead
  agentTimeout: 30m           # Max time for single task
  maxConcurrent: 1            # Max concurrent runners (currently always 1)
  logRetention: 7d            # How long to keep logs

  wakeup:
    enabled: true             # Enable cron wake-up
    checkInterval: 1m         # Cron frequency
    projectPaths:             # Directories to scan for pending tasks
      - ~/Projects
```

---

## Related Documentation

- [COMMANDS.md](./COMMANDS.md) - Task commands
- [STORAGE.md](./STORAGE.md) - File storage specification
- [HOOKS.md](./HOOKS.md) - Hooks triggered on task completion
