# Storage Specification

> Complete reference for Steroids storage model using SQLite.
> For database schemas, see [SCHEMAS.md](./SCHEMAS.md)

---

## Overview

Steroids uses **SQLite** for all machine-managed state. This provides:

- **Atomic transactions** - no race conditions between concurrent writers
- **Built-in locking** - SQLite handles file locking automatically
- **Single file** - all state in one `.steroids/steroids.db` file
- **SQL queries** - efficient lookups and aggregations
- **Corruption resistant** - WAL mode with automatic recovery

**Design principles:**
- SQLite for machine state, YAML for user config
- All state in `.steroids/` folder
- GUIDs for stable object identification
- Git-friendly (single binary file, can be .gitignored or tracked)
- Users interact via CLI, not by editing database directly

---

## Core Concept: No Project Objects

There is **no "Project" entity** in Steroids. The project is simply the folder containing the `.steroids/` directory. Wherever you run `steroids`, that's your project context.

---

## File Locations

### Project-Level Files

```
your-project/
├── AGENTS.md                  # Project guidelines (optional, for LLMs)
├── dispute.md                 # Dispute log (human-readable summary)
└── .steroids/
    ├── config.yaml            # All settings + hooks (YAML, user-edited)
    ├── steroids.db            # SQLite database (all machine state)
    ├── backup/                # Backups (if enabled)
    └── logs/                  # LLM invocation logs (text files)
        ├── a1b2c3d4-coder-001.log
        ├── a1b2c3d4-reviewer-001.log
        └── ...
```

### Global Files

```
~/.steroids/
├── config.yaml                # Global settings + hooks (inherited by all projects)
└── steroids.db                # Global runner state (SQLite)
```

---

## Format Choices

| Data | Format | Reason |
|------|--------|--------|
| User config | YAML | Human-readable, supports comments |
| Tasks, sections, disputes | SQLite | Concurrent access, transactions |
| Runner state, locks | SQLite | Atomic operations, no race conditions |
| LLM logs | Text files | Large content, append-only |

**Rule:** YAML = user configures, SQLite = machine-managed

---

## Database Schema

### Project Database (`.steroids/steroids.db`)

```sql
-- Schema metadata (version tracking)
CREATE TABLE _schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Populated with: version, created_at, last_migration

-- Applied migrations log
CREATE TABLE _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sections (task groups)
CREATE TABLE sections (
    id TEXT PRIMARY KEY,           -- UUID
    name TEXT NOT NULL,
    position INTEGER NOT NULL,     -- Display order
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,                    -- UUID
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, in_progress, review, completed, disputed, failed
    section_id TEXT REFERENCES sections(id),
    source_file TEXT,                       -- Path to specification
    rejection_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_section ON tasks(section_id);

-- Audit trail (immutable log of status changes)
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,                    -- human:name or model:claude-sonnet-4
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_task ON audit(task_id);

-- Disputes
CREATE TABLE disputes (
    id TEXT PRIMARY KEY,                    -- UUID
    task_id TEXT NOT NULL REFERENCES tasks(id),
    type TEXT NOT NULL,                     -- coder, reviewer, minor, system
    status TEXT NOT NULL DEFAULT 'open',    -- open, resolved
    reason TEXT NOT NULL,
    coder_position TEXT,
    reviewer_position TEXT,
    resolution TEXT,                        -- coder, reviewer, custom
    resolution_notes TEXT,
    created_by TEXT NOT NULL,               -- model name or human:name
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);

CREATE INDEX idx_disputes_task ON disputes(task_id);
CREATE INDEX idx_disputes_status ON disputes(status);

-- Task locks (for orchestrator coordination)
CREATE TABLE task_locks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Section locks (for section-level coordination)
CREATE TABLE section_locks (
    section_id TEXT PRIMARY KEY REFERENCES sections(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
```

### Global Database (`~/.steroids/steroids.db`)

```sql
-- Runners (orchestrator instances)
CREATE TABLE runners (
    id TEXT PRIMARY KEY,                    -- UUID
    status TEXT NOT NULL DEFAULT 'idle',    -- idle, running, completed, failed
    pid INTEGER,
    project_path TEXT,
    current_task_id TEXT,
    started_at TEXT,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Runner locks (singleton enforcement)
CREATE TABLE runner_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- Only one row allowed
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Task Status Enum

| Status | Marker | Description |
|--------|--------|-------------|
| `pending` | `[ ]` | Not started, waiting for coder |
| `in_progress` | `[-]` | Coder actively working |
| `review` | `[o]` | Build AND tests passed, waiting for reviewer |
| `completed` | `[x]` | Reviewer approved, pushed |
| `disputed` | `[!]` | Disagreement logged, treated as done |
| `failed` | `[F]` | Terminal: exceeded 15 rejections, requires human |

**Terminal states:** `completed`, `disputed`, `failed` - loop moves to next task.

**Important:** A task can only reach `review` status if the project builds AND all tests pass. The orchestrator verifies both before accepting the submission.

---

## Concurrency Model

SQLite handles concurrency automatically with WAL (Write-Ahead Logging) mode.

### Initialization

```python
def init_database(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")      # Enable WAL for concurrency
    conn.execute("PRAGMA busy_timeout=5000")     # Wait 5s for locks
    conn.execute("PRAGMA foreign_keys=ON")       # Enforce referential integrity
    return conn
```

### Transactions

All multi-step operations use transactions:

```python
def update_task_status(task_id, new_status, actor, notes=None):
    with conn:  # Auto-commit on success, rollback on error
        # Get current status
        cursor = conn.execute(
            "SELECT status FROM tasks WHERE id = ?", (task_id,)
        )
        old_status = cursor.fetchone()[0]

        # Update task
        conn.execute("""
            UPDATE tasks
            SET status = ?, updated_at = datetime('now')
            WHERE id = ?
        """, (new_status, task_id))

        # Add audit entry
        conn.execute("""
            INSERT INTO audit (task_id, from_status, to_status, actor, notes)
            VALUES (?, ?, ?, ?, ?)
        """, (task_id, old_status, new_status, actor, notes))
```

### Lock Acquisition

Atomic lock acquisition for task claiming:

```python
def acquire_task_lock(task_id, runner_id, timeout_minutes=60):
    expires = datetime.now() + timedelta(minutes=timeout_minutes)

    try:
        with conn:
            # Try to insert lock (fails if exists)
            conn.execute("""
                INSERT INTO task_locks (task_id, runner_id, expires_at)
                VALUES (?, ?, ?)
            """, (task_id, runner_id, expires.isoformat()))
            return True
    except sqlite3.IntegrityError:
        # Lock exists - check if expired
        cursor = conn.execute(
            "SELECT expires_at FROM task_locks WHERE task_id = ?",
            (task_id,)
        )
        row = cursor.fetchone()
        if row and datetime.fromisoformat(row[0]) < datetime.now():
            # Expired - take over
            with conn:
                conn.execute("""
                    UPDATE task_locks
                    SET runner_id = ?, acquired_at = datetime('now'),
                        expires_at = ?, heartbeat_at = datetime('now')
                    WHERE task_id = ?
                """, (runner_id, expires.isoformat(), task_id))
            return True
        return False
```

---

## Task Selection Query

The orchestrator uses this query to find the next task:

```sql
-- Find next task to work on
-- Priority: review > in_progress > pending
-- Order: top to bottom (by section position, then task creation)

SELECT t.id, t.title, t.status, t.section_id
FROM tasks t
LEFT JOIN sections s ON t.section_id = s.id
WHERE t.status NOT IN ('completed', 'disputed', 'failed')
  AND t.id NOT IN (
      SELECT task_id FROM task_locks
      WHERE expires_at > datetime('now')
  )
ORDER BY
    CASE t.status
        WHEN 'review' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'pending' THEN 3
    END,
    COALESCE(s.position, 999999),
    t.created_at
LIMIT 1;
```

---

## Build & Test Configuration

**Every task submission requires passing build AND tests.** The orchestrator verifies both before accepting code for review.

### What "Build Passes" Means

1. **Compile/Build**: Project compiles without errors
2. **Tests Pass**: All tests execute successfully

Both must pass. A task cannot reach `review` status otherwise.

### Config Options

```yaml
# In .steroids/config.yaml
build:
  command: "npm run build"    # Build command to run
  timeout: 600                # Timeout in seconds (default: 10 min)
  required: true              # If false, skip build verification

test:
  command: "npm test"         # Test command to run
  timeout: 600                # Timeout in seconds (default: 10 min)
  required: true              # If false, skip test verification
```

### Auto-Detection

If no commands are configured, the orchestrator auto-detects:

| File Present | Build Command | Test Command |
|--------------|---------------|--------------|
| `package.json` with `build` script | `npm run build` | `npm test` |
| `package.json` without `build` | `npm install` | `npm test` |
| `Cargo.toml` | `cargo build` | `cargo test` |
| `go.mod` | `go build ./...` | `go test ./...` |
| `pyproject.toml` | `pip install -e .` | `pytest` |
| `Makefile` | `make` | `make test` |

If no build/test system is detected and `required` is not set, verification is skipped with a warning.

---

## Configuration Merge Strategy

Configuration is merged from multiple sources with **later sources overriding earlier ones**.

### Priority Order (lowest to highest)

```
1. Built-in defaults          (hardcoded in CLI)
2. ~/.steroids/config.yaml   (user-level)
3. ./.steroids/config.yaml   (project-level)
4. Environment variables      (STEROIDS_*)
5. Command-line flags         (--flag value)
```

### Merge Rules

| Type | Behavior |
|------|----------|
| Scalars | Replace entirely |
| Objects | Deep merge (recursive) |
| Arrays | Replace entirely (no merge) |

### Environment Variable Mapping

Environment variables use `STEROIDS_` prefix with underscore-separated keys:

| Variable | Config Path |
|----------|-------------|
| `STEROIDS_OUTPUT_FORMAT` | `output.format` |
| `STEROIDS_OUTPUT_COLORS` | `output.colors` |
| `STEROIDS_PROJECTS_IGNORED` | `projects.ignored` (comma-separated) |

---

## Audit Trail

Every task status change is recorded in the `audit` table.

### Audit Entry Fields

| Field | Description |
|-------|-------------|
| `task_id` | Task this entry belongs to |
| `from_status` | Previous status (null if new) |
| `to_status` | New status |
| `actor` | Who made the change (`human:name` or `model:claude-sonnet-4`) |
| `notes` | Optional notes (rejection reason, approval notes) |
| `created_at` | When the change happened |

### Viewing Audit Trail

```bash
steroids tasks audit a1b2c3d4-...
```

```
TIMESTAMP            FROM         TO          ACTOR              NOTES
2024-01-15 10:00:00  -            pending     human:john         Created task
2024-01-15 10:30:00  pending      in_progress model:sonnet-4     -
2024-01-15 11:00:00  in_progress  review      model:sonnet-4     -
2024-01-15 11:15:00  review       in_progress model:opus-4       Missing validation
2024-01-15 11:45:00  in_progress  review      model:sonnet-4     -
2024-01-15 12:00:00  review       completed   model:opus-4       LGTM
```

---

## LLM Invocation Logs

Logs are stored as text files (not in SQLite) because they can be large:

### Log File Naming

```
{task_id_prefix}-{role}-{attempt}.log
```

Example: `a1b2c3d4-coder-001.log`

### Log Format

```
=== STEROIDS INVOCATION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Task ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Role: coder
Model: claude-sonnet-4
Duration: 45000ms
Exit Code: 0

=== PROMPT ===
# STEROIDS CODER TASK
...

=== STDOUT ===
I'll implement the authentication feature...
...

=== STDERR ===

=== END ===
```

---

## Purge & Cleanup

### What Gets Purged

| Target | Description |
|--------|-------------|
| Tasks | Completed/disputed/failed tasks removed from database |
| Audit | Entries for purged tasks removed |
| Disputes | Resolved disputes for purged tasks removed |
| LLM Logs | Log files for purged tasks deleted |

### Purge Workflow

```bash
# Preview what will be purged
steroids purge tasks --dry-run

# Archive before purging (exports to markdown)
steroids purge tasks --archive ./archive/sprint-1.md

# Purge completed tasks older than 30 days
steroids purge tasks --older-than 30d

# Keep logs even when purging tasks
steroids purge tasks --older-than 30d --keep-logs
```

### Retention Policy

| Data | Default Retention | Configurable |
|------|-------------------|--------------|
| Completed tasks | Forever (manual purge) | Yes |
| Disputed tasks | Forever (manual purge) | Yes |
| Failed tasks | Forever (manual purge) | Yes |
| LLM invocation logs | Purged with task | Keep with `--keep-logs` |
| Runner logs | 7 days | Yes |

---

## Backup Strategy

### Database Backup

```bash
# Create backup (copies steroids.db)
steroids backup create

# Creates:
# .steroids/backup/2024-01-15T10-30-00/
# ├── steroids.db
# └── config.yaml

# Restore from backup
steroids backup restore .steroids/backup/2024-01-15T10-30-00
```

### Automatic Backup

```yaml
# In config.yaml
backup:
  enabled: true
  beforePurge: true     # Auto-backup before purge
  retentionDays: 30
```

### SQLite Backup Command

For manual backup:

```bash
sqlite3 .steroids/steroids.db ".backup .steroids/backup/steroids-$(date +%Y%m%d).db"
```

---

## Migration from JSON (if applicable)

If upgrading from an older JSON-based version:

```bash
steroids migrate --from-json

# This will:
# 1. Read existing JSON files (if migrating from older version)
# 2. Create steroids.db with proper schema
# 3. Import all data
# 4. Archive old JSON files to .steroids/backup/pre-migration/
```

---

## Database Inspection

For debugging, you can query the database directly:

```bash
# Open database
sqlite3 .steroids/steroids.db

# View all tasks
SELECT id, title, status, rejection_count FROM tasks;

# View audit for a task
SELECT * FROM audit WHERE task_id = 'a1b2c3d4-...' ORDER BY created_at;

# View active locks
SELECT * FROM task_locks WHERE expires_at > datetime('now');

# View open disputes
SELECT * FROM disputes WHERE status = 'open';
```

---

## Related Documentation

- [SCHEMAS.md](./SCHEMAS.md) - Full SQL schemas
- [LOCKING.md](./LOCKING.md) - Lock behavior details
- [HOOKS.md](./HOOKS.md) - Hooks configuration guide
- [AI-PROVIDERS.md](./AI-PROVIDERS.md) - LLM invocation and logging
