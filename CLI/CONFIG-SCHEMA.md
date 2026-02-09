# Config Schema System

> How the CLI knows what settings exist and how to display them in the TUI browser.

---

## Overview

Steroids uses a **two-file system** for configuration:

| File | Location | Purpose |
|------|----------|---------|
| `config-schema.yaml` | Bundled with CLI | Defines all settings, descriptions, options |
| `config.yaml` | User's `.steroids/` | User's actual values |

The CLI reads both:
1. **Schema** - knows what settings exist, their types, valid options, defaults
2. **User config** - gets actual values

---

## Why Separate Schema?

If metadata lived in user's config.yaml:
- User deletes a section → CLI forgets it exists
- User has typo → CLI doesn't know valid options
- No way to show "default" vs "changed"

With bundled schema:
- CLI always knows full structure
- TUI can show all settings (even unset ones)
- Validation against known options
- Clear defaults

---

## Schema File Structure

```yaml
# config-schema.yaml (bundled with CLI, read-only)

_version: 1
_description: "Steroids Configuration Schema"

output:
  _description: "Output formatting options"
  _category: true

  format:
    _description: "Output format for CLI commands"
    _type: string
    _options: [table, json]
    _default: table

  colors:
    _description: "Enable colored terminal output"
    _type: boolean
    _default: true

  verbose:
    _description: "Show detailed output for debugging"
    _type: boolean
    _default: false

health:
  _description: "Health check settings"
  _category: true

  threshold:
    _description: "Minimum health score (0-100)"
    _type: integer
    _min: 0
    _max: 100
    _default: 70

  checks:
    _description: "Enable/disable specific health checks"
    _category: true

    git:
      _description: "Check git status"
      _type: boolean
      _default: true

    deps:
      _description: "Check dependencies"
      _type: boolean
      _default: true

    tests:
      _description: "Run tests"
      _type: boolean
      _default: true

backup:
  _description: "Backup configuration"
  _category: true

  enabled:
    _description: "Enable automatic backups"
    _type: boolean
    _default: true

  beforePurge:
    _description: "Backup before purge operations"
    _type: boolean
    _default: true

  retentionDays:
    _description: "Days to keep backups"
    _type: integer
    _min: 1
    _default: 30

locking:
  _description: "Task locking settings"
  _category: true

  taskTimeout:
    _description: "Task lock expiry duration"
    _type: duration
    _default: "60m"

  waitTimeout:
    _description: "Max time to wait for lock"
    _type: duration
    _default: "30m"

sections:
  _description: "Section processing settings"
  _category: true

  batchMode:
    _description: "Process all pending tasks in a section as one batch"
    _type: boolean
    _default: false

  maxBatchSize:
    _description: "Maximum tasks to batch together (prevents context overflow)"
    _type: integer
    _min: 1
    _max: 50
    _default: 10

hooks:
  _description: "Event hooks for automation"
  _type: array
  _itemSchema:
    name:
      _description: "Hook identifier"
      _type: string
      _required: true

    event:
      _description: "Event that triggers this hook"
      _type: string
      _options: [task.completed, task.created, section.completed, project.completed, health.critical]
      _required: true

    type:
      _description: "Hook type"
      _type: string
      _options: [script, webhook]
      _required: true

    enabled:
      _description: "Enable/disable hook"
      _type: boolean
      _default: true

    # Script-specific
    command:
      _description: "Command to execute"
      _type: string
      _when: "type == script"

    args:
      _description: "Command arguments"
      _type: array
      _when: "type == script"

    # Webhook-specific
    url:
      _description: "Webhook URL"
      _type: string
      _when: "type == webhook"

    method:
      _description: "HTTP method"
      _type: string
      _options: [GET, POST, PUT, PATCH, DELETE]
      _default: POST
      _when: "type == webhook"
```

---

## User Config File

User's config is simple values only:

```yaml
# .steroids/config.yaml (user's file)

output:
  format: json
  verbose: true

health:
  threshold: 80

backup:
  retentionDays: 14

hooks:
  - name: slack-notify
    event: task.completed
    type: webhook
    url: "https://hooks.slack.com/..."

  - name: deploy
    event: project.completed
    type: script
    command: "./deploy.sh"
```

---

## Schema Metadata Fields

| Field | Purpose |
|-------|---------|
| `_description` | Shown in TUI browser |
| `_type` | Data type: string, boolean, integer, array, duration |
| `_options` | Valid values (for dropdown in TUI) |
| `_default` | Default value |
| `_min` / `_max` | Range for integers |
| `_required` | Must be provided |
| `_category` | This is a grouping, not a value |
| `_when` | Conditional visibility |
| `_itemSchema` | Schema for array items |

---

## TUI Browser Behavior

```
┌─ Config Browser ────────────────────────────────────────────┐
│                                                              │
│  ▸ output          Output formatting options                 │
│    health          Health check settings                     │
│    backup          Backup configuration                      │
│    locking         Task locking settings                     │
│    hooks           Event hooks (2 configured)                │
│                                                              │
│  Source: .steroids/config.yaml                              │
│  [↑↓] Navigate  [Enter] Drill down  [q] Quit                │
└──────────────────────────────────────────────────────────────┘
```

Drill into `output`:

```
┌─ output ────────────────────────────────────────────────────┐
│                                                              │
│  format        json                    (default: table)      │
│                Output format for CLI commands                │
│                                                              │
│  colors        true                    (default)             │
│                Enable colored terminal output                │
│                                                              │
│  verbose       true                    (changed)             │
│                Show detailed output for debugging            │
│                                                              │
│  [↑↓] Navigate  [Enter] Edit  [d] Reset to default  [q] Back│
└──────────────────────────────────────────────────────────────┘
```

---

## Schema Location

The schema is bundled with the CLI installation:

```
/usr/local/lib/steroids/
├── config-schema.yaml      # Main config schema
└── bin/
    └── steroids           # CLI binary
```

Or in Node.js package:
```
node_modules/steroids/
├── dist/
│   └── schemas/
│       └── config-schema.yaml
└── bin/
    └── steroids
```

---

## Validation

CLI validates user config against schema:

```bash
$ steroids config validate
✓ output.format: "json" (valid)
✓ output.verbose: true (valid)
✗ health.threshold: 150 (invalid: max is 100)
✓ hooks[0]: valid webhook hook
```

---

## Related Documentation

- [STORAGE.md](./STORAGE.md) - File locations
- [COMMANDS.md](./COMMANDS.md) - Config commands
- [HOOKS.md](./HOOKS.md) - Hook configuration
