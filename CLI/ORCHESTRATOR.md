# Orchestrator System

> The deterministic daemon that coordinates task execution.
> For AI provider setup, see [AI-PROVIDERS.md](./AI-PROVIDERS.md)

---

## Overview

The orchestrator is a **deterministic daemon** (not LLM-orchestrated) that:

1. Wakes up every minute via cron
2. Checks task state (what's pending, in progress, ready for review)
3. Invokes the appropriate AI (coder or reviewer) based on task state
4. Never makes decisions itself - just follows the state machine

**Key Principle:** The orchestrator removes decision-making from the LLM. Each task runs through a fixed loop until complete.

---

## Roles

Three distinct AI roles, each configured separately:

| Role | Purpose | When Invoked |
|------|---------|--------------|
| **Orchestrator** | Generates prompts, coordinates handoffs | Every wake-up cycle |
| **Coder** | Implements tasks, writes code | Task in `pending` or `in_progress` |
| **Reviewer** | Reviews implementations, approves/rejects | Task in `review` status |

Each role can use a different provider/model, or share the same one.

---

## Task State Machine

```
┌──────────────────────────────────────────────────────────────────┐
│                         TASK LIFECYCLE                            │
└──────────────────────────────────────────────────────────────────┘

    - [ ] pending          Task not yet started
         │
         ▼
    - [-] in_progress      Coder is working on it
         │
         ▼
    - [o] review           Ready for reviewer
         │
         ├──────────────────────────────────┐
         │                                  │
         ▼                                  ▼
    - [x] completed                    REJECTED
    (reviewer approved)                     │
         │                                  │
         ▼                                  │
    [GIT PUSH]                              │
         │                                  │
         ▼                                  ▼
    NEXT TASK ◄─────────────────── Back to - [-] in_progress
                                   (coder fixes issues)
```

### Status Markers in TODO.md

| Marker | Status | Meaning |
|--------|--------|---------|
| `- [ ]` | pending | Not started, waiting for coder |
| `- [-]` | in_progress | Coder actively working |
| `- [o]` | review | Coder finished, waiting for reviewer |
| `- [x]` | completed | Reviewer approved, ready for push |

---

## Main Loop (Cron Wake-Up)

Every minute, the cron job triggers `steroids runners wakeup`:

```
┌─────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR MAIN LOOP                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Is a runner active? │
                   └─────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ YES                           │ NO
              ▼                               ▼
   ┌─────────────────────┐         ┌─────────────────────┐
   │ Check heartbeat     │         │ Scan for pending    │
   │ (is it alive?)      │         │ or review tasks     │
   └─────────────────────┘         └─────────────────────┘
              │                               │
    ┌─────────┴─────────┐          ┌─────────┴─────────┐
    │ ALIVE      STALE  │          │ FOUND     NONE    │
    ▼              ▼               ▼              ▼
  [EXIT]     [Kill zombie,     [Start         [EXIT -
             restart]          new runner]     go idle]
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Find next task:     │
                         │ 1. Any [o] review?  │
                         │ 2. Any [-] started? │
                         │ 3. Any [ ] pending? │
                         └─────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
       [o] REVIEW            [-] IN PROGRESS        [ ] PENDING
              │                     │                     │
              ▼                     ▼                     ▼
       Invoke REVIEWER       Check if stuck        Invoke CODER
              │               (timeout?)                  │
              │                     │                     │
              ▼                     ▼                     ▼
       Approve/Reject?       Resume or restart     Mark as [-]
              │                                    Start coding
              │
    ┌─────────┴─────────┐
    │                   │
    ▼                   ▼
 APPROVE             REJECT
    │                   │
    ▼                   ▼
 Mark [x]          Check for DISPUTE
 Git push               │
    │              ┌────┴────┐
    ▼              │         │
 NEXT TASK     DISPUTED   NORMAL
                   │         │
                   ▼         ▼
              STOP &     Back to [-]
              ASK USER   Coder fixes
```

---

## Task Selection Algorithm

When looking for the next task, process **top to bottom, one by one**:

```python
def find_next_task(tasks):
    # Priority 1: Tasks ready for review (complete the loop first)
    for task in tasks:
        if task.status == "review":  # [o]
            return task, "review"

    # Priority 2: Tasks in progress (resume incomplete work)
    for task in tasks:
        if task.status == "in_progress":  # [-]
            return task, "resume"

    # Priority 3: Next pending task (start new work)
    for task in tasks:
        if task.status == "pending":  # [ ]
            return task, "start"

    return None, "idle"
```

**Rule:** Always complete review tasks first before starting new work.

---

## Coder Workflow

When orchestrator invokes the coder:

```
1. Load task context:
   - Task title and description
   - sourceFile link (specification)
   - AGENTS.md (project guidelines)
   - Relevant project files

2. Generate coder prompt (via orchestrator)

3. Invoke coder CLI:
   $ claude --prompt "..."
   # or
   $ gemini --prompt "..."
   # or
   $ openai --prompt "..."

4. Coder implements the task:
   - Reads specification from sourceFile
   - Writes/modifies project files
   - Runs tests if applicable
   - NEVER touches .steroids/ files

5. When coder believes task is complete:
   $ steroids tasks update <id> --status review
   # This changes [ ] or [-] to [o]

6. Orchestrator detects [o] on next cycle
```

---

## Reviewer Workflow

When orchestrator invokes the reviewer:

```
1. Load review context:
   - Task title and what was requested
   - sourceFile link (original specification)
   - Git diff of changes made
   - AGENTS.md guidelines

2. Generate reviewer prompt (via orchestrator)

3. Invoke reviewer CLI

4. Reviewer evaluates:
   - Does implementation match specification?
   - Are there bugs or issues?
   - Does it follow project guidelines?

5. Reviewer decision:

   APPROVE:
   $ steroids tasks approve <id> --model <reviewer-model>
   # Changes [o] to [x], triggers git push

   REJECT:
   $ steroids tasks reject <id> --model <reviewer-model> --notes "..."
   # Changes [o] back to [-], coder will fix

   DISPUTE (rare - see below):
   $ steroids dispute create <id> --reason "..."
   # Stops loop, requires human intervention
```

---

## Dispute Resolution

When coder and reviewer fundamentally disagree:

### When to Dispute

- **Architecture disagreement** - Different approaches to solving the problem
- **Specification ambiguity** - Unclear requirements that need human clarification
- **Conflicting guidelines** - AGENTS.md contradicts sourceFile

### Dispute Flow

```
1. Coder or reviewer creates dispute:
   $ steroids dispute create <task-id> --reason "Architecture disagreement"

2. System creates/updates dispute.md:
   ## Dispute: <task-id>

   **Files:** src/auth/login.ts, src/auth/session.ts
   **Reason:** Architecture disagreement
   **Coder position:** Use JWT tokens
   **Reviewer position:** Use session cookies
   **Status:** PENDING HUMAN REVIEW

3. Task marked as DISPUTED (special status)
   - Loop stops for this task
   - Other tasks continue processing

4. Human resolves:
   $ steroids dispute resolve <task-id> --decision "coder" --notes "..."
   # or
   $ steroids dispute resolve <task-id> --decision "reviewer" --notes "..."

5. Task resumes based on decision
```

### Minor Disagreements

For minor issues (style, naming, small implementation details):
- Tend to implement **coder's preference**
- Still log in dispute.md for transparency
- Don't stop the loop

```
$ steroids dispute log <task-id> --minor --notes "Style preference logged"
```

---

## Crash Recovery

### Detection via Cron

Every minute, cron checks:

```bash
# Is there an active runner?
if [ -d ~/.steroids/runners/lock ]; then
    # Check if PID is still alive
    PID=$(cat ~/.steroids/runners/lock/pid)
    if ! kill -0 $PID 2>/dev/null; then
        # Runner crashed - clean up
        rm -rf ~/.steroids/runners/lock
        # Will start fresh on next cycle
    fi
fi
```

### Task State Recovery

| Task State | On Crash | Recovery Action |
|------------|----------|-----------------|
| `[ ]` pending | Nothing started | Pick up normally |
| `[-]` in_progress | Work may be partial | New coder retries from scratch |
| `[o]` review | Ready for review | Continue to reviewer |
| `[x]` completed | Done but not pushed | Retry push |

### No Checkpointing (Simplicity)

- If coder crashes mid-task, **restart from scratch**
- Uncommitted changes are lost
- This is acceptable - better than complex checkpoint logic
- LLMs are fast; restarting is cheap

---

## Runner State

### State File (`~/.steroids/runners/state.json`)

```json
{
  "version": 1,
  "runners": {
    "runner-uuid": {
      "id": "runner-uuid",
      "status": "running",
      "currentTask": "task-uuid",
      "projectPath": "/path/to/project",
      "startedAt": "2024-01-15T10:30:00Z",
      "lastHeartbeat": "2024-01-15T10:35:00Z",
      "pid": 12345,
      "role": "coder"
    }
  }
}
```

### Heartbeat

- Runner updates `lastHeartbeat` every 30 seconds
- Cron checks: if `lastHeartbeat` > 5 minutes ago, runner is stale
- Stale runners are killed and lock is released

---

## Critical Rule: LLMs Never Touch Config Files

**EVERY prompt sent to any LLM must include:**

```
CRITICAL: You must NEVER read, write, or modify any files in the .steroids/
directory. This includes all .json, .yaml, and .yml files. You may only
read .md files in .steroids/ for context.

All task status updates MUST go through the steroids CLI:
- steroids tasks update <id> --status <status>
- steroids tasks approve <id>
- steroids tasks reject <id>
- steroids dispute create <id>

DO NOT attempt to directly modify TODO.md checkbox markers.
DO NOT attempt to read or write .steroids/config.yaml.
DO NOT attempt to read or write .steroids/tasks.json.
```

This rule is enforced by:
1. Including it in every generated prompt
2. Sandboxing file access (future)
3. Audit trail showing who modified what

---

## CLI Commands

```bash
# Start/stop orchestrator
steroids runners start          # Start daemon
steroids runners stop           # Stop gracefully
steroids runners status         # Show current state

# Manual task control
steroids tasks update <id> --status <status>
steroids tasks approve <id> --model <model>
steroids tasks reject <id> --model <model> --notes "..."

# Dispute management
steroids dispute create <id> --reason "..."
steroids dispute resolve <id> --decision <coder|reviewer>
steroids dispute list
steroids dispute show <id>

# Cron management
steroids runners cron install   # Set up minute-by-minute wake-up
steroids runners cron status    # Check if cron is active
steroids runners cron uninstall # Remove cron job
```

---

## Related Documentation

- [AI-PROVIDERS.md](./AI-PROVIDERS.md) - Provider configuration and setup
- [PROMPTS.md](./PROMPTS.md) - Prompt templates for each role
- [GIT-WORKFLOW.md](./GIT-WORKFLOW.md) - When and how git operations happen
- [LOCKING.md](./LOCKING.md) - Task and runner locking
- [RUNNERS.md](./RUNNERS.md) - Runner system details
