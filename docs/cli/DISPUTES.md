# Dispute Resolution

> Complete specification for handling coder/reviewer disagreements.
> For orchestrator flow, see [ORCHESTRATOR.md](./ORCHESTRATOR.md)

---

## Overview

Disputes occur when the coder and reviewer fundamentally disagree about implementation. The dispute system:

1. **Treats the task as effectively complete** - loop moves on
2. Records both positions for optional human review
3. Allows all other tasks to continue processing
4. Provides resolution workflow if/when human cares to look

**Key Philosophy:** A disputed task `[!]` is considered "done enough" to proceed. The orchestrator moves to the next task. Disputes are logged but low-priority - most won't need human intervention unless they actually block further development.

---

## Dispute Types

| Type | Severity | Action |
|------|----------|--------|
| **Major** | Blocks task | Stops loop, requires human resolution |
| **Minor** | Logged only | Continues with coder's implementation |

### Major Disputes

Use for:
- Architecture disagreements (different approaches)
- Specification ambiguity (unclear requirements)
- Conflicting guidelines (AGENTS.md vs sourceFile)
- Security concerns (reviewer sees vulnerability)

### Minor Disputes

Use for:
- Style preferences (naming, formatting)
- Minor implementation details
- Non-critical optimizations

---

## Task Status During Dispute

When a dispute is created, the task status changes:

```
Before:  - [o] Fix login bug    (in review)
After:   - [!] Fix login bug    (disputed - treated as done)
```

### Status Marker

| Marker | Status | Meaning |
|--------|--------|---------|
| `- [!]` | disputed | Logged disagreement, treated as complete for loop purposes |

**Important:** `[!]` is a terminal state like `[x]`. The task loop moves on. The dispute is recorded for later review, but in practice most disputes are noise and can be ignored unless they actually prevent further work.

### State in Database

```sql
-- Task with disputed status
SELECT * FROM tasks WHERE id = 'a1b2c3d4-...';
-- id: a1b2c3d4-...
-- title: Fix login bug
-- status: disputed
-- section_id: ...
-- source_file: docs/SPEC.md#login
-- rejection_count: 3
-- created_at: 2024-01-15T10:30:00Z
```

---

## Dispute Storage

Disputes are stored in the `disputes` table in `.steroids/steroids.db`:

```sql
-- View dispute for a task
SELECT * FROM disputes WHERE task_id = 'a1b2c3d4-...';

-- Example dispute record:
-- id: d1e2f3g4-...
-- task_id: a1b2c3d4-...
-- type: coder (or reviewer, minor, system)
-- status: open
-- reason: Architecture disagreement - JWT vs sessions
-- coder_position: JWT tokens are stateless and scale better
-- reviewer_position: Session cookies are more secure
-- resolution: NULL
-- created_by: model:claude-opus-4
-- created_at: 2024-01-15T14:30:00Z
```

---

## Creating a Dispute

### From Reviewer (Rejecting with Dispute)

```bash
# Instead of simple reject, escalate to dispute
steroids dispute create a1b2c3d4-... \
  --reason "architecture_disagreement" \
  --position "Session cookies are more secure" \
  --model claude-opus-4
```

### From Coder (After Rejection)

```bash
# Coder disagrees with rejection
steroids dispute create a1b2c3d4-... \
  --reason "specification_interpretation" \
  --position "Spec says 'stateless auth' which implies JWT" \
  --model claude-sonnet-4
```

### Dispute Reasons

| Reason | Description |
|--------|-------------|
| `architecture_disagreement` | Different technical approaches |
| `specification_ambiguity` | Unclear requirements |
| `guideline_conflict` | AGENTS.md contradicts spec |
| `security_concern` | Potential vulnerability |
| `scope_disagreement` | What's in/out of scope |
| `other` | Freeform explanation |

---

## Dispute Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       DISPUTE LIFECYCLE                          │
└─────────────────────────────────────────────────────────────────┘

    [o] Task in review
         │
         ▼
    Reviewer or Coder creates dispute
         │
         ▼
    ┌────────────────────────┐
    │ steroids dispute create │
    │ --reason X --position Y │
    └────────────────────────┘
         │
         ├─────── Task marked as [!] disputed
         │
         ▼
    ┌────────────────────────┐
    │ steroids.db updated  │
    │ dispute.md updated     │
    │ Changes pushed to git  │◄── Code is pushed despite dispute!
    └────────────────────────┘
         │
         ▼
    TASK CONSIDERED DONE ◄──── Orchestrator moves to next task
    (dispute logged for later)
         │
         ▼
    ┌─────────────────────────────────────────────────────────────┐
    │ OPTIONAL: Human may review dispute.md eventually            │
    │ In practice, most disputes are ignored unless they cause    │
    │ actual problems downstream.                                 │
    └─────────────────────────────────────────────────────────────┘
         │
         ▼ (if human decides to resolve)
    ┌────────────────────────┐
    │ steroids dispute resolve │
    │ --decision coder|reviewer│
    │ --notes "Explanation"    │
    └────────────────────────┘
         │
         ├─────────────────────────────────────┐
         │                                     │
         ▼                                     ▼
    Decision: CODER                      Decision: REVIEWER
         │                                     │
         ▼                                     ▼
    [!] → [x] (formalize)              [!] → [-] in_progress
    No action needed                   Coder re-implements
```

**Key:** The disputed code IS pushed to git. The dispute is just a record. Most of the time, the implementation is "good enough" and nobody needs to revisit it.

---

## Human-Readable Log (dispute.md)

In addition to JSON storage, a human-readable log is maintained at `./dispute.md` (project root):

```markdown
# Active Disputes

## Dispute: d1e2f3g4-... (OPEN)

**Task:** Fix login bug (a1b2c3d4-...)
**Reason:** Architecture disagreement
**Created:** 2024-01-15 14:30 UTC
**Files:** src/auth/jwt.ts, src/auth/middleware.ts

### Coder Position (claude-sonnet-4)
JWT tokens are stateless and scale better for distributed systems.
The specification mentions "stateless authentication" which implies JWT.

### Reviewer Position (claude-opus-4)
Session cookies are more secure for this use case.
Concerns:
- XSS vulnerability with JWT stored in localStorage
- Token revocation is complex with JWT

### Status
AWAITING HUMAN DECISION

---

## Dispute: e2f3g4h5-... (RESOLVED)

**Task:** Add caching layer (b2c3d4e5-...)
**Resolution:** CODER (2024-01-14)
**Notes:** Coder's Redis approach is correct for our scale.
```

---

## Resolving Disputes

### CLI Commands

```bash
# Accept coder's implementation
steroids dispute resolve d1e2f3g4-... \
  --decision coder \
  --notes "JWT is acceptable for our threat model"

# Accept reviewer's position (coder must re-implement)
steroids dispute resolve d1e2f3g4-... \
  --decision reviewer \
  --notes "Security is priority, use session cookies"

# Close with custom resolution
steroids dispute resolve d1e2f3g4-... \
  --decision custom \
  --notes "Use JWT but store in httpOnly cookie, not localStorage"
```

### Resolution Effects

| Decision | Task Status | Next Action |
|----------|-------------|-------------|
| `coder` | `[!]` → `[x]` completed | Git push, move to next |
| `reviewer` | `[!]` → `[-]` in_progress | Coder fixes per reviewer feedback |
| `custom` | `[!]` → `[-]` in_progress | Coder implements custom solution |

---

## Minor Disputes

For non-blocking disagreements:

```bash
# Log disagreement but continue with coder's implementation
steroids dispute log a1b2c3d4-... \
  --minor \
  --notes "Reviewer preferred camelCase but coder used snake_case. Continuing with snake_case per existing codebase convention."
```

Minor disputes:
- Don't change task status
- Are recorded in audit trail
- Don't require human resolution
- Trend towards coder's preference

---

## Viewing Disputes

```bash
# List all disputes
steroids dispute list

ID                                    TASK                   STATUS    REASON
d1e2f3g4-...                         Fix login bug          open      architecture
e2f3g4h5-...                         Add caching            resolved  specification

# Show dispute details
steroids dispute show d1e2f3g4-...

# Filter by status
steroids dispute list --status open
steroids dispute list --status resolved
```

---

## Orchestrator Behavior

Disputed tasks `[!]` are terminal states, like completed `[x]`:

```python
def find_next_task(tasks):
    # Disputed and completed are both "done" - skip them
    for task in tasks:
        if task.status in ["disputed", "completed"]:
            continue  # Already done, move on

        if task.status == "review":
            return task, "review"
        if task.status == "in_progress":
            return task, "resume"
        if task.status == "pending":
            return task, "start"

    return None, "idle"
```

### Multiple Disputed Tasks

If multiple tasks are disputed:
- Each dispute is independent
- Code was pushed for all of them
- All are logged but none block progress
- Human may never need to look at them

---

## Timeout Handling

If a dispute remains open too long:

```yaml
# In ~/.steroids/config.yaml
disputes:
  timeoutDays:
    _description: "Warn about stale disputes after N days"
    _default: 7
    value: 7

  alertOnStale:
    _description: "How to alert about stale disputes"
    _options: [log, webhook, none]
    _default: log
    value: log
```

### Stale Dispute Handling

```bash
$ steroids dispute list --stale

WARNING: 2 disputes have been open for > 7 days

ID               TASK              DAYS OPEN
d1e2f3g4-...     Fix login bug     12
f3g4h5i6-...     Add OAuth         9

Run `steroids dispute show <id>` for details.
```

---

## Related Documentation

- [ORCHESTRATOR.md](./ORCHESTRATOR.md) - Main loop and task flow
- [AUDIT.md](./AUDIT.md) - How disputes are recorded in audit trail
- [STORAGE.md](./STORAGE.md) - JSON schema for disputes
