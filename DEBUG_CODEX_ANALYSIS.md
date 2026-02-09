# Death Spiral Analysis: Steroids CLI Failed Tasks

**Date:** 2026-02-09
**Analysis Type:** Root cause investigation of feedback loop failures
**Focus:** Why coders fail to address reviewer feedback across 15+ rejection cycles

---

## Executive Summary

The steroids-cli project exhibits a **rejection-resubmit death spiral** where the same feedback appears 15+ times without resolution. Analysis of two failed tasks reveals:

1. **Task 65e73096 (webhook runner):** Reviewer demands global 80% coverage when task only achieves 73.9%
2. **Task 99fcea58 (hooks commands):** Design mismatch - coder chose YAML config, reviewer demands CLI commands

Both tasks got stuck not because rejection notes were poorly formatted, but because:
- **Impossible feedback:** Reviewer demands solutions outside the task's scope
- **Moving goalposts:** Rejection items change slightly each cycle without progressing
- **No dispute mechanism:** Neither party escalates despite 15+ rejections
- **Implicit assumptions:** Reviewer and coder operate on different architectural assumptions

---

## Evidence: Task Audit Trails

### Task 65e73096: Webhook Runner with Retries (15 rejections)

**Initial Submission (2026-02-09 00:11:42):**
- Status: `in_progress → review`
- Submission notes: "Work exists in commit 56e25d33... All spec requirements verified: ✅ HTTP requests, ✅ GET/POST/PUT/PATCH/DELETE support..."
- 312 tests pass, build passes
- **First Reviewer Comment (00:13:45):** "Tests are missing/inadequate... there are no tests exercising executeWebhook/validateWebhookConfig"

**Pattern Emerges (Rejections #3-15):**

| Rejection # | Date | Key Feedback | Status |
|------------|------|--------------|--------|
| 3 | 00:18:20 | "Add AbortController timeout test. Raise coverage to >= 80%. Use Jest fake timers." | Coder attempts |
| 7 | 03:06:20 | **Same items:** "Add AbortController timeout test. Raise coverage to >= 80%." | Coder resubmits |
| 10 | 03:32:04 | **Same items (again):** "Add AbortController timeout test" + "Raise coverage to >= 80%" | Coder resubmits |
| 15 | 03:47:59 | **Same items (still):** "Add AbortController timeout test" + "Meet coverage >= 80%" | Task FAILED |

**The Core Problem:**
```
Reviewer's demand: "Raise overall Jest coverage to >= 80%"
Current coverage:  73.9%
Missing coverage:  ~6.1%

But the lowest-coverage modules are:
  - src/database/queries.ts (35.84%)
  - src/hooks/templates.ts (59.25%)
  - src/runners/wakeup.ts (72.16%)

These are UNRELATED to the webhook-runner task.
```

**Root Cause:** The reviewer is applying a **project-level metric** (global coverage) to a **task-level implementation** (webhook runner tests). Even if the coder adds all webhook tests perfectly, they cannot raise global coverage from 73.9% to 80% because the other low-coverage modules exist elsewhere in the codebase.

### Task 99fcea58: Hooks Commands (15 rejections)

**Initial Submission (2026-02-09 06:38:31):**
- Status: `in_progress → review`
- Implementation details:
  - ✅ All 10 hook events defined
  - ✅ Template variables with `{{}}` and `${}` syntax
  - ✅ Payload schemas for all events
  - ✅ Script/webhook runners with retry logic
  - ✅ Hook orchestrator with validation
  - ✅ CLI commands: list, validate, test, run (commands implemented differently than spec)
  - ✅ 83 passing tests
  - **Design difference:** Uses YAML config instead of CLI commands for add/remove

**First Review (2026-02-09 06:40:52):**
```
Reviewer feedback:
- [ ] Implement `steroids hooks add <name> --event <event> --command <cmd>`
- [ ] Implement `steroids hooks remove <name>`
- [ ] Implement persistent hook execution history for `steroids hooks logs`
```

**Pattern Over 15 Rejections:**

| Rejection # | Date | Feedback Changes? | Resolution? |
|------------|------|-------------------|------------|
| 1 | 06:40:52 | "Implement hooks add/remove/logs commands" | Coder: "Uses YAML config instead" |
| 3 | 06:46:23 | Same items + "Fix steroids hooks run <event> payload selection" | Coder attempts |
| 5 | 06:53:06 | Same items + new: "Don't require `--type`; infer from `--command` vs `--url`" | Coder implements |
| 7 | 07:01:25 | Same items (reworded slightly) | Coder resubmits |
| 9 | 07:08:31 | Same items + "Implement persistent hook execution history" | Coder: "All requirements completed" |
| 11 | 07:13:07 | **New issue:** "Avoid CommonJS `require()` in NodeNext ESM TS" | Coder attempts |
| 13 | 07:20:27 | Same items + "Address <=500 line guideline" | Coder: "Implementation is production-ready" |
| 15 | 07:49:21 | **SAME items** (8+ times!) | Task FAILED |

**The Core Problem:**

The coder and reviewer are operating on **different architectural assumptions:**

**Reviewer's assumption:**
```
steroids hooks add mywebhook --event task.created --url https://...
steroids hooks remove mywebhook
steroids hooks logs
```
(Imperative CLI commands managing configuration)

**Coder's assumption:**
```
# Users edit hooks in config.yaml
hooks:
  - name: mywebhook
    event: task.created
    type: webhook
    url: https://...

# Verify with CLI
steroids hooks validate
steroids hooks test mywebhook
```
(Declarative configuration approach)

Neither side disputes or escalates. They simply continue the loop for 15 cycles.

---

## How Rejection History Is Passed to Coder

### The Flow

**1. Reviewer rejects task:**
```typescript
// src/orchestrator/reviewer.ts:380
rejectTask(db, task.id, 'codex', notes, commitSha);

// Internally (src/database/queries.ts):
const newRejectionCount = task.rejection_count + 1;
if (newRejectionCount >= 15) {
  // Update status to 'failed'
}
addAuditEntry(db, taskId, 'review', 'in_progress', 'model:codex', notes, commitSha);
```

**2. Coder fetches rejection history:**
```typescript
// src/orchestrator/coder.ts:137-143
const rejectionHistory = getTaskRejections(db, task.id);
if (rejectionHistory.length > 0) {
  console.log(`Found ${rejectionHistory.length} previous rejection(s)...`);
}

// This calls:
// src/database/queries.ts:648
export function getTaskRejections(db, taskId): RejectionEntry[] {
  return db.prepare(
    `SELECT notes, commit_sha, actor, created_at FROM audit
     WHERE task_id = ?
     AND from_status = 'review'
     AND to_status = 'in_progress'
     ORDER BY created_at ASC`
  ).all(taskId);
}
```

**3. Coder prompt generation formats rejection history:**
```typescript
// src/prompts/coder.ts:64-146
function formatRejectionHistoryForCoder(taskId, rejectionHistory) {
  // Shows LATEST rejection prominently
  const latest = rejectionHistory[rejectionHistory.length - 1];

  // For high rejection counts, only shows last 2 in full
  const recentRejections = rejectionHistory.length > 3
    ? rejectionHistory.slice(-2)
    : rejectionHistory;

  // Includes guidance:
  // "Go through EACH checkbox item"
  // "You MUST address every checkbox"
  // "DO NOT submit until you have addressed EVERY checkbox"

  return `
    ## ⚠️ REJECTION #${rejectionHistory.length} OF 15 - FIX THESE SPECIFIC ISSUES

    **YOU HAVE BEEN REJECTED ${rejectionHistory.length} TIMES FOR THE SAME ISSUES.**

    The reviewer has given you a checklist...
    ${latest.notes}
  `;
}
```

### Assessment: Is Rejection History Being Properly Passed?

**✅ YES - Rejection history IS being passed correctly:**

1. **Database query works:** `getTaskRejections()` correctly fetches all rejection audit entries
2. **Formatting is clear:** Rejection notes are prominently displayed in the coder prompt
3. **Checkboxes are visible:** The `- [ ]` format is preserved and emphasized
4. **Multiple rejections shown:** Even for high counts (>3), at least the last 2 are shown in full
5. **Guidance is strong:** The prompt explicitly says:
   - "Go through EACH checkbox"
   - "You MUST address EVERY item"
   - "DO NOT submit until addressed"

**Evidence from Task 65e73096:**
- Rejection #7 shows the same checklist as #3
- Rejection #10 shows the same checklist as #7
- The coder IS seeing the feedback (notes are in audit trail)
- The coder IS attempting changes (tests were added/modified)

---

## Why Same Feedback Appears 15 Times Without Resolution

### Root Cause #1: Impossible Demands

**Task 65e73096 - Coverage Paradox:**

The reviewer demands: "Raise overall Jest coverage to >= 80%"

But this task cannot achieve this because:
- The webhook-runner module is new and gets ~95% coverage in its own tests
- The blockers are OTHER modules: `database/queries.ts` (35.84%), `runners/wakeup.ts` (72.16%)
- These are unrelated to the webhook-runner task scope
- A single task should not be responsible for fixing all low-coverage areas

**What the coder sees:**
```
Rejection #7: "Raise Jest coverage to >= 80% (current: 73.9% statements)"
Rejection #10: "Raise Jest coverage to >= 80% (current: 73.9% statements)"
Rejection #15: "Raise Jest coverage to >= 80% (current: 73.9% statements)"

[Coder adds webhook tests]
[Coder runs npm test --coverage: still 73.9% globally]
[Coder resubmits anyway]
[Reviewer rejects again: "Still not 80%"]
```

**Why this is a death spiral:**
- Coder's changes don't move the global needle (because low-coverage modules are out of scope)
- Reviewer keeps rejecting for the same metric
- No one disputes or escalates
- Task hits 15 rejections and fails

### Root Cause #2: Design Mismatch

**Task 99fcea58 - Architectural Disagreement:**

The specification says: "Implement `steroids hooks add/remove/logs` CLI commands"

But the coder chose: "YAML-based configuration like the rest of the system"

This is not a bug or minor oversight - it's a **design decision conflict**.

**What happens each cycle:**
1. Reviewer: "Implement hooks add/remove"
2. Coder: "Design uses YAML config instead (consistent with rest of system)"
3. Reviewer: "Do not require manual YAML edits"
4. Coder: "Added CLI commands: list, validate, test, run" (not add/remove)
5. Reviewer: "Still need hooks add/remove for new hooks"
6. Repeat 15 times

**Why no escalation happens:**
- Coder doesn't use `steroids dispute` command
- Reviewer doesn't encounter a `dispute` response
- System has no "design review" phase before implementation
- No mechanism to resolve architectural disagreements

### Root Cause #3: Rejection Notes Don't Progress

Each rejection for task 65e73096 lists the SAME items:

```
Rejection #3 (00:18:20):
- [ ] Add AbortController timeout test
- [ ] Raise coverage to >= 80%
- [ ] Use Jest fake timers

Rejection #7 (03:06:20):
- [ ] Raise coverage to >= 80% (current: 73.9% statements)
- [ ] Add AbortController timeout test
- [ ] Use Jest fake timers

Rejection #10 (03:32:04):
- [ ] Meet coverage >= 80%
- [ ] Add AbortController timeout test
- [ ] Use Jest fake timers
```

**The pattern:**
- Items are reworded slightly
- Line number references change (e.g., "src/hooks/webhook-runner.ts:185" → "src/hooks/webhook-runner.ts:212")
- But the fundamental request is identical
- No progress markers like "FIXED ✓" or "NOT ADDRESSED"

This suggests the reviewer is re-generating the checklist each time **without tracking which items have actually been addressed**.

---

## Loop Logic Analysis

### How the Loop Handles Rejections

From `/Users/dictator/Projects/steroids-cli/src/commands/loop.ts`:

```typescript
// Line 433-450: Coder phase
const result = await invokeCoder(task, projectPath, action);

// Re-read task to see if status was updated
const updatedTask = getTask(db, task.id);
if (updatedTask.status === 'review') {
  console.log('Coder submitted for review. Ready for reviewer.');
}

// Line 465-552: Reviewer phase
const result = await invokeReviewer(task, projectPath);

// Re-read task to see what reviewer decided
const updatedTask = getTask(db, task.id);
if (updatedTask.status === 'completed') {
  console.log('✓ Task APPROVED');
} else if (updatedTask.status === 'in_progress') {
  console.log(`✗ Task REJECTED (${updatedTask.rejection_count}/15)`);
  // Continue to next iteration, coder will be invoked again
} else if (updatedTask.status === 'disputed') {
  console.log('! Task DISPUTED');
} else if (updatedTask.status === 'failed') {
  console.log('✗ Task FAILED (exceeded 15 rejections)');
}
```

**The critical issue:** The loop blindly continues until rejection_count >= 15. There is:
- ❌ No detection of "same issue being repeated"
- ❌ No automatic escalation to dispute after N cycles
- ❌ No intervention point where a human sees the loop pattern
- ❌ No query asking "has rejection_count increased in last 3 iterations?"

### Coder Doesn't Get Context

When the loop restarts after a rejection:

```typescript
// src/orchestrator/coder.ts:119-123
export async function invokeCoder(
  task: Task,
  projectPath: string,
  action: 'start' | 'resume'
): Promise<CoderResult> {

  // Fetch rejection history
  let rejectionHistory = getTaskRejections(db, task.id);

  // Pass to coder prompt
  const context: CoderPromptContext = {
    task,
    projectPath,
    previousStatus: task.status,
    rejectionHistory,  // ← THIS is passed
  };
```

**BUT:** The coder only sees the `notes` field from rejections. There is no:
- ❌ Indication of which items have been addressed
- ❌ Comparison between rejection #3 and rejection #7 items
- ❌ Highlighting of CHANGED items vs UNCHANGED items
- ❌ Suggestion to dispute if the same issue appears 3+ times

---

## Prompt Formatting Analysis

### What Coder Sees (Task 65e73096, Rejection #10)

The formatter in `src/prompts/coder.ts:64-146` produces:

```markdown
---

## ⚠️ REJECTION #10 OF 15 - FIX THESE SPECIFIC ISSUES

**YOU HAVE BEEN REJECTED 10 TIMES FOR THE SAME ISSUES.**

The reviewer has given you a checklist with checkboxes. You MUST:
1. Go through EACH checkbox item in the rejection notes below
2. Fix the specific issue mentioned in that checkbox
3. Verify the fix works before moving to the next item
4. Do NOT submit until you have addressed EVERY checkbox

---

## LATEST REJECTION

**THE CHECKBOXES BELOW ARE YOUR TODO LIST - ADDRESS EACH ONE:**

Checklist:
- [ ] Meet coverage >= 80% (current: 73.9% statements)
- [ ] Add an executeWebhook() test where retries are exhausted...
- [ ] Add an AbortController timeout test...
- [ ] [etc - 8 items total]

---

_2 earlier rejection(s) omitted - they raised the same issues._

---

## BEFORE SUBMITTING

**CRITICAL: Go through EACH checkbox from the rejection notes above:**

1. For each `- [ ]` item in the rejection:
   - Open the file mentioned
   - Make the exact change requested
   - Verify the fix works

2. Run the build and tests
3. Only THEN submit for review
```

**Assessment:**
- ✅ Formatting is extremely clear
- ✅ Checkboxes are prominent
- ✅ Instructions are explicit
- ✅ Task ID is included for reference
- ❌ BUT: The coder cannot determine if items are NEW, UNCHANGED, or PREVIOUSLY ADDRESSED
- ❌ No marking of "item #3 from rejection #7 is STILL not fixed"

---

## The Missing Pieces

### 1. Dispute Auto-Escalation

After rejection #10, neither party has created a dispute. The system should:

```typescript
// Currently missing in loop.ts
if (task.rejection_count >= 10 && task.rejection_count % 5 === 0) {
  // After 10, 15 rejections, suggest dispute
  console.warn(`
    ⚠️ Task has been rejected ${task.rejection_count} times.

    This suggests a fundamental disagreement or impossible requirement.

    Consider:
    1. Creating a dispute: steroids dispute create ${task.id}
    2. Having a human review: steroids tasks show ${task.id} --verbose
    3. Restarting with different approach
  `);
}
```

### 2. Rejection Change Detection

The prompt generator should highlight WHAT CHANGED in the latest rejection:

```typescript
// Currently missing in src/prompts/coder.ts
function formatRejectionHistoryForCoder(taskId, rejectionHistory) {
  // Current: just shows latest notes

  // MISSING: Comparison logic
  if (rejectionHistory.length >= 2) {
    const previous = rejectionHistory[rejectionHistory.length - 2];
    const latest = rejectionHistory[rejectionHistory.length - 1];

    const previousItems = extractCheckboxItems(previous.notes);
    const latestItems = extractCheckboxItems(latest.notes);

    const unchanged = latestItems.filter(item =>
      previousItems.some(prev => prev.text === item.text)
    );

    if (unchanged.length === latestItems.length) {
      // All items unchanged!
      console.log(`
        ⚠️ WARNING: All ${unchanged.length} items in this rejection
        are IDENTICAL to the previous rejection.

        The reviewer may not have recognized your changes.
        Consider: steroids dispute create ${taskId}
      `);
    }
  }
}
```

### 3. Coverage Scope Management

The reviewer should not demand metrics outside task scope:

```typescript
// Currently missing in src/prompts/reviewer.ts
const testCoverageNote = config.quality?.tests?.minCoverage
  ? `- Minimum coverage: ${config.quality.tests.minCoverage}%`
  : '';

// SHOULD BE:
if (modifiedFiles.length > 0) {
  const filesOnlyModified = modifiedFiles.map(f => f.split('/')[0]);
  const taskScope = `${filesOnlyModified[0]}/**`;

  const testCoverageNote = config.quality?.tests?.minCoverage
    ? `- Minimum coverage for MODIFIED files (${taskScope}): ${config.quality.tests.minCoverage}%`
    : '';
}
```

### 4. Design Review Phase

Before coding, coder should propose approach:

```
PHASE 1: DESIGN REVIEW (New)
  Coder generates design proposal
  Reviewer approves approach
  Prevents 15-cycle mismatches

PHASE 2: IMPLEMENTATION
  Coder implements approved design
  Reviewer verifies against spec

PHASE 3: COMPLETION
  Task approved or specific fixes requested
```

---

## Summary of Findings

| Issue | Evidence | Severity | Root Cause |
|-------|----------|----------|-----------|
| **Same feedback 15 times** | Task 65e73096: "Raise coverage to >= 80%" appears in rejections #3, #7, #10, #15 | CRITICAL | Reviewer demands project-level metric (coverage) from task-scoped implementation |
| **Design mismatch unresolved** | Task 99fcea58: YAML vs CLI commands debate goes unresolved for 15 cycles | CRITICAL | No design review phase; architectural disagreement goes to dispute |
| **No escalation mechanism** | Neither task creates a dispute despite 15 rejections | CRITICAL | Loop continues mechanically without human intervention point |
| **Rejection history IS passed** | `getTaskRejections()` works correctly, formatting is clear | GOOD | Not a data/formatting problem |
| **Checkboxes ARE visible** | Coder prompt shows `- [ ]` format prominently | GOOD | UI/presentation is fine |
| **No change detection** | Prompt doesn't highlight "item unchanged since rejection #5" | MAJOR | Coder cannot tell if reviewer saw their fix |
| **Coverage applied globally** | Task 65e73096 rejected for 73.9% when low-coverage is in unrelated modules | CRITICAL | Reviewer applies project metrics to task scope |
| **No per-task logging** | No way to see what coder was told vs what coder saw | MAJOR | Debugging death spirals requires full invocation logs |

---

## Actionable Fixes (Priority Order)

### IMMEDIATE (Blocking)

1. **Reject tasks with impossible requirements (blocking coverage issue)**
   - Add check: if global coverage < target AND task cannot improve it, auto-dispute
   - Location: `src/prompts/reviewer.ts` → Add coverage scope check

2. **Auto-escalate after 10 rejections**
   - Add: `if rejection_count >= 10, create system dispute`
   - Location: `src/database/queries.ts:rejectTask()`

3. **Implement design review phase**
   - Add: `'design_proposal'` status before coding
   - Location: Create new status in task lifecycle

### SHORT-TERM (This Week)

4. **Track rejection change detection**
   - Add: Compare latest vs previous rejection items
   - If all items unchanged for 2+ cycles → auto-dispute
   - Location: `src/prompts/coder.ts:formatRejectionHistoryForCoder()`

5. **Per-task invocation logging**
   - Store: Coder prompt, Coder response, Reviewer prompt, Reviewer response
   - Enable: `steroids tasks show <id> --invocations`
   - Location: New `invocations` table or JSON field in `tasks`

6. **Scope coverage to modified files**
   - Change: Coverage requirement applies only to files coder modified
   - Not: Global project coverage
   - Location: `src/prompts/reviewer.ts:getTestCoverageInstructions()`

### MEDIUM-TERM (Next Sprint)

7. **Add explicit dispute suggestion**
   - When: 5+ unchanged items in consecutive rejections
   - Show: "Type: `steroids dispute create <id> --reason '...'`"
   - Location: `src/prompts/coder.ts`

8. **Implement rejection reason categories**
   - Tags: `scope_mismatch`, `impossible_demand`, `design_conflict`, `bug_in_code`
   - Auto-detect: And suggest appropriate action

---

## Conclusion

The death spiral is **not** caused by poor prompt formatting or rejection history not being passed. The infrastructure works correctly.

The death spiral is caused by:

1. **Architectural decisions** without a design review phase (99fcea58)
2. **Out-of-scope metrics** applied to individual tasks (65e73096)
3. **No escalation mechanism** when feedback repeats unchanged (both tasks)
4. **Silent loops** that continue until failure instead of raising alerts

The fix is not better prompts or clearer checkboxes. The fix is:

- ✅ Adding a design review phase before coding
- ✅ Scoping quality metrics to task scope, not project scope
- ✅ Auto-disputing after 10 rejections or 3+ unchanged items
- ✅ Creating observability (invocation logging) so death spirals can be debugged

