# Payload & Error Schemas

> JSON schemas for hook payloads and error responses.
> For core schemas, see [SCHEMAS.md](./SCHEMAS.md)

---

## Hook Payload Schemas

### Task Event Payload

Used for `task.completed` and `task.created` events.

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [event, timestamp, task, project]
properties:
  event:
    type: string
    enum: [task.completed, task.created]
  timestamp:
    type: string
    format: date-time
  task:
    type: object
    required: [id, title, status]
    properties:
      id:
        type: string
        format: uuid
      title:
        type: string
      status:
        type: string
        enum: [pending, in_progress, completed, review]
      previousStatus:
        type: string
        enum: [pending, in_progress, completed, review]
      section:
        type: ["string", "null"]
      sectionId:
        type: ["string", "null"]
        format: uuid
      file:
        type: string
      line:
        type: integer
      sourceFile:
        type: ["string", "null"]
  project:
    type: object
    required: [name, path]
    properties:
      name:
        type: string
      path:
        type: string
```

---

### Section Event Payload

Used for `section.completed` events.

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [event, timestamp, section, tasks, project]
properties:
  event:
    type: string
    const: section.completed
  timestamp:
    type: string
    format: date-time
  section:
    type: object
    required: [id, name, taskCount, file]
    properties:
      id:
        type: string
        format: uuid
      name:
        type: string
      taskCount:
        type: integer
      file:
        type: string
  tasks:
    type: array
    items:
      type: object
      properties:
        id:
          type: string
          format: uuid
        title:
          type: string
  project:
    type: object
    required: [name, path]
```

---

### Project Event Payload

Used for `project.completed` events.

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [event, timestamp, project, summary]
properties:
  event:
    type: string
    const: project.completed
  timestamp:
    type: string
    format: date-time
  project:
    type: object
    required: [name, path]
    properties:
      name:
        type: string
      path:
        type: string
  summary:
    type: object
    properties:
      totalTasks:
        type: integer
      files:
        type: array
        items:
          type: string
```

---

### Health Event Payload

Used for `health.changed` and `health.critical` events.

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [event, timestamp, project, health]
properties:
  event:
    type: string
    enum: [health.changed, health.critical]
  timestamp:
    type: string
    format: date-time
  project:
    type: object
    required: [name, path]
  health:
    type: object
    required: [score, status]
    properties:
      score:
        type: integer
        minimum: 0
        maximum: 100
      previousScore:
        type: integer
        minimum: 0
        maximum: 100
      status:
        type: string
        enum: [healthy, warning, critical]
      failedChecks:
        type: array
        items:
          type: string
  threshold:
    type: integer
    description: Only present for health.critical events
```

---

## Error Schema

### Error Response

All failed CLI commands return this structure:

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [success, command, error]
properties:
  success:
    type: boolean
    const: false
  command:
    type: string
  timestamp:
    type: string
    format: date-time
  error:
    type: object
    required: [code, message]
    properties:
      code:
        type: string
        enum:
          - GIT_NOT_INSTALLED
          - GIT_NOT_REPO
          - GIT_AUTH_FAILED
          - TASK_NOT_FOUND
          - TASK_AMBIGUOUS
          - CONFIG_NOT_FOUND
          - CONFIG_INVALID
          - HOOK_NOT_FOUND
          - HOOK_FAILED
          - WEBHOOK_TIMEOUT
          - INVALID_ARGUMENT
          - MISSING_ARGUMENT
          - PERMISSION_DENIED
          - HEALTH_THRESHOLD
          - RUNNER_NOT_FOUND
          - RUNNER_LOCKED
          - BACKUP_FAILED
      message:
        type: string
        description: Human-readable error message
      suggestion:
        type: string
        description: Suggested action to fix the error
      details:
        type: object
        description: Additional error context
```

### Error Codes Reference

| Code | Exit | Description |
|------|------|-------------|
| `GIT_NOT_INSTALLED` | 1 | Git not in PATH |
| `GIT_NOT_REPO` | 1 | Not a Git repository |
| `GIT_AUTH_FAILED` | 3 | Git authentication failed |
| `TASK_NOT_FOUND` | 4 | Task title/ID not matched |
| `TASK_AMBIGUOUS` | 2 | Multiple tasks match |
| `CONFIG_NOT_FOUND` | 3 | No config file |
| `CONFIG_INVALID` | 3 | Invalid YAML syntax |
| `HOOK_NOT_FOUND` | 4 | Hook name not found |
| `HOOK_FAILED` | 6 | Hook execution failed |
| `WEBHOOK_TIMEOUT` | 6 | Webhook request timeout |
| `INVALID_ARGUMENT` | 2 | Bad argument value |
| `MISSING_ARGUMENT` | 2 | Required arg missing |
| `PERMISSION_DENIED` | 5 | File not writable |
| `HEALTH_THRESHOLD` | 7 | Health below threshold |
| `RUNNER_NOT_FOUND` | 4 | Runner ID not found |
| `RUNNER_LOCKED` | 6 | Another runner is active |
| `BACKUP_FAILED` | 6 | Backup operation failed |

---

## Related Documentation

- [SCHEMAS.md](./SCHEMAS.md) - Core schemas (config, task, section)
- [HOOKS.md](./HOOKS.md) - Hooks configuration guide
- [API.md](./API.md) - JSON output schemas
