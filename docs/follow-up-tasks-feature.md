# Follow-up Tasks Feature

## Problem Statement

When a reviewer approves work but identifies non-blocking improvements or future enhancements, they currently can only add freeform notes. These notes are unstructured and don't become actionable tasks, causing technical debt to be lost.

**Current limitations:**
- Notes disappear into history
- No way to track identified technical debt
- Manual intervention required to create follow-up tasks
- Context is lost (what code? which commit? why needed?)

## Solution Overview

Enable reviewers to create **structured follow-up tasks** with rich context when approving work. These tasks are:

1. Created automatically by the orchestrator
2. Include detailed descriptions and context
3. Link back to the originating commit and task
4. Can be deferred (require human approval) or auto-implemented
5. Deduplicated to prevent redundant work

**Critical Design Principle:** Follow-ups are OPTIONAL. Most approvals should have zero follow-ups. Only genuine technical debt or valuable improvements should become follow-up tasks.

## Architecture

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ REVIEWER PHASE                                              │
├─────────────────────────────────────────────────────────────┤
│ 1. Review completed work                                    │
│ 2. Identify potential follow-up tasks (if any)             │
│ 3. GET list of existing tasks (pending, deferred, recent)  │
│ 4. Check: "Is this follow-up already covered?"             │
│ 5. Return 0-3 unique follow-ups with full context          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR PHASE                                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Validate reviewer output (max 3, min lengths, etc.)     │
│ 2. Check depth limit (prevent infinite chains)             │
│ 3. Deduplicate against existing tasks                      │
│ 4. Check pending task cap (prevent backlog explosion)      │
│ 5. Create tasks with appropriate state                     │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ TASK SELECTION PHASE                                        │
├─────────────────────────────────────────────────────────────┤
│ • Deferred follow-ups: Skipped until promoted              │
│ • Active follow-ups: Picked like normal tasks              │
└─────────────────────────────────────────────────────────────┘
```

### State Machine

```
Follow-up Task States:

DEFERRED (requires_promotion=true)
  ↓ (human promotes via CLI)
ACTIVE (requires_promotion=false)
  ↓ (auto-selected by loop)
IN_PROGRESS → COMPLETED

Note: is_follow_up flag is IMMUTABLE (never changes after creation)
```

## Schema Changes

### 1. Reviewer Output Schema

```typescript
{
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear',
  reasoning: string,  // min 20 chars
  notes?: string,     // optional
  follow_up_tasks?: Array<{      // OPTIONAL (empty/missing is valid)
    title: string,               // 10-100 chars
    description: string,         // 100-4000 chars, must explain WHAT/WHY/HOW
  }>,  // MAX 3 items
  next_status: 'completed' | 'in_progress' | 'disputed' | 'skipped',
  metadata: {
    rejection_count: number,
    confidence: 'high' | 'medium' | 'low',
    push_to_remote: boolean
  }
}
```

**Validation Rules:**
- `follow_up_tasks` is optional - absence or empty array is valid
- Maximum 3 follow-ups per approval (hard limit)
- Title: 10-100 characters
- Description: 100-4000 characters (forces detailed context)
- Description must include actionable details (files, reasoning, approach)

### 2. Database Schema

```sql
-- Add follow-up context fields
ALTER TABLE tasks ADD COLUMN description TEXT CHECK(length(description) <= 4000);
ALTER TABLE tasks ADD COLUMN reference_commit TEXT;
ALTER TABLE tasks ADD COLUMN reference_commit_message TEXT;
ALTER TABLE tasks ADD COLUMN reference_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN is_follow_up INTEGER NOT NULL DEFAULT 0 CHECK(is_follow_up IN (0, 1));
ALTER TABLE tasks ADD COLUMN requires_promotion INTEGER NOT NULL DEFAULT 0 CHECK(requires_promotion IN (0, 1));
ALTER TABLE tasks ADD COLUMN follow_up_depth INTEGER NOT NULL DEFAULT 0 CHECK(follow_up_depth >= 0);
ALTER TABLE tasks ADD COLUMN dedupe_key TEXT;

-- Indexes
CREATE INDEX idx_tasks_reference_task ON tasks(reference_task_id) WHERE reference_task_id IS NOT NULL;
CREATE INDEX idx_tasks_follow_up_state ON tasks(is_follow_up, requires_promotion) WHERE is_follow_up = 1;
CREATE UNIQUE INDEX idx_tasks_dedupe ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_tasks_selection ON tasks(status, is_follow_up, requires_promotion);
```

**Key Fields:**
- `description`: Full context for follow-up (what/why/how)
- `reference_commit`: SHA of commit that spawned this follow-up
- `reference_commit_message`: Commit message (survives rebases)
- `reference_task_id`: Parent task that spawned this follow-up
- `is_follow_up`: Immutable flag indicating this is a follow-up
- `requires_promotion`: Whether task needs human approval before auto-implementation
- `follow_up_depth`: Chain depth (0 = original task, 1 = direct follow-up, 2 = follow-up of follow-up)
- `dedupe_key`: Normalized title + reference for deduplication

### 3. Configuration Schema

```yaml
followUpTasks:
  # Core behavior
  autoImplement: false              # Default: deferred (requires promotion)
  scope: 'section'                  # Where to create: 'section' | 'project-root'

  # Limits (prevent runaway task generation)
  maxPerApproval: 3                 # Hard cap per approval
  maxDepth: 2                       # Prevent infinite chains (0 = original, 1 = follow-up, 2 = follow-up of follow-up)
  maxPendingTasks: 50               # Cap pending backlog (applies when autoImplement=true)

  # Validation
  minDescriptionLength: 100         # Force detailed descriptions
  requireAcceptanceCriteria: true   # Require "WHAT/WHY/HOW" in description

  # Deduplication
  duplicateCheckScope: 'section'    # Check duplicates in: 'section' | 'project' | 'recent-20'
```

**Config Precedence:** defaults < global < project < environment

## Example End-to-End

### 1. Reviewer Identifies Follow-ups

**Reviewer receives:**
```
Task: "Build theme engine: apply colors, radii, button styles"
Status: Completed

Existing tasks (for duplicate checking):
- Pending: "Add comprehensive test suite for Auth module"
- Pending: "Refactor CSS to use design tokens"
- Deferred: "Document API endpoints"
```

**Reviewer considers:**
1. "Add unit tests for theme-utils.ts"
   → Check: Covered by "Add comprehensive test suite"?
   → Analysis: Different scope (theme vs Auth), suggest it
2. "Document theme configuration format"
   → Check: Covered by existing tasks?
   → Analysis: Not covered, suggest it

**Reviewer output:**
```json
{
  "decision": "approve",
  "reasoning": "Theme engine works correctly; two follow-ups for completeness",
  "follow_up_tasks": [
    {
      "title": "Add unit tests for theme-utils.ts color validation",
      "description": "WHAT: Add unit tests for validateColorFormat() and normalizeColor() in Auth/src/theme/theme-utils.ts\n\nWHY: These functions handle user input and could fail silently with invalid colors. Need validation coverage before adding more theme features.\n\nHOW: Test cases should cover: valid hex colors (#RGB, #RRGGBB), invalid formats, edge cases (empty, null, wrong type), and normalized output format. See existing pattern in Auth/src/theme/__tests__/"
    },
    {
      "title": "Document theme configuration in README",
      "description": "WHAT: Add theme configuration section to Auth/README.md documenting config.ui_theme structure\n\nWHY: The theme engine expects specific config structure but this isn't documented anywhere. Developers need to know available options and validation rules.\n\nHOW: Document: colors (primary, secondary, etc.), radii, typography, button/card styles, logo, density. Include example config and link to theme-utils.ts for implementation details."
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

### 2. Orchestrator Processes Follow-ups

**With `autoImplement: false` (default):**

```
[Orchestrator] Validating reviewer output...
[Orchestrator] ✓ 2 follow-ups (within limit of 3)
[Orchestrator] ✓ Titles and descriptions valid

[Orchestrator] Checking depth limit...
[Orchestrator] Parent task depth: 0 (original task)
[Orchestrator] Follow-up depth will be: 1 (within limit of 2)

[Orchestrator] Deduplicating...
[Orchestrator] ✓ No duplicates found

[Orchestrator] Checking pending task cap...
[Orchestrator] Current pending: 12 (limit: 50)
[Orchestrator] ✓ Within limit

[Orchestrator] Creating 2 deferred follow-up tasks...
[Orchestrator] ✓ Created: "Add unit tests for theme-utils.ts color validation"
[Orchestrator]   ID: abc-123
[Orchestrator]   Status: pending
[Orchestrator]   requires_promotion: true (deferred)
[Orchestrator]   Reference: e7da26b9 (Build theme engine)
[Orchestrator]   Commit: b0a53ed
[Orchestrator] ✓ Created: "Document theme configuration in README"
[Orchestrator]   ID: abc-124
[Orchestrator]   Status: pending
[Orchestrator]   requires_promotion: true (deferred)
[Orchestrator]   Reference: e7da26b9 (Build theme engine)
[Orchestrator]   Commit: b0a53ed
```

### 3. Human Reviews Follow-ups

```bash
$ steroids tasks --follow-ups

Deferred Follow-up Tasks (require promotion):
  abc-123  Add unit tests for theme-utils.ts color validation  [Phase 9: UI & Theming]
  abc-124  Document theme configuration in README               [Phase 9: UI & Theming]

$ steroids tasks show abc-123

Follow-up Task: Add unit tests for theme-utils.ts color validation
Section: Phase 9: UI & Theming
Status: pending (deferred, requires promotion)

Description:
  WHAT: Add unit tests for validateColorFormat() and normalizeColor() in
  Auth/src/theme/theme-utils.ts

  WHY: These functions handle user input and could fail silently with invalid
  colors. Need validation coverage before adding more theme features.

  HOW: Test cases should cover: valid hex colors (#RGB, #RRGGBB), invalid
  formats, edge cases (empty, null, wrong type), and normalized output format.
  See existing pattern in Auth/src/theme/__tests__/

Context:
  Spawned by: e7da26b9 (Build theme engine: apply colors, radii...)
  Reference commit: b0a53ed
  Depth: 1 (direct follow-up)

Commands:
  steroids tasks promote abc-123  # Enable auto-implementation

$ steroids tasks promote abc-123
✓ Task promoted (auto-implementation enabled)
  The orchestrator will now work on this task automatically
```

## CLI Commands

### View Follow-ups

```bash
# List all deferred follow-up tasks
steroids tasks --follow-ups
steroids tasks list --follow-ups

# List follow-ups from a specific task
steroids tasks --follow-ups --reference e7da26b9

# List follow-ups in a section
steroids tasks --follow-ups --section "Phase 9: UI & Theming"

# Show full context
steroids tasks show <task-id>

# View reference commit
steroids tasks show <task-id> --commit
```

### Manage Follow-ups

```bash
# Promote (enable auto-implementation)
steroids tasks promote <task-id>
steroids tasks promote --section "Phase 9"
steroids tasks promote --all

# Skip (mark as not needed)
steroids tasks skip <task-id>
```

## Reviewer Prompt Requirements

The reviewer prompt MUST include these explicit instructions to prevent death spirals:

### 1. "Zero is Okay" Permission

```
CRITICAL: Follow-up tasks are OPTIONAL. Only suggest them when you identify:
1. Genuine technical debt that wasn't in the task scope
2. Future improvements that would add significant value
3. Non-blocking issues discovered during review

DO NOT suggest follow-ups just to be thorough or complete.
Most approvals should have ZERO follow-ups.

If you cannot identify a meaningful follow-up that would take >30 minutes
to implement and provides clear value, DO NOT suggest one.
```

### 2. Non-Blocking Criteria

```
FOLLOW-UPS MUST BE NON-BLOCKING

A follow-up is NON-BLOCKING if ALL of these are true:
✓ The code works correctly as implemented
✓ Tests pass (if they exist)
✓ No security vulnerabilities introduced
✓ No data loss or corruption possible
✓ The improvement would enhance quality but isn't required for deployment

If an issue is BLOCKING, you must REJECT the task (not create a follow-up).

Examples of NON-BLOCKING follow-ups:
- Adding more comprehensive tests where basic tests exist
- Refactoring for readability (if code is functional)
- Performance optimizations (if current performance is acceptable)
- Documentation improvements
- Extracting hardcoded values to config (if unlikely to change)

Examples of BLOCKING issues (REJECT instead):
- Missing critical functionality from task requirements
- Security vulnerabilities
- Data corruption risks
- Test failures
- Required functionality not working
```

### 3. Duplicate Detection Rules

```
DUPLICATE DETECTION (check before suggesting):

Before suggesting a follow-up, check if it's covered by existing tasks:
- Existing pending tasks (provided below)
- Existing deferred follow-ups (provided below)
- Recently completed tasks (last 10, provided below)

Rules:
1. Check if task titles contain >60% of the same keywords
2. Check if task descriptions mention the same files/modules
3. If BOTH are true → SKIP (it's a duplicate)
4. If unsure → SUGGEST (orchestrator will check again)
```

### 4. Description Requirements

```
FOLLOW-UP DESCRIPTION REQUIREMENTS:

Each follow-up MUST include (minimum 100 characters):
1. WHAT: Specific work to be done (files, modules, functions)
2. WHY: Reason it's needed (technical debt, missing functionality, etc.)
3. HOW: Suggested approach or implementation hints

Example GOOD follow-up:
{
  "title": "Add error handling tests for theme-utils.ts",
  "description": "WHAT: Add unit tests for error cases in validateColorFormat()
  and normalizeColor() functions in Auth/src/theme/theme-utils.ts\n\n
  WHY: Current tests only cover happy paths. Need to verify graceful handling
  of invalid inputs before production use.\n\n
  HOW: Test invalid hex formats, null/undefined, wrong types, and malformed
  objects. Use existing test pattern in theme-utils.test.ts"
}

Example BAD follow-up (too vague):
{
  "title": "Add tests",
  "description": "Need more tests for theme stuff"
}
```

### 5. Limits

```
LIMITS:
- Maximum 3 follow-ups per approval (strict)
- If you identify >3, prioritize the most impactful
- Combine related follow-ups into a single task if possible
```

## Orchestrator Safeguards

### 1. Validation

```typescript
// Validate reviewer output
function validateReviewerOutput(output: unknown): ReviewerOutput {
  // Schema validation
  const validated = ReviewerOutputSchema.parse(output);

  // Enforce limits
  if (validated.follow_up_tasks && validated.follow_up_tasks.length > 3) {
    throw new ValidationError('Maximum 3 follow-ups per approval');
  }

  // Validate descriptions
  validated.follow_up_tasks?.forEach(task => {
    if (task.description.length < 100) {
      throw new ValidationError(`Description too short: ${task.title}`);
    }
    if (!containsWhatWhyHow(task.description)) {
      throw new ValidationError(`Description must include WHAT/WHY/HOW: ${task.title}`);
    }
  });

  return validated;
}
```

### 2. Depth Limiting

```typescript
// Check depth before creating follow-up
function checkDepthLimit(db: Database, parentTaskId: string, config: Config): void {
  const depth = getFollowUpDepth(db, parentTaskId);
  const maxDepth = config.followUpTasks?.maxDepth ?? 2;

  if (depth >= maxDepth) {
    throw new DepthLimitError(
      `Follow-up depth limit reached (${depth}/${maxDepth}). ` +
      `Cannot create follow-up of follow-up of follow-up.`
    );
  }
}

function getFollowUpDepth(db: Database, taskId: string): number {
  let depth = 0;
  let currentId = taskId;

  while (currentId && depth < 10) { // Safety limit
    const task = db.prepare('SELECT reference_task_id, is_follow_up FROM tasks WHERE id = ?').get(currentId);
    if (!task?.is_follow_up) break;
    currentId = task.reference_task_id;
    depth++;
  }

  return depth;
}
```

### 3. Deduplication

```typescript
// Deduplicate before creating
function deduplicateFollowUp(db: Database, followUp: FollowUpTask, referenceTaskId: string): boolean {
  // Generate dedupe key
  const dedupeKey = generateDedupeKey(followUp.title, referenceTaskId);

  // Check if exists
  const existing = db.prepare(
    'SELECT id, title FROM tasks WHERE dedupe_key = ?'
  ).get(dedupeKey);

  if (existing) {
    logWarning(`Skipping duplicate follow-up: "${followUp.title}"`);
    logWarning(`  Similar to existing task: ${existing.id} "${existing.title}"`);
    return false; // Skip creation
  }

  return true; // Proceed with creation
}

function generateDedupeKey(title: string, referenceTaskId: string): string {
  // Normalize: lowercase, remove punctuation, stem words
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3)
    .sort()
    .join('-');

  return `${referenceTaskId}:${normalized}`;
}
```

### 4. Pending Task Cap

```typescript
// Check pending task limit (prevents backlog explosion)
function checkPendingTaskLimit(db: Database, config: Config): void {
  if (!config.followUpTasks?.autoImplement) {
    return; // Deferred tasks don't add to pending immediately
  }

  const pendingCount = db.prepare(
    'SELECT COUNT(*) as count FROM tasks WHERE status = ? AND requires_promotion = 0'
  ).get('pending').count;

  const maxPending = config.followUpTasks?.maxPendingTasks ?? 50;

  if (pendingCount >= maxPending) {
    logWarning(`Pending task limit reached (${pendingCount}/${maxPending})`);
    logWarning('Skipping follow-up creation to prevent backlog explosion');
    logWarning('Configure followUpTasks.maxPendingTasks to change this limit');
    throw new PendingLimitError('Pending task cap reached');
  }
}
```

### 5. Monitoring

```typescript
// Monitor follow-up creation rate
function monitorFollowUpRate(db: Database): void {
  const hourAgo = new Date(Date.now() - 3600000).toISOString();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_follow_up = 1 THEN 1 ELSE 0 END) as follow_ups
    FROM tasks
    WHERE created_at > ?
  `).get(hourAgo);

  if (stats.total > 0) {
    const ratio = stats.follow_ups / stats.total;

    if (ratio > 0.5) {
      logWarning('⚠️  Follow-up creation rate is high (>50% of recent tasks)');
      logWarning('   Consider:');
      logWarning('     - Setting followUpTasks.autoImplement=false (defer for human review)');
      logWarning('     - Reducing followUpTasks.maxPerApproval');
      logWarning('     - Reviewing reviewer prompt for "always suggest" bias');
    }
  }
}
```

## Task Selection Logic

```typescript
// Get next task (skip deferred follow-ups)
function getNextPendingTask(db: Database): Task | null {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND (requires_promotion = 0 OR is_follow_up = 0)  -- Skip deferred follow-ups
    AND (section_id IS NULL OR section_id IN (SELECT id FROM sections))  -- Valid section or root
    ORDER BY created_at ASC
    LIMIT 1
  `).get();
}
```

## Migration Guide

### For Existing Projects

```bash
# 1. Update CLI
npm install -g steroids-cli@latest
steroids --version  # Should be >= 0.7.0

# 2. Migrate database (adds new columns)
cd /path/to/project
steroids migrate

# 3. Configure (optional, defaults are conservative)
steroids config set followUpTasks.autoImplement false  # Default
steroids config set followUpTasks.maxDepth 2           # Default
steroids config set followUpTasks.maxPerApproval 3     # Default
```

### Migration SQL

```sql
-- 001_add_follow_up_fields.sql
BEGIN TRANSACTION;

ALTER TABLE tasks ADD COLUMN description TEXT CHECK(length(description) <= 4000);
ALTER TABLE tasks ADD COLUMN reference_commit TEXT;
ALTER TABLE tasks ADD COLUMN reference_commit_message TEXT;
ALTER TABLE tasks ADD COLUMN reference_task_id TEXT;
ALTER TABLE tasks ADD COLUMN is_follow_up INTEGER NOT NULL DEFAULT 0 CHECK(is_follow_up IN (0, 1));
ALTER TABLE tasks ADD COLUMN requires_promotion INTEGER NOT NULL DEFAULT 0 CHECK(requires_promotion IN (0, 1));
ALTER TABLE tasks ADD COLUMN follow_up_depth INTEGER NOT NULL DEFAULT 0 CHECK(follow_up_depth >= 0);
ALTER TABLE tasks ADD COLUMN dedupe_key TEXT;

CREATE INDEX idx_tasks_reference_task ON tasks(reference_task_id) WHERE reference_task_id IS NOT NULL;
CREATE INDEX idx_tasks_follow_up_state ON tasks(is_follow_up, requires_promotion) WHERE is_follow_up = 1;
CREATE UNIQUE INDEX idx_tasks_dedupe ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_tasks_selection ON tasks(status, is_follow_up, requires_promotion);

COMMIT;
```

## Implementation Checklist

### Phase 1: Core Schema & Validation (2-3 hours)
- [ ] Update reviewer schema in `src/orchestrator/schemas.ts`
  - [ ] Add `follow_up_tasks` array (max 3)
  - [ ] Add validation: title 10-100 chars, description 100-4000 chars
- [ ] Create database migration
  - [ ] Add columns: description, reference_*, is_follow_up, requires_promotion, follow_up_depth, dedupe_key
  - [ ] Add indexes
- [ ] Update `createTask()` to accept new fields
- [ ] Test migration on sample database

### Phase 2: Orchestrator Logic (3-4 hours)
- [ ] Implement depth checking (`getFollowUpDepth()`, `checkDepthLimit()`)
- [ ] Implement deduplication (`generateDedupeKey()`, `deduplicateFollowUp()`)
- [ ] Implement pending task cap check (`checkPendingTaskLimit()`)
- [ ] Implement validation (`validateReviewerOutput()`, `containsWhatWhyHow()`)
- [ ] Implement monitoring (`monitorFollowUpRate()`)
- [ ] Add config loading for `followUpTasks` section
- [ ] Integrate into reviewer phase
- [ ] Add comprehensive logging

### Phase 3: Reviewer Prompt (1-2 hours)
- [ ] Add "zero is okay" section
- [ ] Add non-blocking criteria with examples
- [ ] Add duplicate detection rules
- [ ] Add description requirements (WHAT/WHY/HOW)
- [ ] Add limits (max 3)
- [ ] Add existing tasks context injection
- [ ] Test prompt with all three providers (Claude, Codex, Gemini)

### Phase 4: Task Selection (1 hour)
- [ ] Update `getNextPendingTask()` to skip `requires_promotion=1`
- [ ] Centralize eligibility logic
- [ ] Test deferred tasks are skipped
- [ ] Test promoted tasks are selected

### Phase 5: CLI Commands (2-3 hours)
- [ ] Implement `steroids tasks --follow-ups`
- [ ] Implement `steroids tasks promote <id>`
- [ ] Implement `steroids tasks promote --section <name>`
- [ ] Update `steroids tasks show` to display follow-up context
- [ ] Add `--commit` flag to show reference commit
- [ ] Test all commands

### Phase 6: Configuration (1 hour)
- [ ] Add `followUpTasks` to config schema
- [ ] Add validation for config values
- [ ] Update `steroids config` command
- [ ] Add warning when `autoImplement=true`
- [ ] Document in README

### Phase 7: Testing (3-4 hours)
- [ ] Unit tests for validation
- [ ] Unit tests for depth checking
- [ ] Unit tests for deduplication
- [ ] Integration tests for task creation
- [ ] Test with all three providers (Claude, Codex, Gemini)
- [ ] Test edge cases (max limit, depth limit, pending cap)
- [ ] Test deferred vs active workflows

### Phase 8: Documentation (1-2 hours)
- [ ] Update main README
- [ ] Add configuration examples
- [ ] Update CLI reference
- [ ] Update architecture docs

**Total Estimated Time: 14-21 hours**

## Future Enhancements

### Smart Duplicate Detection
- Use vector embeddings for semantic comparison
- Detect duplicates across different wording

### Priority/Urgency
- Reviewer specifies urgency: high/medium/low
- Affects task ordering in auto-implement mode

### Dependencies
- Follow-up depends on other tasks
- Only promote when dependencies complete

### Follow-up Dashboard
- WebUI view showing all deferred follow-ups
- Group by section, age, depth
- Bulk promote/skip operations
