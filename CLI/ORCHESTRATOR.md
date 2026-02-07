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
         ├──────────────────────────────────┬──────────────────┐
         │                                  │                  │
         ▼                                  ▼                  ▼
    - [x] completed                    REJECTED           - [!] disputed
    (reviewer approved)                     │             (logged, done)
         │                                  │                  │
         ▼                                  │                  ▼
    [GIT PUSH]                              │             [GIT PUSH]
         │                                  │                  │
         ▼                                  ▼                  ▼
    NEXT TASK ◄─────────────────── Back to - [-] ─────► NEXT TASK
                                   (coder fixes)
```

**Key insight:** Disputed tasks `[!]` are pushed and treated as done. The dispute is logged but doesn't block progress. Human can revisit later if the disagreement causes real problems downstream.

### Status Markers in TODO.md

| Marker | Status | Meaning |
|--------|--------|---------|
| `- [ ]` | pending | Not started, waiting for coder |
| `- [-]` | in_progress | Coder actively working |
| `- [o]` | review | Coder finished, waiting for reviewer |
| `- [x]` | completed | Reviewer approved, ready for push |
| `- [!]` | disputed | Disagreement logged, treated as done |
| `- [F]` | failed | Exceeded 15 rejections, requires human |

**Terminal states:** `[x]`, `[!]`, and `[F]` all cause the loop to move to the next task. Disputed and completed tasks have their code pushed. Failed tasks are a full stop - the project cannot continue automatically until human intervention.

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
              Mark [!]   Back to [-]
              Git push   Coder fixes
              NEXT TASK
```

---

## Task Selection Algorithm

When looking for the next task, process **top to bottom, one by one**:

```python
def find_next_task(tasks):
    # Skip terminal states: completed [x] and disputed [!] are both "done"
    active_tasks = [t for t in tasks if t.status not in ["completed", "disputed"]]

    # Priority 1: Tasks ready for review (complete the loop first)
    for task in active_tasks:
        if task.status == "review":  # [o]
            return task, "review"

    # Priority 2: Tasks in progress (resume incomplete work)
    for task in active_tasks:
        if task.status == "in_progress":  # [-]
            return task, "resume"

    # Priority 3: Next pending task (start new work)
    for task in active_tasks:
        if task.status == "pending":  # [ ]
            return task, "start"

    return None, "idle"
```

**Rule:** Always complete review tasks first before starting new work.

---

## CLI Invocation Responsibility

**Who calls what:**

| Actor | What They Do | How |
|-------|--------------|-----|
| **Orchestrator daemon** | Invokes LLM CLIs with prompts | Spawns subprocess: `claude --print --model X < prompt.txt` |
| **LLM (Coder/Reviewer)** | Calls `steroids` CLI for status changes | Executes: `steroids tasks update <id> --status review` |
| **LLM (Coder)** | Edits project files, runs tests | Direct file operations |
| **LLM (Reviewer)** | Reads diffs, approves/rejects | Executes: `steroids tasks approve <id>` |

### Invocation Flow

```
Orchestrator Daemon (steroids runners)
         │
         │ Spawns subprocess
         ▼
    claude --print --model claude-sonnet-4 < /tmp/prompt-xxx.txt
         │
         │ LLM runs and outputs actions
         ▼
    LLM executes: steroids tasks update abc123 --status review
         │
         │ CLI updates database
         ▼
    Orchestrator detects new status on next cycle
```

**Key insight:** The orchestrator daemon doesn't directly change task status. It spawns LLMs, and the LLMs call `steroids` CLI commands to update state. The daemon only reads state and decides which LLM to invoke.

---

## Coder Workflow

When orchestrator invokes the coder:

```
1. Load task context:
   - Task title and description
   - sourceFile link (specification)
   - AGENTS.md (project guidelines)
   - Relevant project files
   - Build command (from config or auto-detected)

2. Fill coder prompt template with variables

3. Invoke coder CLI:
   $ claude -p "..." --model claude-sonnet-4

4. Coder implements the task:
   - Reads specification from sourceFile
   - Writes/modifies project files
   - Runs tests if applicable
   - NEVER touches .steroids/ files

5. Coder MUST verify build AND tests pass:
   $ npm run build    # or detected build command
   $ npm test         # or detected test command
   # Fix any errors until both pass

6. When build AND tests pass, coder submits:
   $ git add <files>
   $ git commit -m "feat: task title"
   $ steroids tasks update <id> --status review

7. Orchestrator validates submission:
   - Re-runs build command to verify compilation
   - Re-runs test command to verify all tests pass
   - If build OR tests fail → back to in_progress (coder fixes)
   - If both pass → ready for reviewer
```

### Build Verification (CRITICAL)

**The project MUST build AND all tests must pass before a task can be reviewed.**

Build verification has two stages:
1. **Compile**: The project must compile/build without errors
2. **Tests**: All tests must pass

The orchestrator verifies this by running the build command after the coder submits:

```python
def verify_build():
    build_cmd = get_build_command()  # From config or auto-detect

    result = run(build_cmd, timeout=600)  # 10 min timeout

    if result.exit_code != 0:
        # Build failed - reject submission
        update_task_status(task_id, "in_progress")
        add_audit_entry(task_id, "review", "in_progress",
                        "orchestrator", "Build failed")
        return False

    # Run tests
    test_cmd = get_test_command()  # From config or auto-detect
    if test_cmd:
        result = run(test_cmd, timeout=600)
        if result.exit_code != 0:
            update_task_status(task_id, "in_progress")
            add_audit_entry(task_id, "review", "in_progress",
                            "orchestrator", "Tests failed")
            return False

    return True
```

### Build & Test Command Detection

| Project Type | Detection | Build Command | Test Command |
|--------------|-----------|---------------|--------------|
| Node.js | `package.json` with `build` script | `npm run build` | `npm test` |
| Node.js | `package.json` without `build` | `npm install` | `npm test` |
| Rust | `Cargo.toml` | `cargo build` | `cargo test` |
| Go | `go.mod` | `go build ./...` | `go test ./...` |
| Python | `pyproject.toml` or `setup.py` | `pip install -e .` | `pytest` |
| Make | `Makefile` | `make` | `make test` |
| Custom | `config.yaml` | User-specified | User-specified |

### Custom Build & Test Command

```yaml
# In .steroids/config.yaml
build:
  command: "npm run build"
  timeout: 600  # 10 minutes

test:
  command: "npm test"
  timeout: 600  # 10 minutes
  required: true  # Tests must pass (default: true)
```

### Output Validation

After each LLM invocation, the orchestrator verifies the expected state change occurred:

```python
def validate_coder_output(task_id):
    # Re-read task state from database
    task = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()

    if task.status == "review":
        # Coder correctly called `steroids tasks update --status review`
        return "success"

    if task.status == "in_progress":
        # Coder did NOT update status - check for uncommitted work
        git_status = run("git status --porcelain")

        if git_status:
            # There's work but coder forgot to submit
            log_warning("Coder has uncommitted work but didn't submit")
            # Next cycle will pick up the same task with RESUMING prompt
            return "retry_next_cycle"
        else:
            # Coder did nothing at all
            log_warning("Coder produced no changes")
            return "retry_next_cycle"

    return "unexpected_state"

def validate_reviewer_output(task_id):
    task = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()

    if task.status == "completed":
        return "approved"
    if task.status == "in_progress":
        return "rejected"  # Back to coder
    if task.status == "disputed":
        return "disputed"
    if task.status == "failed":
        return "failed"  # Exceeded 15 rejections
    if task.status == "review":
        # Reviewer did NOT take action
        log_warning("Reviewer did not approve/reject/dispute")
        return "retry_next_cycle"

    return "unexpected_state"
```

**Key:** The orchestrator doesn't trust LLM output. It always re-reads the database to confirm the CLI was actually called. If no action was taken, the same task is picked up again on the next cron cycle.

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
   # Changes [o] back to [-], increments rejection_count, coder will fix

   APPROVE WITH NOTE (minor issues):
   $ steroids tasks approve <id> --model <reviewer-model> --notes "Minor: prefer X"
   # Approves but logs feedback - coder can address later or ignore

   DISPUTE (rare - only for fundamental issues):
   $ steroids dispute create <id> --reason "..."
   # Task → disputed, code pushed, loop continues
```

---

## Rejection Handling

### Max 15 Rejections

Tasks track a `rejection_count`. After 15 rejections without resolution, the task fails:

```python
def handle_rejection(task_id, reviewer_notes):
    with db:
        # Increment rejection count
        db.execute("""
            UPDATE tasks
            SET rejection_count = rejection_count + 1,
                status = 'in_progress',
                updated_at = datetime('now')
            WHERE id = ?
        """, (task_id,))

        # Check if exceeded limit
        count = db.execute(
            "SELECT rejection_count FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()[0]

        if count >= 15:
            # Task failed - create system dispute
            db.execute("""
                UPDATE tasks SET status = 'failed' WHERE id = ?
            """, (task_id,))

            db.execute("""
                INSERT INTO disputes (id, task_id, type, reason, created_by)
                VALUES (?, ?, 'system', 'Exceeded 15 rejections', 'system')
            """, (uuid4(), task_id))

            log_error(f"Task {task_id} failed after 15 rejections")
            return "failed"

        # Add audit entry for rejection
        db.execute("""
            INSERT INTO audit (task_id, from_status, to_status, actor, notes)
            VALUES (?, 'review', 'in_progress', ?, ?)
        """, (task_id, reviewer_model, reviewer_notes))

        return "retry"
```

### Failed Status

`failed` is a **terminal state**. When a task fails:

1. Task status becomes `[F]`
2. A system dispute is auto-created with full history
3. **The project cannot continue automatically**
4. Human must intervene to resolve

Human can:
- Resolve the dispute and manually complete the task
- Delete the task if it's no longer needed
- Modify the specification and reset the task

**This should never happen.** If tasks regularly hit 15 rejections, the specification is unclear or there's a fundamental miscommunication between coder and reviewer.

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

## Network Failure Handling

**Simple retry via cron.** If a network failure occurs:

1. The LLM invocation fails
2. Task status remains unchanged (still `pending` or `in_progress`)
3. Cron wakes up next minute, sees the same task
4. Tries again

No special backoff needed - if the network is down, nothing happens. When it comes back, the next cron cycle picks up where it left off.

```python
def handle_network_failure():
    # Do nothing special - task status is unchanged
    # Next cron cycle (1 minute) will retry automatically
    log_warning("Network failure - will retry next cycle")
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

### Runner State (in `~/.steroids/steroids.db`)

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

### Heartbeat & Hang Detection

Subprocess hang detection is based on **log output timestamps**, not wall-clock time:

- Every log line from the LLM subprocess includes a timestamp
- If no new log output for **15 minutes**, the subprocess is considered hung
- Hung subprocesses are killed and the task is retried next cycle

```python
def check_subprocess_hang(last_log_timestamp):
    if datetime.now() - last_log_timestamp > timedelta(minutes=15):
        # No output for 15 minutes - subprocess is hung
        return True
    return False
```

**Why 15 minutes?** LLM coding sessions can involve long pauses for:
- Complex reasoning
- Large file generation
- Build/test execution

But 15 minutes without ANY output (including thinking indicators) means something is wrong.

### Runner Heartbeat

- Runner updates `lastHeartbeat` every 30 seconds
- Cron checks: if `lastHeartbeat` > 5 minutes ago, runner process may have crashed
- Stale runners are killed and lock is released

**Note:** Runner heartbeat (5 min) is different from subprocess hang detection (15 min from last log).

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
DO NOT attempt to read or write .steroids/steroids.db.
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

- [AI-PROVIDERS.md](./AI-PROVIDERS.md) - Provider configuration, invocation, and logging
- [PROMPTS.md](./PROMPTS.md) - Prompt templates for each role
- [GIT-WORKFLOW.md](./GIT-WORKFLOW.md) - When and how git operations happen
- [DISPUTES.md](./DISPUTES.md) - Coder/reviewer disagreement handling
- [LOCKING.md](./LOCKING.md) - Task and runner locking
- [RUNNERS.md](./RUNNERS.md) - Runner system details
