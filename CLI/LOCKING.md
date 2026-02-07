# Task Locking System

> Coordination mechanism for multi-runner task execution.
> For runner details, see [RUNNERS.md](./RUNNERS.md)

---

## Overview

Task locking prevents multiple runners from working on the same task simultaneously. This ensures orderly task progression and prevents conflicts.

**Critical rule:** Before starting ANY task, always check for locks - even if you just finished another task in the same section.

---

## Lock Flow

```
┌─────────────────────────────────────────────────────────────┐
│                   Before Starting Task                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Check task lock     │
                   └─────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ LOCKED                        │ UNLOCKED
              │ (by another runner)           │
              ▼                               ▼
    ┌──────────────────┐           ┌──────────────────┐
    │ Wait for lock    │           │ Acquire lock     │
    │ to be released   │           │ (set runnerId)   │
    └──────────────────┘           └──────────────────┘
              │                               │
              │ (lock released)               ▼
              └─────────────────────► ┌──────────────────┐
                                      │ Start task work  │
                                      └──────────────────┘
                                              │
                                              ▼
                                      ┌──────────────────┐
                                      │ Complete task    │
                                      └──────────────────┘
                                              │
                                              ▼
                                      ┌──────────────────┐
                                      │ Release lock     │
                                      └──────────────────┘
```

---

## Lock Structure

### Task Lock (in SQLite: `.steroids/steroids.db`)

```sql
-- Task locks table
CREATE TABLE task_locks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Example query to check lock
SELECT * FROM task_locks WHERE task_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
```

**Example lock record:**
```
task_id:      a1b2c3d4-e5f6-7890-abcd-ef1234567890
runner_id:    f47ac10b-58cc-4372-a567-0e02b2c3d479
acquired_at:  2024-01-15T10:30:00
expires_at:   2024-01-15T11:30:00
heartbeat_at: 2024-01-15T10:35:00
```

### Section Lock (in SQLite)

```sql
-- Section locks table
CREATE TABLE section_locks (
    section_id TEXT PRIMARY KEY REFERENCES sections(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
```

---

## Lock Fields

| Field | Type | Description |
|-------|------|-------------|
| `runnerId` | UUID | Runner that holds the lock |
| `acquiredAt` | datetime | When lock was acquired |
| `expiresAt` | datetime | Auto-expire time (prevents zombie locks) |

---

## Lock Rules

1. **Always check before starting**
   - Even after completing a previous task
   - Even within the same section
   - No assumptions about lock state

2. **Lock belongs to runner**
   - Only the runner holding the lock can work on it
   - Other runners must wait

3. **Wait for foreign locks**
   - If lock exists from another runner, wait
   - Don't steal locks (unless expired)

4. **Locks auto-expire**
   - Default: 60 minutes
   - Prevents zombie locks from crashed runners
   - Expired locks can be claimed

5. **Release on completion**
   - Remove lock when task finishes (any status)
   - Includes: completed, review, failed

---

## Lock Scenarios

### Scenario: Two Runners, Same Section

```
[Runner A] Starting "Task 1" in Backend section
[Runner A] Acquired lock on Task 1
[Runner A] Working on Task 1...

[Runner B] Wants to start "Task 2" in Backend section
[Runner B] Task 2 has no lock, but checking section...
[Runner B] Section Backend is locked by Runner A
[Runner B] Waiting for section lock...

[Runner A] Completed Task 1
[Runner A] Released task lock
[Runner A] Checking for next task in Backend...
[Runner A] Found Task 2, acquiring lock...

[Runner B] Section still locked (Runner A got Task 2)
[Runner B] Waiting...

[Runner A] Completed Task 2
[Runner A] Released task lock
[Runner A] No more tasks in Backend, releasing section lock

[Runner B] Section lock released!
[Runner B] Looking for tasks... none pending
[Runner B] Going idle
```

### Scenario: Lock Expired

```
[Runner A] Started Task 1 at 10:00
[Runner A] Crashed at 10:15 (lock expires at 11:00)

[Runner B] Checking Task 1 at 11:05
[Runner B] Lock exists but expired (11:00 < now)
[Runner B] Claiming expired lock
[Runner B] Resuming/restarting Task 1
```

---

## Lock Wait Behavior

### Interactive Mode

```bash
$ steroids tasks update "Fix bug" --status in_progress
Task "Fix bug" is locked by another runner.
Waiting for lock... (Ctrl+C to cancel)
[=====>                    ] 45s elapsed
Lock released!
Task "Fix bug" status updated to in_progress.
```

### Non-Interactive Mode

```bash
$ steroids tasks update "Fix bug" --status in_progress --no-wait
Error: Task "Fix bug" is locked by runner f47ac10b-...
Lock expires at: 2024-01-15T11:30:00Z
Exit code: 6 (LOCKED)
```

### JSON Output

```json
{
  "success": false,
  "command": "tasks",
  "error": {
    "code": "TASK_LOCKED",
    "message": "Task is locked by another runner",
    "details": {
      "taskId": "a1b2c3d4-...",
      "lockedBy": "f47ac10b-...",
      "expiresAt": "2024-01-15T11:30:00Z"
    }
  }
}
```

---

## Configuration

In `~/.steroids/config.yaml`:

```yaml
locking:
  _description: "Task locking settings"

  taskTimeout:
    _description: "Default task lock expiry"
    _default: "60m"
    value: "60m"

  sectionTimeout:
    _description: "Default section lock expiry"
    _default: "120m"
    value: "120m"

  waitTimeout:
    _description: "Max time to wait for lock"
    _default: "30m"
    value: "30m"

  pollInterval:
    _description: "How often to check for lock release"
    _default: "5s"
    value: "5s"
```

---

## CLI Commands

```bash
# View current locks
steroids locks list

# View locks for specific task
steroids locks show a1b2c3d4-...

# Force release a lock (admin only)
steroids locks release a1b2c3d4-... --force

# Release all expired locks
steroids locks cleanup
```

---

## Atomic Lock Acquisition

SQLite transactions ensure atomic lock acquisition:

```python
def acquire_task_lock(task_id, runner_id, timeout_minutes=60):
    expires = datetime.now() + timedelta(minutes=timeout_minutes)

    try:
        with conn:
            # Try to insert lock (fails if exists due to PRIMARY KEY)
            conn.execute("""
                INSERT INTO task_locks (task_id, runner_id, expires_at)
                VALUES (?, ?, ?)
            """, (task_id, runner_id, expires.isoformat()))
            return True
    except sqlite3.IntegrityError:
        # Lock exists - check if expired
        cursor = conn.execute(
            "SELECT expires_at, runner_id FROM task_locks WHERE task_id = ?",
            (task_id,)
        )
        row = cursor.fetchone()
        if row:
            if row[1] == runner_id:
                return True  # We already hold the lock
            if datetime.fromisoformat(row[0]) < datetime.now():
                # Expired - take over atomically
                with conn:
                    conn.execute("""
                        UPDATE task_locks
                        SET runner_id = ?, acquired_at = datetime('now'),
                            expires_at = ?, heartbeat_at = datetime('now')
                        WHERE task_id = ? AND expires_at < datetime('now')
                    """, (runner_id, expires.isoformat(), task_id))
                    return conn.total_changes > 0
        return False

def release_task_lock(task_id, runner_id):
    with conn:
        conn.execute("""
            DELETE FROM task_locks
            WHERE task_id = ? AND runner_id = ?
        """, (task_id, runner_id))
```

---

## Schema

```sql
-- Task locks (project database)
CREATE TABLE task_locks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Section locks (project database)
CREATE TABLE section_locks (
    section_id TEXT PRIMARY KEY REFERENCES sections(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
```

---

## Related Documentation

- [RUNNERS.md](./RUNNERS.md) - Runner coordination
- [STORAGE.md](./STORAGE.md) - Database schema and storage
- [COMMANDS-ADVANCED.md](./COMMANDS-ADVANCED.md) - Lock commands
