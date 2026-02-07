# CLI API Reference

> JSON output schemas, error codes, and environment variables for scripting and LLM integration.
> For command usage, see [COMMANDS.md](./COMMANDS.md)

---

## Storage Model

Steroids uses **file-based storage only** - no database.

| Data | Location | Format |
|------|----------|--------|
| Tasks | `./TODO.md` | Markdown checkboxes |
| Project config | `./.steroids/config.yaml` | YAML |
| Hooks | `./.steroids/hooks.yaml` | YAML |
| Global config | `~/.steroids/config.yaml` | YAML |
| Global hooks | `~/.steroids/hooks.yaml` | YAML |

Task updates write directly back to the markdown file.

---

## JSON Output Schemas

All commands support `--json` for machine-readable output.

### Envelope Structure

```json
{
  "success": true,
  "command": "tasks",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": { ... },
  "warnings": []
}
```

### Error Structure

```json
{
  "success": false,
  "command": "tasks",
  "timestamp": "2024-01-15T10:30:00Z",
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "No task matching 'Fix logn bug' found",
    "suggestion": "Did you mean 'Fix login bug'? Use --search for partial matches.",
    "details": {
      "searched": "Fix logn bug",
      "similar": ["Fix login bug", "Fix logout bug"]
    }
  }
}
```

---

## Command Schemas

### `steroids tasks --json`

```json
{
  "success": true,
  "command": "tasks",
  "data": {
    "tasks": [
      {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "title": "Fix login bug",
        "status": "pending",
        "section": "Backend",
        "sectionId": "c3d4e5f6-a7b8-9012-cdef-123456789012",
        "file": "TODO.md",
        "line": 15,
        "indent": 0
      },
      {
        "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        "title": "Add unit tests",
        "status": "in_progress",
        "section": "Backend",
        "sectionId": "c3d4e5f6-a7b8-9012-cdef-123456789012",
        "file": "TODO.md",
        "line": 16,
        "indent": 2
      }
    ],
    "summary": {
      "total": 24,
      "pending": 18,
      "in_progress": 3,
      "completed": 3,
      "review": 0
    },
    "pagination": {
      "total": 24,
      "limit": 50,
      "offset": 0,
      "hasMore": false
    }
  }
}
```

**Task ID Format:** Random GUID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

**Status Values:** `pending` | `in_progress` | `completed` | `review`

### `steroids tasks update --json`

```json
{
  "success": true,
  "command": "tasks",
  "data": {
    "task": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "title": "Fix login bug",
      "status": "completed",
      "previousStatus": "pending",
      "file": "TODO.md",
      "line": 15,
      "sourceFile": "docs/SPEC.md"
    },
    "fileModified": "TODO.md",
    "hooksTriggered": ["slack-notify", "log-completion"]
  }
}
```

### `steroids scan --json`

```json
{
  "success": true,
  "command": "scan",
  "data": {
    "projects": [
      {
        "name": "my-project",
        "path": "/Users/dev/Projects/my-project",
        "type": "node",
        "hasGit": true,
        "hasTodo": true,
        "taskCount": {
          "pending": 12,
          "in_progress": 2,
          "completed": 8
        },
        "healthScore": 85,
        "lastModified": "2024-01-15T10:00:00Z"
      }
    ],
    "summary": {
      "total": 15,
      "byType": {
        "node": 10,
        "python": 3,
        "go": 2
      },
      "byHealth": {
        "healthy": 12,
        "warning": 2,
        "critical": 1
      }
    }
  }
}
```

**Project Types:** `node` | `python` | `rust` | `go` | `ruby` | `unknown`

### `steroids health --json`

```json
{
  "success": true,
  "command": "health",
  "data": {
    "score": 72,
    "status": "warning",
    "checks": [
      {
        "name": "git",
        "passed": true,
        "score": 100,
        "message": "Clean working tree",
        "suggestion": null
      },
      {
        "name": "deps",
        "passed": true,
        "score": 100,
        "message": "All dependencies up to date"
      },
      {
        "name": "tests",
        "passed": false,
        "score": 40,
        "message": "3 of 5 test suites failing",
        "suggestion": "Run 'npm test' to see failures"
      },
      {
        "name": "todos",
        "passed": true,
        "score": 75,
        "message": "18 of 24 tasks complete (75%)"
      }
    ]
  }
}
```

**Health Status:** `healthy` (≥80) | `warning` (50-79) | `critical` (<50)

### `steroids hooks list --json`

```json
{
  "success": true,
  "command": "hooks",
  "data": {
    "hooks": [
      {
        "name": "slack-notify",
        "event": "task.completed",
        "type": "script",
        "command": "./scripts/notify.sh",
        "async": true,
        "enabled": true
      },
      {
        "name": "deploy-webhook",
        "event": "project.completed",
        "type": "webhook",
        "url": "https://api.example.com/hooks/deploy",
        "method": "POST",
        "enabled": true
      }
    ],
    "sources": [
      ".steroids/hooks.yaml",
      "/Users/dev/.steroids/hooks.yaml"
    ]
  }
}
```

### `steroids hooks test --json`

```json
{
  "success": true,
  "command": "hooks",
  "data": {
    "event": "task.completed",
    "matchedHooks": ["slack-notify", "log-completion"],
    "payload": {
      "task": {
        "id": "TODO.md:15",
        "title": "Fix login bug",
        "status": "completed"
      },
      "project": {
        "name": "my-project",
        "path": "/Users/dev/Projects/my-project"
      },
      "timestamp": "2024-01-15T10:30:00Z"
    },
    "dryRun": true
  }
}
```

---

## Hook Payload Schemas

### `task.completed` / `task.created`

```json
{
  "event": "task.completed",
  "timestamp": "2024-01-15T10:30:00Z",
  "task": {
    "id": "TODO.md:15",
    "title": "Fix login bug",
    "status": "completed",
    "previousStatus": "pending",
    "section": "Backend",
    "file": "TODO.md",
    "line": 15
  },
  "project": {
    "name": "my-project",
    "path": "/Users/dev/Projects/my-project"
  }
}
```

### `section.completed`

```json
{
  "event": "section.completed",
  "timestamp": "2024-01-15T10:30:00Z",
  "section": {
    "name": "Backend",
    "taskCount": 5,
    "file": "TODO.md"
  },
  "tasks": [
    { "id": "TODO.md:10", "title": "Task 1" },
    { "id": "TODO.md:11", "title": "Task 2" }
  ],
  "project": {
    "name": "my-project",
    "path": "/Users/dev/Projects/my-project"
  }
}
```

### `project.completed`

```json
{
  "event": "project.completed",
  "timestamp": "2024-01-15T10:30:00Z",
  "project": {
    "name": "my-project",
    "path": "/Users/dev/Projects/my-project"
  },
  "summary": {
    "totalTasks": 24,
    "files": ["TODO.md"]
  }
}
```

### `health.changed` / `health.critical`

```json
{
  "event": "health.critical",
  "timestamp": "2024-01-15T10:30:00Z",
  "project": {
    "name": "my-project",
    "path": "/Users/dev/Projects/my-project"
  },
  "health": {
    "score": 45,
    "previousScore": 72,
    "status": "critical",
    "failedChecks": ["tests", "lint"]
  },
  "threshold": 50
}
```

---

## Error Codes

| Code | Exit | Description | Suggestion |
|------|------|-------------|------------|
| `GIT_NOT_INSTALLED` | 1 | Git not in PATH | Install Git: https://git-scm.com |
| `GIT_NOT_REPO` | 1 | Not a Git repository | Run `git init` or `steroids init --git-init` |
| `GIT_AUTH_FAILED` | 3 | Git authentication failed | Run `gh auth login` or configure SSH keys |
| `TASK_NOT_FOUND` | 4 | Task title not matched | Check spelling, use `--search` for partial |
| `TASK_AMBIGUOUS` | 2 | Multiple tasks match | Use more specific title or `--file:line` |
| `CONFIG_NOT_FOUND` | 3 | No config file | Run `steroids config init` |
| `CONFIG_INVALID` | 3 | Invalid YAML syntax | Run `steroids config validate` |
| `HOOK_NOT_FOUND` | 4 | Hook name not found | Check `steroids hooks list` |
| `HOOK_FAILED` | 6 | Hook execution failed | Check hook command/URL, see logs |
| `WEBHOOK_TIMEOUT` | 6 | Webhook request timeout | Check URL accessibility |
| `INVALID_ARGUMENT` | 2 | Bad argument value | Check `--help` for valid values |
| `MISSING_ARGUMENT` | 2 | Required arg missing | Provide required argument |
| `PERMISSION_DENIED` | 5 | File not writable | Check file permissions |
| `HEALTH_THRESHOLD` | 7 | Health below threshold | Fix failing checks |

---

## Exit Codes

| Code | Meaning | When |
|------|---------|------|
| 0 | Success | Command completed successfully |
| 1 | General error | Unexpected error occurred |
| 2 | Invalid arguments | Bad flags, missing required args |
| 3 | Configuration error | Config missing or invalid |
| 4 | Not found | Task, project, or hook not found |
| 5 | Permission denied | Can't read/write files |
| 6 | Hook failed | Script or webhook failed |
| 7 | Threshold not met | Health check below `--threshold` |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STEROIDS_CONFIG` | Config file path | `./.steroids/config.yaml` |
| `STEROIDS_NO_COLOR` | Disable colors | `false` |
| `STEROIDS_DEBUG` | Debug output | `false` |
| `STEROIDS_JSON` | Force JSON output | `false` |
| `STEROIDS_NO_HOOKS` | Disable all hooks | `false` |
| `STEROIDS_WEBHOOK_TOKEN` | Token for webhooks | (none) |
| `CI` | CI environment (no prompts) | auto-detected |
| `NO_INTERACTIVE` | Force non-interactive | `false` |
| `EDITOR` | Editor for `config edit` | `vim` |

---

## LLM Integration Patterns

### Task Management Workflow

```bash
# 1. List pending tasks
steroids tasks --json | jq '.data.tasks[] | {id, title}'

# 2. Search for specific task
steroids tasks --search "login" --json

# 3. Mark task complete (triggers hooks)
steroids tasks update "Fix login bug" --status completed --json

# 4. Mark complete without hooks (for automation)
steroids tasks update "Fix login bug" --status completed --no-hooks --json

# 5. Add new task
steroids tasks add "Implement feature X" --section "Backend" --json
```

### Health Check in CI

```bash
# Exit with error if health below 70
steroids health --threshold 70 --quiet
if [ $? -ne 0 ]; then
  steroids health --json | jq '.data.checks[] | select(.passed == false)'
  exit 1
fi
```

### Hook Testing

```bash
# Preview what hooks would run
steroids hooks test task.completed --task "Deploy app" --json

# Run hooks manually
steroids hooks run project.completed --json
```

---

## Related Documentation

- [CLI Commands](./COMMANDS.md) - Full command reference
- [CLI Architecture](./ARCHITECTURE.md) - Architecture, hooks, storage
- [Global Coding Standards](../CLAUDE.md) - Project-wide standards
