# Follow-up Tasks Feature

## Problem Statement

Currently, when a reviewer approves work but identifies non-blocking issues or future improvements, they can only add notes to the approval. These notes are unstructured and don't become actionable tasks. Examples:

- "Consider adding unit tests later"
- "Some hardcoded classes remain (tracked separately)"
- "Documentation could be improved"

**Issues with current approach:**
- Notes disappear into history, not actionable
- No way to track technical debt identified during review
- Manual intervention required to create follow-up tasks
- Context is lost (what code? which commit? why needed?)

## Solution Overview

Enable reviewers to create **structured follow-up tasks** with rich context when approving work. These tasks:

1. ✅ Are created automatically by the orchestrator
2. ✅ Include detailed descriptions and context
3. ✅ Link back to the originating commit and task
4. ✅ Can be deferred (require human approval) or auto-implemented
5. ✅ Prevent duplicates through reviewer-side checking

## Architecture

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ REVIEWER PHASE                                              │
├─────────────────────────────────────────────────────────────┤
│ 1. Review completed work                                    │
│ 2. Identify potential follow-up tasks                       │
│ 3. GET list of pending/in_progress tasks from database      │
│ 4. Check: "Is this follow-up already covered?"             │
│ 5. Return only unique follow-ups with full context         │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR PHASE                                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Receive reviewer output with follow_up_tasks            │
│ 2. Check config: followUpTasks.autoImplement               │
│ 3. Create tasks with appropriate status:                   │
│    • autoImplement=true  → status='pending' (work next)    │
│    • autoImplement=false → is_follow_up=1 (deferred)       │
│ 4. Populate description, reference_commit, reference_task  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ TASK SELECTION PHASE                                        │
├─────────────────────────────────────────────────────────────┤
│ • autoImplement=true  → Follow-ups picked like normal      │
│ • autoImplement=false → Follow-ups skipped (need promote)  │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

**1. Duplicate Detection in Reviewer (not Orchestrator)**
- **Why:** Prevents polluting orchestrator context with full task list
- **How:** Reviewer gets pending tasks, checks before suggesting follow-ups
- **Benefit:** Cleaner separation of concerns, reviewer has better context

**2. Rich Context Required**
- **Why:** Follow-up tasks need context to be actionable weeks later
- **What:** Title, description, reference commit, reference task
- **Benefit:** Anyone can understand "why" and "how" when picking up the task

**3. Configuration-Driven Behavior**
- **Why:** Different teams have different workflows
- **Options:** Auto-implement follow-ups OR defer for human approval
- **Default:** Deferred (safer, requires explicit promotion)

## Schema Changes

### 1. Reviewer Output Schema

**Before:**
```typescript
{
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear',
  reasoning: string,
  notes?: string,
  next_status: 'completed' | 'in_progress' | ...,
  metadata: { ... }
}
```

**After:**
```typescript
{
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear',
  reasoning: string,
  notes?: string,
  follow_up_tasks?: Array<{           // NEW
    title: string,                    // Short task title
    description: string,              // Detailed context (what/why/how)
    // reference_commit: auto-populated by orchestrator
    // reference_task_id: auto-populated by orchestrator
  }>,
  next_status: 'completed' | 'in_progress' | ...,
  metadata: { ... }
}
```

### 2. Database Schema

**Migration: Add follow-up context fields**
```sql
-- Add to tasks table
ALTER TABLE tasks ADD COLUMN description TEXT;
ALTER TABLE tasks ADD COLUMN reference_commit TEXT;
ALTER TABLE tasks ADD COLUMN reference_task_id TEXT;
ALTER TABLE tasks ADD COLUMN is_follow_up INTEGER DEFAULT 0;

-- Index for finding follow-ups of a specific task
CREATE INDEX idx_tasks_reference_task ON tasks(reference_task_id);

-- Index for filtering deferred follow-ups
CREATE INDEX idx_tasks_is_follow_up ON tasks(is_follow_up) WHERE is_follow_up = 1;
```

### 3. Configuration Schema

**Add to SteroidsConfig:**
```yaml
followUpTasks:
  autoImplement: false  # Default: require human approval to start work
  scope: 'section'      # Where to create: 'section' | 'project-root'
```

**Global config (`~/.steroids/config.yaml`):**
```yaml
followUpTasks:
  autoImplement: false  # Conservative default for all projects
```

**Project config (`.steroids/config.yaml`):**
```yaml
followUpTasks:
  autoImplement: true   # Override: auto-implement in this project
  scope: 'section'      # Create in same section as parent task
```

## Example End-to-End

### 1. Reviewer Identifies Follow-ups

**Reviewer receives pending tasks:**
```
Existing pending tasks in project:
- "Add comprehensive test suite for Auth module"
- "Refactor CSS to use design tokens"
- "Document API endpoints"
```

**Reviewer considers follow-ups:**
1. "Add unit tests for theme-utils.ts"
   - Check: Covered by "Add comprehensive test suite"? → YES, skip
2. "Document theme configuration format"
   - Check: Covered by existing tasks? → NO, suggest it

**Reviewer output:**
```json
{
  "decision": "approve",
  "reasoning": "Theme engine works correctly; identified follow-up work",
  "notes": "Implementation is solid. Only missing documentation for theme config.",
  "follow_up_tasks": [
    {
      "title": "Document theme configuration format in README",
      "description": "The theme engine expects specific config structure in config.ui_theme but this isn't documented. Need to add:\n\n- Schema documentation (colors, radii, typography, button, card, logo, density)\n- Example configurations for light/dark themes\n- Validation rules and defaults\n- How to test theme changes\n\nSee Auth/src/theme/theme-utils.ts for current implementation details."
    }
  ],
  "next_status": "completed",
  "metadata": {
    "rejection_count": 0,
    "confidence": "high",
    "push_to_remote": true
  }
}
```

### 2. Orchestrator Creates Follow-up Task

**With `autoImplement: false` (default):**
```
[Orchestrator] Reviewer approved with 1 follow-up task
[Orchestrator] Creating follow-up task (deferred)
[Orchestrator] ✓ Task created: "Document theme configuration format in README"
[Orchestrator]   ID: abc-123-def-456
[Orchestrator]   Status: pending
[Orchestrator]   is_follow_up: true (requires promotion)
[Orchestrator]   Reference: e7da26b9 (Build theme engine)
[Orchestrator]   Commit: b0a53ed
```

**Database record:**
```sql
INSERT INTO tasks (
  id, title, description, status, section_id,
  is_follow_up, reference_commit, reference_task_id,
  source_file, created_at
) VALUES (
  'abc-123-def-456',
  'Document theme configuration format in README',
  'The theme engine expects specific config structure in config.ui_theme but this isn''t documented. Need to add:\n\n- Schema documentation (colors, radii, typography, button, card, logo, density)\n- Example configurations for light/dark themes\n- Validation rules and defaults\n- How to test theme changes\n\nSee Auth/src/theme/theme-utils.ts for current implementation details.',
  'pending',
  '1fc395a6-efa3-4704-b8c3-6c6db3ef818e',  -- Same section as parent
  1,  -- is_follow_up
  'b0a53ed3c017839e7b0a3a60f8fe0e625439bacb',
  'e7da26b9-1daf-4a72-8efc-b35368681a0e',
  'Docs/brief.md',
  '2026-02-10 08:15:00'
);
```

### 3. Human Reviews Follow-ups

**CLI:**
```bash
$ steroids tasks --follow-ups

Follow-up Tasks (Deferred):
  abc-123  Document theme configuration format in README  [Phase 9: UI & Theming]

$ steroids tasks show abc-123

Follow-up Task: Document theme configuration format in README
Section: Phase 9: UI & Theming
Status: pending (deferred, requires promotion)

Description:
  The theme engine expects specific config structure in config.ui_theme
  but this isn't documented. Need to add:

  - Schema documentation (colors, radii, typography, button, card, logo, density)
  - Example configurations for light/dark themes
  - Validation rules and defaults
  - How to test theme changes

  See Auth/src/theme/theme-utils.ts for current implementation details.

Context:
  Spawned by: e7da26b9 (Build theme engine: apply colors, radii...)
  Reference commit: b0a53ed
  View diff: git show b0a53ed

Commands:
  steroids tasks promote abc-123         # Enable auto-implementation
  steroids tasks update abc-123 --skip   # Mark as not needed
```

**Promote task:**
```bash
$ steroids tasks promote abc-123
✓ Task promoted to regular status (auto-implementation enabled)
  The orchestrator will now work on this task automatically
```

## CLI Commands

### View Follow-ups

```bash
# List all deferred follow-up tasks
steroids tasks --follow-ups
steroids tasks list --status pending --follow-up

# List follow-ups from a specific task
steroids tasks --follow-ups --reference e7da26b9

# List follow-ups in a section
steroids tasks --follow-ups --section "Phase 9: UI & Theming"
```

### Manage Follow-ups

```bash
# Promote single task (enable auto-implementation)
steroids tasks promote <task-id>

# Promote all follow-ups in section
steroids tasks promote --section "Phase 9: UI & Theming"

# Promote all follow-ups
steroids tasks promote --all-follow-ups

# Skip a follow-up (mark as not needed)
steroids tasks update <task-id> --status skipped

# Convert regular task to follow-up (mark as deferred)
steroids tasks demote <task-id>
```

### View Context

```bash
# Show follow-up with full context
steroids tasks show <task-id>

# View the reference commit
steroids tasks show <task-id> --commit
# (equivalent to: git show <reference_commit>)

# View the parent task
steroids tasks show <task-id> --parent
```

## WebUI Changes

### Task Detail Page

**Add section for follow-up context:**
```
┌─────────────────────────────────────────────────────────────┐
│ 📋 Follow-up Task                                           │
│ Document theme configuration format in README               │
├─────────────────────────────────────────────────────────────┤
│ Status: pending (deferred)                                  │
│ Section: Phase 9: UI & Theming                             │
│ Created: 2026-02-10 08:15:00                               │
│                                                             │
│ Description:                                                │
│ The theme engine expects specific config structure in       │
│ config.ui_theme but this isn't documented. Need to add:    │
│ • Schema documentation (colors, radii, typography...)      │
│ • Example configurations for light/dark themes             │
│ • Validation rules and defaults                            │
│ • How to test theme changes                                │
│                                                             │
│ See Auth/src/theme/theme-utils.ts for implementation.      │
│                                                             │
│ 🔗 Context:                                                │
│ • Spawned by: Build theme engine (e7da26b9) [View Task]   │
│ • Reference: b0a53ed [View Commit] [View Diff]            │
│                                                             │
│ ⚠️  Deferred (requires promotion to start)                 │
│ [Promote to Active] [Mark as Not Needed] [Edit]           │
└─────────────────────────────────────────────────────────────┘
```

### Task List Filters

**Add filter for follow-ups:**
- Show/hide follow-up tasks
- Filter by follow-up status (deferred/promoted)
- Show follow-up badge in task list

### Parent Task Link

**On parent task detail page, show follow-ups:**
```
┌─────────────────────────────────────────────────────────────┐
│ Task: Build theme engine                                    │
│ Status: completed                                           │
│                                                             │
│ Follow-up Tasks (1):                                       │
│ • Document theme configuration format (deferred) [View]    │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Schema & Database (1-2 hours)
- [ ] Update reviewer schema in `src/orchestrator/schemas.ts`
- [ ] Create database migration for new columns
- [ ] Update `createTask()` to accept description + references
- [ ] Add `is_follow_up` flag handling
- [ ] Test migration on sample database

### Phase 2: Reviewer Prompt (1 hour)
- [ ] Update reviewer prompt to explain follow-up tasks
- [ ] Add instructions for duplicate checking
- [ ] Add pending tasks list to reviewer context
- [ ] Add examples of good follow-up task descriptions
- [ ] Test with Claude, Codex, Gemini

### Phase 3: Orchestrator Logic (2-3 hours)
- [ ] Update orchestrator to handle `follow_up_tasks` array
- [ ] Add config loading for `followUpTasks.autoImplement`
- [ ] Implement task creation with context population
- [ ] Handle deferred vs auto-implement logic
- [ ] Add logging for created follow-ups
- [ ] Test with sample reviewer output

### Phase 4: CLI Commands (2-3 hours)
- [ ] Add `--follow-ups` flag to `steroids tasks list`
- [ ] Implement `steroids tasks promote` command
- [ ] Add `--reference` filter for finding follow-ups of a task
- [ ] Update `steroids tasks show` to display follow-up context
- [ ] Add `--commit` and `--parent` flags
- [ ] Test all new commands

### Phase 5: WebUI Updates (2-3 hours)
- [ ] Update task detail component for follow-up display
- [ ] Add promote/demote buttons
- [ ] Add follow-up filter to task list
- [ ] Add follow-up badge/indicator
- [ ] Show follow-ups on parent task page
- [ ] Test UI flows

### Phase 6: Configuration (1 hour)
- [ ] Add `followUpTasks` to config schema
- [ ] Update config loader
- [ ] Add validation
- [ ] Update `steroids config` command
- [ ] Document in README

### Phase 7: Testing & Validation (2-3 hours)
- [ ] Write unit tests for schema validation
- [ ] Write integration tests for task creation
- [ ] Test with all three AI providers (Claude, Codex, Gemini)
- [ ] Test auto-implement vs deferred modes
- [ ] Test duplicate detection in reviewer
- [ ] Test CLI commands
- [ ] Test WebUI flows

### Phase 8: Documentation (1 hour)
- [ ] Update main README with follow-up tasks section
- [ ] Add configuration examples
- [ ] Add CLI command reference
- [ ] Update architecture docs
- [ ] Add migration guide for existing projects

**Total Estimated Time: 12-17 hours**

## Edge Cases & Considerations

### 1. Duplicate Detection False Negatives
**Problem:** Reviewer might miss existing task that covers follow-up
**Solution:**
- Reviewer gets full pending task list with descriptions
- Uses semantic matching, not just title comparison
- When uncertain, reviewer can suggest anyway (orchestrator logs it)

### 2. Follow-up Creates Another Follow-up
**Problem:** Chain of follow-up tasks (A → B → C)
**Solution:**
- Allow it, but track depth (reference_task_id forms a chain)
- CLI command to show follow-up tree
- Limit depth in config? (e.g., max 2 levels deep)

### 3. Reference Commit Gets Rebased/Deleted
**Problem:** reference_commit SHA becomes invalid
**Solution:**
- Store commit message as well for context
- CLI shows warning if commit not found
- Description should be self-contained enough

### 4. Auto-implement Flood
**Problem:** Reviewer creates 10 follow-ups, all run automatically
**Solution:**
- Default to deferred (autoImplement: false)
- Add config for max auto-implement per approval
- Log clearly when follow-ups are created

### 5. Section Deleted
**Problem:** Follow-up references deleted section
**Solution:**
- Follow-up task remains, section_id becomes null
- Shows as "orphaned" in CLI
- Can be reassigned to new section

## Testing Strategy

### Unit Tests
```typescript
describe('Follow-up Tasks', () => {
  it('should validate reviewer schema with follow_up_tasks', () => {
    const validOutput = {
      decision: 'approve',
      reasoning: 'Good work',
      follow_up_tasks: [
        { title: 'Add tests', description: 'Need unit tests for X' }
      ],
      next_status: 'completed',
      metadata: { ... }
    };
    expect(validateReviewerResult(validOutput)).toBe(true);
  });

  it('should create follow-up task with context', () => {
    const followUp = {
      title: 'Add tests',
      description: 'Need unit tests for X'
    };
    const task = createFollowUpTask(db, followUp, {
      parentTaskId: 'parent-123',
      referenceCommit: 'abc123',
      sectionId: 'section-456',
      autoImplement: false
    });
    expect(task.is_follow_up).toBe(1);
    expect(task.reference_task_id).toBe('parent-123');
    expect(task.reference_commit).toBe('abc123');
    expect(task.description).toBe('Need unit tests for X');
  });

  it('should skip follow-up creation if autoImplement=false and is_follow_up=1', () => {
    const task = getNextPendingTask(db);
    // Should not return deferred follow-ups
    expect(task?.is_follow_up).not.toBe(1);
  });
});
```

### Integration Tests
```typescript
describe('Follow-up Tasks Integration', () => {
  it('should create follow-up from reviewer output', async () => {
    const reviewerOutput = {
      decision: 'approve',
      reasoning: 'Good',
      follow_up_tasks: [
        { title: 'Add tests', description: 'Add unit tests' }
      ],
      next_status: 'completed',
      metadata: { ... }
    };

    await processReviewerOutput(db, reviewerOutput, {
      taskId: 'task-123',
      commitSha: 'abc123',
      sectionId: 'section-456'
    });

    const followUps = getFollowUpTasks(db, 'task-123');
    expect(followUps).toHaveLength(1);
    expect(followUps[0].title).toBe('Add tests');
    expect(followUps[0].reference_task_id).toBe('task-123');
  });

  it('should respect autoImplement config', async () => {
    const config = { followUpTasks: { autoImplement: true } };
    // Create follow-up with auto-implement
    const task = await createFollowUpTask(db, followUp, {
      ...options,
      config
    });
    expect(task.is_follow_up).toBe(0); // Not deferred
  });
});
```

### E2E Tests
- Run full orchestrator loop
- Reviewer creates follow-up
- Verify task created with context
- Promote task and verify it's picked up by loop
- Complete follow-up and verify audit trail

## Migration Guide

### For Existing Projects

**1. Update steroids-cli:**
```bash
npm install -g steroids-cli@latest
steroids --version  # Should be >= 0.7.0
```

**2. Migrate database:**
```bash
cd /path/to/project
steroids migrate

# Migration will add:
# - tasks.description
# - tasks.reference_commit
# - tasks.reference_task_id
# - tasks.is_follow_up
```

**3. Configure behavior (optional):**
```bash
# Keep default (deferred follow-ups)
# OR enable auto-implement
steroids config set followUpTasks.autoImplement true
```

**4. Review existing tasks:**
```bash
# Check if any tasks should be marked as follow-ups
steroids tasks list
steroids tasks update <task-id> --follow-up  # Mark as deferred
```

### For New Projects

Follow-up tasks feature is enabled by default. No configuration needed unless you want to change `autoImplement` behavior.

## Future Enhancements

### 1. Smart Duplicate Detection
- Use vector embeddings for semantic task comparison
- Detect duplicates across different wording

### 2. Follow-up Templates
- Predefined templates for common follow-ups
- "Add tests for X", "Document Y", "Refactor Z"

### 3. Batch Operations
- Promote/skip multiple follow-ups at once
- Filter by confidence/priority

### 4. Priority/Urgency
- Reviewer specifies urgency: high/medium/low
- Affects task ordering in auto-implement mode

### 5. Dependencies
- Follow-up task depends on other tasks
- Only promote when dependencies complete

### 6. Follow-up Dashboard
- WebUI view showing all deferred follow-ups
- Group by section, priority, age
- Bulk promote/skip

## Related Files

- `src/orchestrator/schemas.ts` - Reviewer output schema
- `src/prompts/reviewer.ts` - Reviewer prompt
- `src/commands/loop-phases.ts` - Orchestrator task creation logic
- `src/database/queries.ts` - Task creation functions
- `src/config/loader.ts` - Configuration schema
- `migrations/` - Database migrations
- `tests/` - Unit and integration tests

## Questions & Discussion

**Q: Should follow-ups be created in same section or separate section?**
A: Configurable via `followUpTasks.scope`. Default: same section as parent.

**Q: Can coder create follow-up tasks?**
A: Not in initial implementation. Reviewer only, as they have better context for identifying technical debt.

**Q: What if reviewer suggests 20 follow-ups?**
A: Reviewer prompt should encourage judicious use. Orchestrator can log warning if excessive (e.g., > 5).

**Q: Can human manually create follow-up task?**
A: Yes, via CLI: `steroids tasks create "Title" --follow-up --reference <task-id>`

**Q: Should follow-ups affect health score?**
A: Future enhancement. Could track "technical debt ratio" (follow-ups / completed tasks).
