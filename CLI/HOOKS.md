# Hooks Configuration

> Hooks are configured in config.yaml (not a separate file).
> For config browsing, see [COMMANDS.md](./COMMANDS.md)

---

## Overview

Hooks trigger scripts or webhooks when events occur. They're configured in the `hooks` section of your config.yaml.

**Two types:**
- **Script hooks** - Run local commands
- **Webhook hooks** - Send HTTP requests

**Inheritance:**
- **Global hooks** (`~/.steroids/config.yaml`) - inherited by ALL projects
- **Project hooks** (`.steroids/config.yaml`) - add to or override global hooks

A project gets: global hooks + project hooks (merged by name, project wins on conflict)

---

## Configuration

### In config.yaml

```yaml
hooks:
  _description: "Event hooks for automation"

  - name: slack-notify
    _description: "Notify Slack when tasks complete"

    event:
      _description: "Event that triggers this hook"
      _options: [task.completed, task.created, section.completed, project.completed, health.critical]
      value: task.completed

    type:
      _description: "Hook type"
      _options: [script, webhook]
      value: webhook

    url:
      _description: "Webhook URL"
      value: "https://hooks.slack.com/services/XXX/YYY/ZZZ"

    method:
      _description: "HTTP method"
      _options: [GET, POST, PUT]
      _default: POST
      value: POST

    enabled:
      _description: "Enable/disable this hook"
      _options: [true, false]
      _default: true
      value: true

  - name: deploy-script
    _description: "Run deploy script on project completion"

    event:
      value: project.completed

    type:
      value: script

    command:
      _description: "Command to execute"
      value: "./scripts/deploy.sh"

    args:
      _description: "Command arguments (supports templates)"
      value: ["--env", "staging"]

    async:
      _description: "Run without blocking CLI"
      _options: [true, false]
      _default: false
      value: true
```

---

## Hook Events

| Event | Trigger |
|-------|---------|
| `task.completed` | Task marked complete |
| `task.created` | New task added |
| `section.completed` | All tasks in section done |
| `project.completed` | All tasks in project done |
| `health.critical` | Health drops below threshold |

---

## Template Variables

Use `{{variable}}` in args, url, body, and headers:

### Task Variables

| Variable | Example |
|----------|---------|
| `{{task.id}}` | `a1b2c3d4-e5f6-...` |
| `{{task.title}}` | `Fix login bug` |
| `{{task.status}}` | `completed` |
| `{{task.section}}` | `Backend` |

### Project Variables

| Variable | Example |
|----------|---------|
| `{{project.name}}` | `my-project` |
| `{{project.path}}` | `/Users/dev/my-project` |

### Meta Variables

| Variable | Example |
|----------|---------|
| `{{event}}` | `task.completed` |
| `{{timestamp}}` | `2024-01-15T10:30:00Z` |

---

## Script Hook Options

```yaml
- name: my-script
  type:
    value: script
  command:
    _description: "Command to execute"
    value: "./scripts/notify.sh"
  args:
    _description: "Arguments (supports templates)"
    value: ["{{task.title}}"]
  cwd:
    _description: "Working directory"
    _default: "project root"
    value: "{{project.path}}"
  timeout:
    _description: "Max execution time"
    _default: "60s"
    value: "60s"
  async:
    _description: "Don't block CLI"
    _default: false
    value: true
```

---

## Webhook Hook Options

```yaml
- name: my-webhook
  type:
    value: webhook
  url:
    _description: "Endpoint URL"
    value: "https://api.example.com/hook"
  method:
    _options: [GET, POST, PUT, PATCH, DELETE]
    _default: POST
    value: POST
  headers:
    _description: "HTTP headers"
    value:
      Content-Type: "application/json"
      Authorization: "Bearer ${WEBHOOK_TOKEN}"
  body:
    _description: "JSON body (POST/PUT only)"
    value:
      event: "{{event}}"
      task: "{{task.title}}"
  timeout:
    _default: "30s"
    value: "30s"
  retry:
    _description: "Retry count on failure"
    _default: 0
    value: 3
```

---

## Environment Variables

Reference env vars with `${VAR_NAME}`:

```yaml
- name: secure-webhook
  url:
    value: "https://api.example.com/hooks"
  headers:
    value:
      Authorization: "Bearer ${STEROIDS_WEBHOOK_TOKEN}"
```

---

## CLI Commands

```bash
# Browse hooks in TUI
steroids config browse
# Navigate to: hooks → [select hook] → [edit]

# List hooks
steroids hooks list

# Test hook without executing
steroids hooks test task.completed --task "Fix bug"

# Run hook manually
steroids hooks run project.completed

# Disable hooks for single command
steroids tasks update "Task" --status completed --no-hooks
```

---

## Related Documentation

- [STORAGE.md](./STORAGE.md) - Config file format
- [SCHEMAS.md](./SCHEMAS.md) - Validation schemas
- [COMMANDS.md](./COMMANDS.md) - CLI commands
