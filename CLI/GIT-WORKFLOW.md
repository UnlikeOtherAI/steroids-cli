# Git Workflow

> When and how git operations happen in the orchestrator flow.
> For orchestrator details, see [ORCHESTRATOR.md](./ORCHESTRATOR.md)

---

## Overview

Git operations are **automatic but resilient**. The key principle:

**Never block development because of git failures.**

If a push fails, continue working. Stack up completed tasks. Retry on next completion.

---

## When Git Operations Happen

### Timeline

```
Task picked up          Task coded           Task reviewed         Git push
     │                      │                     │                   │
     ▼                      ▼                     ▼                   ▼
   [ ] ──────────────► [-] ──────────────► [o] ──────────────► [x] ──► PUSH
 pending            in_progress           review            completed
     │                      │                     │                   │
     │                      │                     │                   │
No git ops          Coder commits         No git ops          Git push
                    (optional)                              (automatic)
```

### During Coding (Optional Commits)

The coder MAY make commits during implementation:

```bash
# Coder can commit intermediate work
git add src/feature/
git commit -m "WIP: Add feature scaffolding"
```

This is optional. Some tasks may have no intermediate commits.

### On Task Completion (Automatic Push)

When reviewer approves a task (`[o]` → `[x]`):

```
1. Task marked as completed
   (Build and tests have already passed - verified by orchestrator)
2. Orchestrator triggers git push
3. If push succeeds → move to next task
4. If push fails → log failure, move to next task anyway
   (Commits are stacked locally; next success pushes all)
```

**Prerequisite:** A task can only reach `completed` if build AND tests passed. The push step never happens for code that doesn't build.

---

## Push Strategy

### Single Task Push

After each approved task, attempt to push:

```bash
# What the orchestrator runs
git push origin main
```

### Push Failure Handling

```
PUSH ATTEMPT
     │
     ▼
  SUCCESS? ──YES──► Log success, continue
     │
     NO
     │
     ▼
  Log failure
     │
     ▼
  Mark task as "completed_unpushed"
     │
     ▼
  Continue to NEXT TASK
     │
     ▼
  After next task completes...
     │
     ▼
  Retry push (includes all unpushed work)
```

### Stacking Unpushed Work

If pushes keep failing:

```
Task 1: completed ✓ (push failed)
Task 2: completed ✓ (push failed)
Task 3: completed ✓ (push failed)
Task 4: completed ✓ (push succeeded - all 4 tasks pushed together)
```

The next successful push includes ALL previously failed pushes.

---

## Commit Messages

### Coder Commits (During Implementation)

Format:
```
<type>: <description>

Task: <task-id>
```

Example:
```
feat: Add user authentication login flow

Task: a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### Types

| Type | Use For |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructuring |
| `test` | Adding tests |
| `docs` | Documentation |
| `chore` | Maintenance |

---

## Conflict Handling

### Detection

When push fails due to conflict:

```
$ git push origin main
To github.com:user/repo.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs
```

### Resolution

**DO NOT automatically rebase or merge.**

Log the conflict and continue:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "event": "push_failed",
  "reason": "conflict",
  "taskId": "a1b2c3d4-...",
  "action": "continuing to next task"
}
```

### Human Resolution

Conflicts require human intervention:

```bash
# Human runs:
git pull --rebase origin main
# Resolve conflicts manually
git push origin main

# Then resume orchestrator
steroids runners start
```

---

## Branch Strategy

### Default: Main Branch

All work happens on `main` (or `master`):

```
main: ──●──●──●──●──●──●──●──●──●──●──
         task1  task2  task3  task4
```

### Future: Feature Branches (Not Implemented)

In future versions, optional feature branch support:

```
main:    ──●──────────────────●──
            \                /
feature:     ●──●──●──●──●──
              task work
```

---

## CLI Commands

### Manual Git Operations

```bash
# Force push (after human conflict resolution)
steroids git push --force

# Show unpushed tasks
steroids git status

# Retry all failed pushes
steroids git retry
```

### Git Status in Task List

```bash
$ steroids tasks --status completed

ID                                    TITLE                    PUSHED
a1b2c3d4-e5f6-7890-abcd-ef1234567890  Add login feature        ✓
b2c3d4e5-f6a7-8901-bcde-f12345678901  Fix session bug          ✗ (conflict)
c3d4e5f6-a7b8-9012-cdef-123456789012  Add logout button        ✗ (pending)
```

---

## Push Failure Scenarios

### Network Failure

```
Scenario: Internet disconnected during push

Action:
  1. Log failure with "network_error"
  2. Continue to next task
  3. Retry on next completion

Recovery:
  - Automatic on next push attempt
```

### Authentication Failure

```
Scenario: Git credentials expired

Action:
  1. Log failure with "auth_error"
  2. Continue to next task
  3. Retry on next completion

Recovery:
  - Human re-authenticates: gh auth login
  - Next push attempt succeeds
```

### Conflict (Non-Fast-Forward)

```
Scenario: Someone else pushed to main

Action:
  1. Log failure with "conflict"
  2. Continue to next task
  3. DO NOT auto-rebase

Recovery:
  - Human resolves conflict
  - Human pushes manually
  - steroids git retry for remaining
```

### Repository Not Found

```
Scenario: Remote deleted or renamed

Action:
  1. Log failure with "repo_not_found"
  2. STOP orchestrator (critical failure)
  3. Alert user

Recovery:
  - Human fixes remote configuration
  - Restart orchestrator
```

---

## Configuration

### In `~/.steroids/config.yaml`

```yaml
git:
  _description: "Git workflow configuration"

  autoPush:
    _description: "Automatically push after task completion"
    _options: [true, false]
    _default: true
    value: true

  remote:
    _description: "Git remote to push to"
    _default: origin
    value: origin

  branch:
    _description: "Branch to push to"
    _default: main
    value: main

  retryOnFailure:
    _description: "Retry push on next task completion"
    _options: [true, false]
    _default: true
    value: true

  commitPrefix:
    _description: "Prefix for commit messages"
    _default: ""
    value: "[steroids] "
```

---

## Audit Trail

### Push Events

All push attempts are logged:

```json
{
  "version": 1,
  "pushes": [
    {
      "timestamp": "2024-01-15T10:30:00Z",
      "taskId": "a1b2c3d4-...",
      "success": true,
      "commitHash": "abc123",
      "remote": "origin",
      "branch": "main"
    },
    {
      "timestamp": "2024-01-15T10:45:00Z",
      "taskId": "b2c3d4e5-...",
      "success": false,
      "error": "conflict",
      "message": "non-fast-forward"
    }
  ]
}
```

### Viewing Push History

```bash
$ steroids git log

TIMESTAMP            TASK                                   STATUS    COMMIT
2024-01-15 10:30:00  a1b2c3d4-e5f6-7890-abcd-ef1234567890  success   abc123
2024-01-15 10:45:00  b2c3d4e5-f6a7-8901-bcde-f12345678901  failed    (conflict)
2024-01-15 11:00:00  c3d4e5f6-a7b8-9012-cdef-123456789012  success   def456
```

---

## Best Practices

### For Clean History

1. **One commit per task** - Squash if needed
2. **Clear commit messages** - Reference task ID
3. **Push after each task** - Don't accumulate too many

### For Conflict Avoidance

1. **Small tasks** - Less time between pushes
2. **Frequent syncs** - Pull before starting work (not yet implemented)
3. **Coordinate with team** - Avoid overlapping work areas

---

## Related Documentation

- [ORCHESTRATOR.md](./ORCHESTRATOR.md) - Main loop and task flow
- [HOOKS.md](./HOOKS.md) - Triggers after push
- [STORAGE.md](./STORAGE.md) - How push state is stored
