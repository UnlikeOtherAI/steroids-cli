# Reviewer Section Task Context

## Purpose

The reviewer (Codex) is provided with context about **all other tasks in the same section** when reviewing a task. This prevents incorrect rejections for issues that belong to other tasks.

## Problem Solved

Without section context, the reviewer would:
1. See the current task in isolation
2. Reject for missing functionality that's actually a SEPARATE task
3. Waste cycles with unnecessary rejections

**Example:** Task "Overhaul wakeup.ts" was repeatedly rejected for:
- "loop doesn't register in runners table" (separate task)
- "hasActiveRunnerForProject is ineffective" (separate task)
- "docs/cli/COMMANDS.md not updated" (separate task)

All of these are legitimate concerns, but they're explicitly listed as OTHER tasks in the same section.

## Implementation

### Files Involved

1. **`src/prompts/reviewer.ts`**
   - `SectionTask` interface
   - `formatSectionTasks()` function
   - `ReviewerPromptContext.sectionTasks` property
   - Template includes section task list

2. **`src/orchestrator/reviewer.ts`**
   - Fetches all tasks in the section before invoking reviewer
   - Passes `sectionTasks` to the prompt generator

### How It Works

```
invokeReviewer(task, projectPath)
    ↓
openDatabase(projectPath)
    ↓
listTasks(db, { sectionId: task.section_id })
    ↓
Map to SectionTask[] { id, title, status }
    ↓
Pass to generateReviewerPrompt({ ..., sectionTasks })
    ↓
formatSectionTasks() adds section to prompt:

---
## Other Tasks in This Section

**IMPORTANT:** The task you are reviewing is ONE of several tasks...
Do NOT reject this task for issues that are explicitly listed as separate tasks below.

- ⏳ Add hasActiveRunnerForProject() check... (pending)
- ⏳ Update docs/cli/COMMANDS.md with... (pending)
- ✅ Create 'steroids projects' command... (done)
...
```

## Configuration

### Section Task Limit

To prevent prompt bloat in large sections, the number of tasks shown is limited:

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_SECTION_TASKS` | 15 | Maximum tasks to show in reviewer prompt |

When a section has more tasks than the limit:
- Only the first 15 tasks are shown
- A note indicates how many more exist: `... and 5 more tasks`
- Current task is always included regardless of limit

**Future Enhancement:** Make configurable via `steroids.config.json`:
```json
{
  "reviewer": {
    "maxSectionTasks": 15
  }
}
```

## DO NOT REVERT

This code is **essential infrastructure** for the review system. Without it:
- Tasks get rejected for wrong reasons
- Rejection counts increase unnecessarily
- Developer time is wasted

If the code appears to conflict with another task, the conflict should be resolved by updating the OTHER task's approach, not by removing this feature.

## Testing

To verify the feature is working:

```bash
# Check the files have the section task code
grep -n "sectionTasks" src/prompts/reviewer.ts src/orchestrator/reviewer.ts

# Should show:
# src/prompts/reviewer.ts:XX: sectionTasks?: SectionTask[];
# src/orchestrator/reviewer.ts:XX: sectionTasks = allSectionTasks.map(...)
```

## Related

- Phase 0.4: Global Runner Registry (the section using this feature)
- PROMPTS.md: Reviewer prompt template specification
