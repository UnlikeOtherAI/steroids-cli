# Death Spiral Debug Observations

## Summary

Analyzing failed/disputed tasks to understand why coders aren't following reviewer feedback.

**Date:** 2026-02-09

---

## Failed Tasks (Hit 15 Rejections)

| Task ID | Title | Root Cause |
|---------|-------|------------|
| edff642c | Overhaul wakeup.ts | **Scope Mismatch** - Coder submitted changes to wrong files |
| 75ee694b | Comprehensive help system | Unclear - needs investigation |
| 65e73096 | Webhook runner with retries | **Coverage Obsession** - Reviewer demands 80% global coverage |
| 99fcea58 | Hooks commands | **Spec Drift** - Coder made design changes, reviewer keeps rejecting |
| b034af53 | Integrate hooks into tasks | Needs investigation |

---

## Key Issues Identified

### 1. **Scope Mismatch**
- **Example:** Task `edff642c` asked to modify `wakeup.ts`
- **What happened:** Coder modified `reviewer.ts` and `prompts/reviewer.ts` instead
- **Root cause:** Coder is not reading the task specification correctly, or is getting confused by similar file names

### 2. **Coverage Requirements Are Too Strict**
- **Example:** Task `65e73096` rejected 15 times for coverage
- **What happened:** Reviewer kept demanding 80% global coverage
- **Root cause:** A single task should not be responsible for overall project coverage. The reviewer is applying a project-level metric to individual tasks.

### 3. **Feedback Not Getting Through**
- **Observation:** Rejection notes include clear checklists with `- [ ]` items
- **What happens:** Coder submits again without addressing all items
- **Questions:**
  - Is the rejection history being included in the coder prompt? ✅ YES (see `formatRejectionHistoryForCoder`)
  - Is the coder seeing the latest rejection? ✅ YES (latest is shown prominently)
  - Is the coder actually reading it? ❓ UNKNOWN

### 4. **Same Issues Repeated**
- **Pattern:** Rejection notes grow longer each cycle with the same items
- **Example from 65e73096:**
  - Rejection #3: "Add AbortController timeout test"
  - Rejection #7: "Add AbortController timeout test"
  - Rejection #10: "Add AbortController timeout test"
  - Rejection #15: "Add AbortController timeout test"
- **Root cause:** Coder is either not seeing or not understanding the feedback

### 5. **Design Differences Treated as Bugs**
- **Example:** Task `99fcea58` - Coder chose YAML config over CLI commands
- **Reviewer says:** "Implement `steroids hooks add`"
- **Coder says:** "Design uses YAML configuration instead"
- **Cycle continues** - Neither party disputes, both continue reject/resubmit loop

---

## Logging Issues

### Current State
- `InvocationLogger` exists in `src/providers/invocation-logger.ts`
- Logs should go to `.steroids/logs/YYYY-MM-DD/`
- **BUT:** The logs directory doesn't exist

### Why Logs Aren't Being Saved
```bash
ls -la .steroids/logs/  # "No logs directory"
```

Possible causes:
1. Logger isn't being called
2. Directory creation failing silently
3. Errors swallowed in try/catch (line 102-105)

### What's Missing
- ❌ No prompt logging visible in task audit trail
- ❌ No way to see what coder was told
- ❌ No way to see what coder responded
- ❌ No per-task invocation history

---

## Prompt Flow Analysis

### Coder Prompt Contains:
1. Task specification (from source_file)
2. AGENTS.md content (project guidelines)
3. Rejection history (latest prominently shown)
4. Clear instructions with `- [ ]` checklist format

### Reviewer Prompt Contains:
1. Task specification
2. Git diff of changes
3. Other section tasks (to avoid scope creep rejections)
4. Rejection history
5. Coder's submission notes

### Gap Analysis
- ✅ Rejection feedback IS being passed to coder
- ✅ Checkboxes are formatted clearly
- ❓ Is rejection history TOO long? (truncated after 3)
- ❓ Is coder overwhelmed by prompt length?
- ❓ Is the AI model (codex/gemini) understanding the checklist format?

---

## Recommendations

### Immediate Fixes
1. **Store invocation logs per-task in database** - not just files
2. **Add `steroids tasks show <id> --logs`** - view coder/reviewer prompts
3. **Limit coverage requirements** - per-task, not global
4. **Add dispute escalation** - auto-dispute after 10 rejections

### Prompt Improvements
1. **Make task ID more prominent** - coder might be confusing tasks
2. **Add file path hints** - explicitly state "Modify THIS file: src/runners/wakeup.ts"
3. **Reduce prompt length** - truncate old rejections more aggressively

### Process Changes
1. **Break large tasks** - tasks requiring many files should be split
2. **Coverage as separate task** - don't make individual tasks responsible for project metrics
3. **Design review phase** - before coding, have coder propose approach

---

## Investigation TODO

- [ ] Check if invocation logs are being written anywhere
- [ ] Verify rejection history is in coder prompts
- [ ] Compare prompt length vs model context limits
- [ ] Test with different AI models (claude vs codex vs gemini)
- [ ] Add verbose logging to track prompt generation

---

## Evidence from Audit Trails

### Task edff642c (wakeup.ts overhaul) - First Rejection
```
Scope mismatch: this task is to overhaul src/runners/wakeup.ts to iterate over
all registered projects (global registry) instead of using process.cwd().
The submitted diff only changes src/orchestrator/reviewer.ts and
src/prompts/reviewer.ts to include section task context in reviewer prompts,
and does not modify wakeup logic at all.
```

**Observation:** Coder submitted completely unrelated changes. This is a fundamental misunderstanding, not a minor oversight.

### Task 65e73096 (webhook runner) - Rejection Pattern
Every rejection includes:
- "Add AbortController timeout test"
- "Raise coverage to >= 80%"
- "Use Jest fake timers"

These same items appear in rejections #3 through #15. The coder never addresses them.

### Task 99fcea58 (hooks commands) - Design Stalemate
Coder's position:
> "The spec requested 'hooks add/remove/logs' CLI commands, but the implementation
> uses YAML-based configuration (config.yaml) instead. This is consistent with
> the rest of the system's configuration approach."

Reviewer's position:
> "Implement `steroids hooks add <name>` ... do not require manual YAML edits"

Neither party disputes. Both continue the reject/resubmit loop for 15 cycles.

---

## Completed Implementation

### 1. Per-Task Invocation Logging

**Migration 006 created:** `migrations/006_add_task_invocations.sql`

New table stores:
- Task ID, role (coder/reviewer), provider, model
- Full prompt text
- Full response text
- Duration, exit code, success/timeout status
- Rejection number for tracking cycle

### 2. New CLI Command: `steroids tasks show`

```bash
steroids tasks show <id>                 # Basic task info
steroids tasks show <id> --logs          # Include invocation summary
steroids tasks show <id> --logs-full     # Full prompts and responses
steroids tasks show <id> --limit 10      # Show last 10 invocations
```

### 3. Invocation Logger Updated

The `logInvocation()` function now writes to:
- `.steroids/logs/` (file-based logs)
- `task_invocations` table (database, per-task)

### 4. Parallel Analysis Documents Created

- `DEBUG_GEMINI_ANALYSIS.md` - Prompt architecture analysis
- `DEBUG_CODEX_ANALYSIS.md` - Rejection loop analysis

---

## Key Findings from Parallel Analysis

### Common Issues Identified

1. **Task ID not prominent enough** - buried after intro text
2. **Rejection history truncated** - only last 2 shown
3. **No explicit file list** - coder not told which files to modify
4. **Coverage applied globally** - reviewer demands 80% project coverage from single task
5. **No design review phase** - architectural mismatches go to 15 rejections
6. **No auto-escalation** - loop continues mechanically without human intervention

### Recommended Fixes (Priority Order)

**IMMEDIATE:**
1. Make task ID first line of prompt
2. List required/forbidden files explicitly
3. Auto-dispute after 10 rejections

**SHORT-TERM:**
4. Show all rejection titles (not just last 2)
5. Scope coverage to modified files only
6. Add design review phase before coding

**MEDIUM-TERM:**
7. Rejection pattern detection
8. Implement rejection reason categories
9. Add task-level configuration for requirements
