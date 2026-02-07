# File Storage Specification

> Complete reference for Steroids file-based storage model.
> For JSON schemas, see [SCHEMAS.md](./SCHEMAS.md)

---

## Overview

Steroids uses **file-based storage only** - no database, no lock files.

**Design principles:**
- Structured formats only (JSON/YAML) - no markdown parsing
- All state in `.steroids/` folder
- GUIDs for stable object identification
- Git-friendly (all files work with version control)
- Users interact via CLI, not by editing files directly

---

## Core Concept: No Project Objects

There is **no "Project" entity** in Steroids. The project is simply the folder containing the `.steroids/` directory. Wherever you run `steroids`, that's your project context.

---

## File Locations

### Project-Level Files

```
your-project/
├── AGENTS.md                  # Project guidelines (optional, for LLMs)
├── dispute.md                 # Dispute log (created when coder/reviewer disagree)
└── .steroids/
    ├── config.yaml            # All settings + hooks (YAML with TUI metadata)
    ├── tasks.json             # Tasks and sections (machine-managed)
    ├── disputes.json          # Active disputes (machine-managed)
    └── backup/                # Backups (if enabled)
```

### Global Files

```
~/.steroids/
├── config.yaml                # Global settings + hooks (inherited by all projects)
└── runners/
    ├── state.json             # Runner states (machine-managed)
    ├── lock/                  # Singleton lock
    └── logs/                  # Execution logs
```

---

## Format Choices

| File | Format | Reason |
|------|--------|--------|
| `config.yaml` | YAML | User-configured via TUI, includes hooks |
| `tasks.json` | JSON | Machine-managed, CLI only |
| `state.json` | JSON | Machine-managed |

**Rule:** YAML = user configures via TUI, JSON = machine-managed

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

### Example Merge

```yaml
# ~/.steroids/config.yaml (user-level)
output:
  format: table
  colors: true
  verbose: false
projects:
  ignored: [node_modules, .git]

# ./.steroids/config.yaml (project-level)
output:
  verbose: true    # Override just this key
projects:
  ignored: [dist]  # REPLACES array entirely
```

**Result:**
```yaml
output:
  format: table    # From user-level
  colors: true     # From user-level
  verbose: true    # Overridden by project-level
projects:
  ignored: [dist]  # Array replaced, NOT merged
```

### Environment Variable Mapping

Environment variables use `STEROIDS_` prefix with underscore-separated keys:

| Variable | Config Path |
|----------|-------------|
| `STEROIDS_OUTPUT_FORMAT` | `output.format` |
| `STEROIDS_OUTPUT_COLORS` | `output.colors` |
| `STEROIDS_PROJECTS_IGNORED` | `projects.ignored` (comma-separated) |

---

## Concurrency Model

Steroids uses **task-level locks** to coordinate between runners. See [LOCKING.md](./LOCKING.md) for complete details.

### Key Principles

1. **Always check locks before starting any task** - even after completing another
2. **Locks belong to runners** - only the lock holder can work on a task
3. **Wait for foreign locks** - don't steal locks (unless expired)
4. **Locks auto-expire** - prevents zombie locks from crashed runners

### Write Strategy

1. **Read-Modify-Write**: Read tasks.json, modify in memory, write atomically
2. **Atomic writes**: Write to temp file, then rename (atomic on POSIX)
3. **Lock check in same transaction**: Check + acquire lock in single write

---

## Task Storage (.steroids/tasks.json)

All tasks and sections live in a single JSON file with GUIDs.

### File Structure

```json
{
  "version": 1,
  "sections": [
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "name": "Backend",
      "createdAt": "2024-01-15T10:00:00Z"
    }
  ],
  "tasks": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "title": "Fix login bug",
      "status": "pending",
      "sectionId": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "sourceFile": "docs/SPEC.md#login",
      "createdAt": "2024-01-15T10:30:00Z",
      "audit": []
    }
  ]
}
```

### Why GUIDs?

| Approach | Problem |
|----------|---------|
| Sequential IDs | IDs change on reorder/delete |
| Title-based | Ambiguous if titles match |
| **GUID** | Stable, unique, never changes |

### Task Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier (never changes) |
| `title` | string | Task description |
| `status` | enum | pending, in_progress, review, completed |
| `sectionId` | UUID | Parent section (null if no section) |
| `sourceFile` | string | Link to spec for review |
| `createdAt` | datetime | When task was created |
| `audit` | array | Status change history |

### Section Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier |
| `name` | string | Section name |
| `createdAt` | datetime | When section was created |

---

## Audit Trail

Every task status change is recorded in the task's `audit` array. See [AUDIT.md](./AUDIT.md) for complete details.

**Quick overview:**
- Each status change records: actor (human/model), timestamp, approval status
- Reviewers verify work against `sourceFile` before approving
- Audit entries stored in `.steroids/tasks.json` with each task

```bash
# View audit trail
steroids tasks audit a1b2c3d4-...

# Approve/reject tasks
steroids tasks approve a1b2c3d4-... --model claude-opus-4
steroids tasks reject a1b2c3d4-... --model claude-opus-4 --notes "Missing tests"
```

---

## Config File Format

Config uses a **two-file system**. See [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md) for details.

| File | Purpose |
|------|---------|
| `config-schema.yaml` | Bundled with CLI, defines structure/options/defaults |
| `config.yaml` | User's values only (simple YAML) |

### Project Config (.steroids/config.yaml)

```yaml
# Project-specific configuration
# Overrides global config

output:
  format: json
  verbose: true

health:
  threshold: 80

backup:
  enabled: true
  retentionDays: 14
```

### Global Config (~/.steroids/config.yaml)

```yaml
# Global defaults (inherited by all projects)

output:
  format: table
  colors: true

projects:
  basePath: "~/Projects"
  ignored: [node_modules, .git, dist, build, vendor]

webui:
  port: 3000
  host: localhost
```

The CLI reads the bundled schema to know what settings exist, their types, valid options, and defaults. User configs just store values.

---

## Hooks in Config

Hooks are part of config.yaml (not a separate file). See [HOOKS.md](./HOOKS.md) for complete reference.

### Hooks in config.yaml

```yaml
# In .steroids/config.yaml or ~/.steroids/config.yaml

hooks:
  _description: "Event hooks for automation"

  - name: slack-notify
    event:
      value: task.completed
    type:
      value: webhook
    url:
      value: "https://hooks.slack.com/..."
    enabled:
      value: true

  - name: deploy-script
    event:
      value: project.completed
    type:
      value: script
    command:
      value: "./scripts/deploy.sh"
```

### Hook Inheritance

Global hooks are inherited by all projects:

```
~/.steroids/config.yaml      # Global: slack-notify, logging
    ↓ (inherited)
.steroids/config.yaml        # Project: deploy-script (added)
    ↓ (merged)
Effective hooks: slack-notify, logging, deploy-script
```

To override a global hook, define one with the same name in project config.

---

## File Modification Behavior

### Task Updates

When you run:
```bash
steroids tasks update "Fix login bug" --status completed
```

The CLI:
1. Reads TODO.md into memory
2. Finds the line matching "Fix login bug"
3. Changes `- [ ]` to `- [x]`
4. Writes the entire file atomically
5. Triggers configured hooks

**Before:**
```markdown
## Backend
- [ ] Fix login bug
- [ ] Add tests
```

**After:**
```markdown
## Backend
- [x] Fix login bug
- [ ] Add tests
```

### Task Addition

When you run:
```bash
steroids tasks add "New feature" --section "Backend"
```

The CLI:
1. Reads TODO.md into memory
2. Finds the "## Backend" section
3. Appends task at section end (before next section or EOF)
4. Writes the entire file atomically

### Config Updates

When you run:
```bash
steroids config set output.format json
```

The CLI:
1. Reads .steroids/config.yaml (or creates it)
2. Deep-merges the new value
3. Writes the entire file atomically
4. Preserves comments where possible (best effort)

---

## Purge & Cleanup

Completed tasks can be purged from the system to keep files clean.

### What Gets Purged

| Target | Description |
|--------|-------------|
| Tasks | Completed tasks removed from TODO.md |
| IDs | Orphaned GUIDs removed from ids.json |
| Audit | Optionally kept or removed with tasks |
| Logs | Old runner logs removed |

### Purge Workflow

```bash
# 1. Preview what will be purged
steroids purge tasks --dry-run

# 2. Archive before purging (optional)
steroids purge tasks --archive ./archive/sprint-1.md

# 3. Purge completed tasks older than 30 days
steroids purge tasks --older-than 30d

# 4. Clean up orphaned IDs
steroids purge ids --orphaned
```

### Archive Format

When archiving, purged tasks are written to a markdown file:

```markdown
# Archived Tasks - 2024-01-15

## Backend (5 tasks)

- [x] Fix login bug
  - Completed: 2024-01-10 by claude-sonnet-4
  - Approved: 2024-01-10 by claude-opus-4

- [x] Add authentication
  - Completed: 2024-01-12 by claude-sonnet-4
  - Approved: 2024-01-12 by human:john
```

### Retention Policy

| Data | Default Retention | Configurable |
|------|-------------------|--------------|
| Completed tasks | Forever (manual purge) | Yes |
| Orphaned IDs | 30 days | Yes |
| Runner logs | 7 days | Yes |
| Audit trail | Forever | Keep with `--keep-audit` |

---

## Backup Configuration

Backups can be enabled/disabled in config. **Project config always overrides global config.**

### Config Options

```yaml
# ~/.steroids/config.yaml (global defaults)
backup:
  enabled: true              # Enable backups globally
  beforePurge: true          # Auto-backup before purge
  retentionDays: 30          # Keep backups for 30 days
  path: ~/.steroids/backups # Custom backup location

# .steroids/config.yaml (project override)
backup:
  enabled: false             # Disable backups for this project
```

### Priority Order

1. Project config (`.steroids/config.yaml`) - highest priority
2. Global config (`~/.steroids/config.yaml`)
3. Built-in defaults

### CLI Override

```bash
# Force backup even if disabled in config
steroids purge tasks --backup

# Skip backup even if enabled in config
steroids purge tasks --no-backup
```

---

## Backup Strategy

With backups enabled, Steroids automatically backs up before destructive operations.

```bash
# Before major changes (Git)
git add TODO.md && git commit -m "Checkpoint before batch update"

# Before purge (automatic if backup.beforePurge: true)
steroids purge tasks --older-than 30d
# → Creates backup automatically

# Explicit backup
steroids backup create
```

### Manual Backup

```bash
# Create backup of all state
steroids backup create

# Creates:
# .steroids/backup/2024-01-15T10-30-00/
# ├── TODO.md
# ├── config.yaml
# ├── hooks.yaml
# └── ids.json

# Restore from backup
steroids backup restore .steroids/backup/2024-01-15T10-30-00
```

---

## Related Documentation

- [TODO-FORMAT.md](./TODO-FORMAT.md) - Markdown parsing grammar
- [SCHEMAS.md](./SCHEMAS.md) - JSON/YAML validation schemas
- [HOOKS.md](./HOOKS.md) - Hooks configuration guide
- [API.md](./API.md) - JSON output schemas
