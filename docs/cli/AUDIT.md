# Audit Trail System

> Accountability and review tracking for task state changes.
> For storage overview, see [STORAGE.md](./STORAGE.md)

---

## Overview

Every task status change is recorded with full accountability. This enables:
- Tracing who/what made each change
- Review approval workflows
- Model attribution for LLM-driven changes

---

## Audit Entry Structure

```json
{
  "status": "review",
  "previousStatus": "in_progress",
  "timestamp": "2024-01-15T10:30:00Z",
  "actor": {
    "type": "model",
    "model": "claude-sonnet-4"
  },
  "approval": {
    "approved": true,
    "approvedBy": "claude-opus-4",
    "approvedAt": "2024-01-15T11:00:00Z",
    "notes": "Implementation matches specification"
  }
}
```

---

## Actor Types

| Type | Description | Identifier |
|------|-------------|------------|
| `human` | Manual change via CLI | Username or "user" |
| `model` | Change made by LLM agent | Model identifier |

### Model Identifiers

Use standard model identifiers:
- `claude-sonnet-4`
- `claude-opus-4`
- `claude-haiku-4`
- `gpt-4`
- `gpt-4-turbo`
- Custom: `custom:my-fine-tuned-model`

---

## Approval Workflow

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   pending   │──────│ in_progress │──────│   review    │
└─────────────┘      └─────────────┘      └─────────────┘
                                                 │
                                    ┌────────────┴────────────┐
                                    │                         │
                                    ▼                         ▼
                           ┌─────────────┐           ┌─────────────┐
                           │  completed  │           │   pending   │
                           │ (approved)  │           │ (rejected)  │
                           └─────────────┘           └─────────────┘
```

### Review Process

1. **Submit for review**: Coding agent sets status to `review`
2. **Source verification**: Reviewer examines work against `sourceFile`
3. **Decision**:
   - Approved → status becomes `completed` with approval record
   - Rejected → status returns to `pending` with notes on fixes needed

### Source File Reference

Each task can link to its original specification:

```json
{
  "id": "a1b2c3d4-...",
  "title": "Implement user authentication",
  "sourceFile": "docs/SPEC.md#authentication",
  "status": "review"
}
```

The reviewer uses this link to verify the implementation matches the specification.

---

## Audit Storage

Audit entries are stored in `.steroids/ids.json` alongside task metadata:

```json
{
  "version": 1,
  "tasks": {
    "a1b2c3d4-...": {
      "file": "TODO.md",
      "line": 15,
      "title": "Fix login bug",
      "sourceFile": "docs/SPEC.md#login-fix",
      "createdAt": "2024-01-15T10:00:00Z",
      "audit": [
        {
          "status": "in_progress",
          "previousStatus": "pending",
          "timestamp": "2024-01-15T10:30:00Z",
          "actor": { "type": "model", "model": "claude-sonnet-4" }
        },
        {
          "status": "review",
          "previousStatus": "in_progress",
          "timestamp": "2024-01-15T11:00:00Z",
          "actor": { "type": "model", "model": "claude-sonnet-4" }
        },
        {
          "status": "completed",
          "previousStatus": "review",
          "timestamp": "2024-01-15T11:30:00Z",
          "actor": { "type": "model", "model": "claude-opus-4" },
          "approval": {
            "approved": true,
            "approvedBy": "claude-opus-4",
            "approvedAt": "2024-01-15T11:30:00Z",
            "notes": "LGTM"
          }
        }
      ]
    }
  }
}
```

---

## CLI Commands

### View Audit Trail

```bash
# View audit trail for a task
steroids tasks audit a1b2c3d4-e5f6-7890-abcd-ef1234567890

# Output:
# AUDIT TRAIL: Fix login bug
# ──────────────────────────────────────────────────────────
# 2024-01-15 10:30:00  pending → in_progress   [model: claude-sonnet-4]
# 2024-01-15 11:00:00  in_progress → review    [model: claude-sonnet-4]
# 2024-01-15 11:30:00  review → completed      [model: claude-opus-4]
#                      ✓ Approved: "LGTM"
```

### View Approvals

```bash
# View all recent approvals
steroids tasks approvals --limit 20

# View approvals by specific model
steroids tasks approvals --model claude-opus-4

# View rejections
steroids tasks approvals --rejected
```

### Approve a Task

```bash
# Approve a task in review status
steroids tasks approve a1b2c3d4-... --model claude-opus-4 --notes "LGTM"

# Approve with source verification
steroids tasks approve a1b2c3d4-... --model claude-opus-4 --source-check
```

### Reject a Task

```bash
# Reject a task back to pending
steroids tasks reject a1b2c3d4-... --model claude-opus-4 --notes "Missing tests"
```

---

## Audit Schema

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [status, timestamp, actor]
properties:
  status:
    type: string
    enum: [pending, in_progress, completed, review]
  previousStatus:
    type: string
    enum: [pending, in_progress, completed, review]
  timestamp:
    type: string
    format: date-time
  actor:
    type: object
    required: [type]
    properties:
      type:
        type: string
        enum: [human, model]
      model:
        type: string
        description: Model identifier when type is "model"
      user:
        type: string
        description: Username when type is "human"
  approval:
    type: object
    description: Present when status changed via approve/reject
    properties:
      approved:
        type: boolean
      approvedBy:
        type: string
        description: Model or user that made the decision
      approvedAt:
        type: string
        format: date-time
      notes:
        type: string
```

---

## Retention & Cleanup

Audit entries are retained with their tasks. When tasks are purged:

```bash
# Purge tasks but keep audit trail
steroids purge tasks --older-than 30d --keep-audit

# Purge tasks and audit trail together
steroids purge tasks --older-than 30d
```

Orphaned audit entries (from deleted tasks) are cleaned up after 90 days by default.

---

## JSON Output

```bash
steroids tasks audit a1b2c3d4-... --json
```

```json
{
  "success": true,
  "command": "tasks",
  "data": {
    "task": {
      "id": "a1b2c3d4-...",
      "title": "Fix login bug",
      "status": "completed",
      "sourceFile": "docs/SPEC.md#login-fix"
    },
    "audit": [
      {
        "status": "in_progress",
        "previousStatus": "pending",
        "timestamp": "2024-01-15T10:30:00Z",
        "actor": { "type": "model", "model": "claude-sonnet-4" }
      },
      {
        "status": "review",
        "previousStatus": "in_progress",
        "timestamp": "2024-01-15T11:00:00Z",
        "actor": { "type": "model", "model": "claude-sonnet-4" }
      },
      {
        "status": "completed",
        "previousStatus": "review",
        "timestamp": "2024-01-15T11:30:00Z",
        "actor": { "type": "model", "model": "claude-opus-4" },
        "approval": {
          "approved": true,
          "approvedBy": "claude-opus-4",
          "approvedAt": "2024-01-15T11:30:00Z",
          "notes": "LGTM"
        }
      }
    ]
  }
}
```

---

## Related Documentation

- [STORAGE.md](./STORAGE.md) - File storage specification
- [COMMANDS.md](./COMMANDS.md) - CLI commands
- [SCHEMAS.md](./SCHEMAS.md) - JSON/YAML validation schemas
- [RUNNERS.md](./RUNNERS.md) - LLM agent coordination
