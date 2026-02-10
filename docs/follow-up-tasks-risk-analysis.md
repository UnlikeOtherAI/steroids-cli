# Follow-up Tasks Feature - Risk Analysis

**Status:** Preliminary analysis from Codex review (in progress)
**Reviewers:** Codex (partial), Claude (pending), Gemini (pending)
**Date:** 2026-02-10

---

## Executive Summary

Based on Codex's preliminary review, several **HIGH-risk** issues have been identified that could cause death spirals, rejection loops, or ambiguous behavior. The design needs safeguards before implementation.

---

## HIGH-RISK ISSUES

### 1. Ambiguous `is_follow_up` Semantics
**Risk Level: HIGH**

**Problem:**
- Task has `status='pending'` but also `is_follow_up=1` (deferred)
- Unclear which takes precedence in task selection logic
- Could cause selection bugs where deferred tasks are picked up

**Scenario:**
```sql
-- Confusing state: pending but deferred?
{
  status: 'pending',
  is_follow_up: 1  -- Deferred, needs promotion
}
```

**Fix:**
- Add separate `follow_up_state` enum column: `deferred` | `active` | `null`
- Or add `requires_promotion` boolean
- Make task selection logic explicit: skip tasks with `is_follow_up=1` unless promoted

### 2. Reviewer "Always Find Improvements" Death Spiral
**Risk Level: HIGH**

**Problem:**
- Reviewers have natural bias to suggest improvements
- Vague prompt: "identify follow-up tasks" → reviewer always finds something
- Could create 5+ follow-ups on every approval
- `autoImplement=true` → infinite task generation

**Scenario:**
```
Iteration 1: Complete Task A → 5 follow-ups created
Iteration 2: Complete follow-up 1 → 4 more follow-ups created
Iteration 3: Complete follow-up 2 → 3 more follow-ups created
... (never-ending spiral)
```

**Fixes:**
1. **Explicit "zero is okay" instruction in prompt:**
   ```
   IMPORTANT: Only suggest follow-ups if they provide REAL VALUE.
   - If the work is complete and high-quality, return empty array.
   - "Nice to have" improvements are NOT follow-ups.
   - Output: follow_up_tasks: []  // Explicitly okay!
   ```

2. **Max limit validation:**
   - Hard cap: Max 5 follow-ups per approval (schema validation)
   - Warning if > 3 follow-ups
   - Prompt should encourage 0-2 follow-ups typical

3. **Require justification:**
   - Add `justification` field to each follow-up
   - Forces reviewer to explain why it's needed

### 3. Infinite Follow-up Chains
**Risk Level: HIGH**

**Problem:**
- Follow-up A creates follow-up B, which creates follow-up C...
- No depth limit specified
- Could exhaust task backlog with meta-work

**Scenario:**
```
Task: "Add auth feature"
  └─> Follow-up: "Add tests for auth"
      └─> Follow-up: "Document test framework"
          └─> Follow-up: "Update testing guide"
              └─> Follow-up: "Review all docs"
                  └─> ...
```

**Fixes:**
1. **Add depth tracking:**
   ```sql
   ALTER TABLE tasks ADD COLUMN follow_up_depth INTEGER DEFAULT 0;
   ```

2. **Enforce max depth (e.g., 2):**
   - If parent task has `follow_up_depth >= 2`, block follow-up creation
   - Log warning: "Max follow-up depth reached"

3. **Prompt instruction:**
   ```
   Note: Follow-ups of follow-ups are discouraged.
   Only create a follow-up if absolutely necessary.
   ```

### 4. LLM Output Injection / Validation
**Risk Level: HIGH**

**Problem:**
- Follow-up title/description come from LLM output (untrusted)
- No validation on content
- Could inject malicious SQL, shell commands, or excessive text

**Scenario:**
```json
{
  "title": "'; DROP TABLE tasks; --",
  "description": "{{ 10MB of garbage text }}..."
}
```

**Fixes:**
1. **Strict validation:**
   ```typescript
   - title: min 5 chars, max 120 chars, alphanumeric + basic punctuation only
   - description: min 20 chars, max 4000 chars
   - Sanitize: remove special chars, SQL keywords, shell metacharacters
   ```

2. **Schema-level constraints:**
   ```typescript
   follow_up_tasks: {
     type: 'array',
     maxItems: 5,
     items: {
       type: 'object',
       required: ['title', 'description'],
       properties: {
         title: { type: 'string', minLength: 5, maxLength: 120 },
         description: { type: 'string', minLength: 20, maxLength: 4000 }
       }
     }
   }
   ```

3. **Database-level constraints:**
   ```sql
   CREATE TABLE tasks (
     ...
     description TEXT CHECK(length(description) <= 4000),
     title TEXT CHECK(length(title) BETWEEN 5 AND 120)
   );
   ```

---

## MEDIUM-RISK ISSUES

### 5. Duplicate Detection Relies Solely on Reviewer
**Risk Level: MEDIUM**

**Problem:**
- Reviewer gets pending tasks and checks for duplicates
- But reviewer only sees titles, not full descriptions
- Could miss semantic duplicates: "Add tests" vs "Write unit tests"
- No orchestrator-level deduplication

**Scenario:**
```
Pending: "Improve error handling"
Reviewer suggests: "Add better error messages"  // Duplicate?
```

**Fixes:**
1. **Orchestrator-level dedup check:**
   - After reviewer suggests follow-ups, orchestrator does fuzzy match
   - Use normalized titles: lowercase, remove articles, stem words
   - If similarity > 80%, log warning and skip

2. **Include descriptions in duplicate check:**
   - Reviewer gets both title AND description of pending tasks
   - Better semantic matching

3. **Check against COMPLETED tasks (recent):**
   - Include last 10 completed tasks in duplicate check
   - Avoid suggesting work that was just finished

### 6. Context Length Limits
**Risk Level: MEDIUM**

**Problem:**
- Reviewer gets full list of pending tasks for duplicate checking
- Large projects: 50+ pending tasks = huge context
- Could exceed token limits or degrade performance

**Fixes:**
1. **Limit pending tasks list:**
   - Only include tasks from current section (not whole project)
   - Or last 20 pending tasks max

2. **Summary format:**
   - Send titles only (not full descriptions) for dup checking
   - Reduces context size

3. **Config option:**
   ```yaml
   followUpTasks:
     duplicateCheckScope: 'section'  # or 'project' or 'recent-20'
   ```

### 7. Reference Commit Invalidation
**Risk Level: MEDIUM**

**Problem:**
- `reference_commit` SHA stored, but commits can be rebased/deleted
- Follow-up task loses context if commit disappears

**Fixes:**
1. **Store commit message as well:**
   ```sql
   ALTER TABLE tasks ADD COLUMN reference_commit_message TEXT;
   ```

2. **CLI warning:**
   ```bash
   $ steroids tasks show abc-123
   ⚠️  Reference commit b0a53ed not found (may have been rebased)
   ```

3. **Description should be self-contained:**
   - Prompt instruction: "Description must make sense even if commit is lost"

### 8. Missing Deferred Follow-up in Duplicate Check
**Risk Level: MEDIUM**

**Problem:**
- Reviewer gets "pending/in_progress" tasks for dup checking
- But doesn't get deferred follow-ups (`is_follow_up=1`)
- Could suggest follow-up that's already deferred

**Example:**
```
Deferred follow-up: "Add tests for theme-utils"
Reviewer suggests again: "Add unit tests for theme-utils"  // Duplicate!
```

**Fix:**
- Include deferred follow-ups in reviewer's pending tasks list
- Or filter them explicitly in prompt: "Existing follow-ups: ..."

---

## LOW-RISK ISSUES

### 9. CLI Flag Confusion: `--follow-ups` vs `--follow-up`
**Risk Level: LOW**

**Problem:**
- `steroids tasks --follow-ups` (list deferred)
- `steroids tasks list --status pending --follow-up` (filter flag)
- Inconsistent naming could confuse users

**Fix:**
- Use consistent naming: `--follow-up-only` or `--is-follow-up`
- Or use subcommand: `steroids tasks follow-ups list`

### 10. Section Deletion Edge Case
**Risk Level: LOW**

**Problem:**
- Follow-up references `section_id`, but section gets deleted
- Follow-up becomes orphaned

**Fix:**
- Already addressed in design: "Follow-up remains, section_id becomes null"
- Show as "orphaned" in CLI ✓

---

## CONFIGURATION ISSUES

### 11. `autoImplement=true` Flood Risk
**Risk Level: HIGH (if misconfigured)**

**Problem:**
- User enables `autoImplement=true`
- Reviewer creates 5 follow-ups every approval
- Task queue grows faster than completion rate

**Safeguards:**
1. **Default to `false` (design already does this)** ✓
2. **Add max auto-implement per approval:**
   ```yaml
   followUpTasks:
     autoImplement: true
     maxAutoImplementPerApproval: 2  # Only 2 follow-ups auto-start
   ```
3. **Orchestrator warning log:**
   ```
   [Orchestrator] ⚠️  Created 5 follow-ups (3 deferred, 2 auto-started)
   [Orchestrator] Consider reviewing autoImplement config if queue grows
   ```

---

## SCHEMA/DATABASE ISSUES

### 12. `is_follow_up` Should Be Non-Nullable
**Risk Level: LOW**

**Problem:**
```sql
is_follow_up INTEGER DEFAULT 0
```
- Allows NULL values (0, 1, or NULL)
- Could cause ambiguity

**Fix:**
```sql
is_follow_up INTEGER NOT NULL DEFAULT 0 CHECK(is_follow_up IN (0, 1))
```

### 13. Missing Index on Status + `is_follow_up`
**Risk Level: LOW**

**Problem:**
- Task selection queries: `WHERE status='pending' AND is_follow_up=0`
- No composite index for this query

**Fix:**
```sql
CREATE INDEX idx_tasks_status_follow_up ON tasks(status, is_follow_up);
```

---

## PROMPT DESIGN REQUIREMENTS

Based on the analysis, the reviewer prompt MUST include:

### ✅ Required Instructions

1. **"Zero is okay" explicit permission:**
   ```
   If the work is complete and high-quality, return an empty array:
   follow_up_tasks: []

   Do NOT create follow-ups just because you can. Only suggest if:
   - Missing critical functionality (tests, docs, security)
   - Technical debt that will cause problems later
   - Clear, actionable improvements with real value
   ```

2. **Max limit reminder:**
   ```
   IMPORTANT: Maximum 5 follow-ups per approval. Typical: 0-2.
   ```

3. **Non-blocking requirement:**
   ```
   Follow-ups must be NON-BLOCKING improvements.
   If an issue prevents the task from being "complete", REJECT the task instead.
   Do NOT use follow-ups for blocking issues.
   ```

4. **Duplicate checking instructions:**
   ```
   Before suggesting a follow-up, check if it's already covered by:
   - Existing pending tasks (provided below)
   - Existing deferred follow-ups (provided below)
   - Recently completed tasks (provided below)

   Use semantic matching, not just exact title comparison.
   ```

5. **Provider-agnostic examples:**
   ```json
   // Good: Specific, valuable, non-blocking
   {
     "title": "Add error handling tests for theme-utils.ts",
     "description": "Current tests cover happy path only. Need tests for: invalid color formats, malformed config objects, XSS injection attempts in CSS values. See theme-utils.ts:45-120 for functions to test."
   }

   // Bad: Vague, low value
   {
     "title": "Improve code quality",
     "description": "Make the code better."
   }

   // Bad: Blocking issue (should REJECT task instead)
   {
     "title": "Fix security vulnerability in auth",
     "description": "Auth allows unauthenticated access."
   }
   ```

---

## TESTING REQUIREMENTS

### Must Test

1. **Zero follow-ups scenario:**
   - Reviewer approves with NO follow-ups
   - Verify: follow_up_tasks = []
   - Verify: No tasks created

2. **Max limit enforcement:**
   - Reviewer suggests 6 follow-ups
   - Verify: Schema validation rejects
   - Or: Only first 5 created, 6th logged as warning

3. **Duplicate detection:**
   - Pending task: "Add tests for X"
   - Reviewer suggests: "Write unit tests for X"
   - Verify: Skipped as duplicate

4. **Depth limit:**
   - Follow-up (depth=2) completes
   - Reviewer suggests follow-up of follow-up
   - Verify: Blocked, logged

5. **Content validation:**
   - Reviewer suggests title: 500 chars (exceeds max)
   - Verify: Rejected by schema

6. **Auto-implement vs deferred:**
   - Config: `autoImplement=false`
   - Verify: Follow-up has `is_follow_up=1`, not auto-selected
   - Promote task
   - Verify: Now auto-selectable

---

## IMMEDIATE ACTION ITEMS

Before implementing this feature:

1. ✅ Update reviewer schema to enforce max 5 follow-ups
2. ✅ Add title/description length constraints (5-120 / 20-4000)
3. ✅ Add "zero is okay" explicit instruction to reviewer prompt
4. ✅ Add non-blocking requirement to reviewer prompt
5. ✅ Include deferred follow-ups in duplicate check list
6. ✅ Add depth tracking column + max depth check (depth <= 2)
7. ✅ Add validation/sanitization for title/description content
8. ✅ Update task selection logic to explicitly skip `is_follow_up=1`
9. ✅ Add comprehensive tests (zero, max, dup, depth, validation)
10. ✅ Test with all three providers (Claude, Codex, Gemini)

---

## REVIEW STATUS

- **Codex:** ✅ Complete (9 issues identified, 6 HIGH-risk, 3 MEDIUM-risk)
- **Claude:** ❌ Failed (model configuration issue: claude-sonnet-4 not available)
- **Gemini:** ❌ Failed (ModelNotFoundError: gemini-2.0-flash-exp not found)

**Note:** Codex review alone is comprehensive enough to proceed. The 9 issues identified cover all major death spiral risks.

---

## CODEX COMPLETE FINDINGS

The following 9 issues were identified by Codex (gpt-5.3-codex) in adversarial review:

### Issue #1: Ambiguous "Deferred" State Machine
**Risk: HIGH**
**Codex's Analysis:** "Deferred follow-ups share `status='pending'` with actionable work. Any query that assumes `pending == work to do` will behave inconsistently (CLI counts, dashboards, task picker bugs)."

**Codex's Recommended Fix:**
- Make "deferred vs active" a first-class state
- Option A: Add `status='deferred'`
- Option B: Add `requires_promotion BOOLEAN` or `follow_up_state ENUM('deferred','active')`
- Keep `is_follow_up` as "this is a follow-up" regardless of deferred/active

### Issue #2: Self-Sustaining Follow-up Treadmill
**Risk: HIGH**
**Codex's Analysis:** "With `autoImplement=true`, every approved task spawns more tasks. Reviewer bias + auto-implement = work generated faster than completed = throughput collapse."

**Codex's Recommended Fix:**
- Add `followUpTasks.maxPerApproval` (default 3-5)
- Add `followUpTasks.maxAutoImplementPerApproval` (default 1-2)
- Add `followUpTasks.maxAutoImplementOutstanding` (cap total active follow-ups)
- Require estimated size, auto-implement only S/XS
- Auto-implement only if parent merged/pushed successfully

### Issue #3: Infinite Follow-up Chains
**Risk: HIGH**
**Codex's Analysis:** "Follow-up B from follow-up A creates unbounded depth. With auto-implement, infinite chain."

**Codex's Recommended Fix:**
- Track `follow_up_depth INT` from `reference_task_id` chain
- Add `followUpTasks.maxDepth` (default 1 or 2)
- If exceeded: block creation OR force defer-only OR require human promotion

### Issue #4: Unreliable Duplicate Detection
**Risk: HIGH**
**Codex's Analysis:** "Reviewer context truncates task list, misses similar tasks, creates duplicates. OR over-aggressively suppresses legitimate follow-ups. Different AI providers behave differently."

**Codex's Recommended Fix:**
- Add orchestrator-side minimal dedupe with `dedupe_key` (normalized title + reference_task_id)
- Add unique index on dedupe_key
- Include deferred follow-ups in reviewer's "existing tasks" set

### Issue #5: Prompt/Schema Ambiguity Across Providers
**Risk: HIGH**
**Codex's Analysis:** "One provider interprets as 'always propose at least one' (helpfulness bias), another returns none. Causes rejection loops."

**Codex's Recommended Fix:**
- Explicitly state in prompt: follow-ups OPTIONAL, empty/omitted if none
- follow-ups must be NON-BLOCKING
- Cap count 0-5
- Include "Done when" acceptance criteria
- Schema must accept missing/empty follow_up_tasks

### Issue #6: Follow-up vs Blocking Issue Underspecified
**Risk: HIGH**
**Codex's Analysis:** "Reviewer labels something as follow-up that coder interprets as required. Causes reject/approve oscillations. Inconsistency = rejection-loop generator."

**Codex's Recommended Fix:**
- Add `severity: 'low'|'medium'|'high'` or `non_blocking: true` field
- Crisp rules:
  - Correctness/security/data-loss/spec → REJECT (not follow-up)
  - Follow-ups = improvements only (quality, refactor, docs, extra tests)

### Issue #7: Underspecified "Scope" Behavior
**Risk: MEDIUM**
**Codex's Analysis:** "`scope='project-root'` but tasks require `section_id`. Follow-ups with NULL section become invisible or break 'next task' heuristics."

**Codex's Recommended Fix:**
- Define exactly how project-root maps:
  - Create dedicated "Follow-ups" section, OR
  - Allow `section_id NULL` and ensure every query handles it
- If section deleted: define reassignment behavior

### Issue #8: Reference Commit Fragility
**Risk: MEDIUM**
**Codex's Analysis:** "`reference_commit` SHA no longer exists after rebase. Task loses crucial context."

**Codex's Recommended Fix:**
- Store `reference_commit_message`, `reference_commit_summary`, `reference_branch`, `diffstat`
- CLI warns gracefully and shows stored metadata

### Issue #9: Data Validation Gaps (Prompt Injection)
**Risk: HIGH**
**Codex's Analysis:** "LLM-produced description contains malicious instructions, enormous content, or garbage. Becomes future system input when task selected."

**Codex's Recommended Fix:**
- Strict validation: title 5-120 chars, description 20-4000 chars
- Reject/trim control characters
- Store structured context: `files[]`, `symbols[]`, `commands[]`, `acceptance_criteria[]`
- When injecting into prompts: wrap as untrusted data, add instruction to ignore conflicting commands

---

## CONCLUSION

The follow-up tasks feature has **significant death spiral risks** that must be addressed before implementation:

1. **Reviewer bias to always suggest improvements** → Need explicit "zero is okay" permission
2. **Infinite follow-up chains** → Need depth limiting
3. **Ambiguous `is_follow_up` semantics** → Need clear state machine
4. **No validation on LLM output** → Need strict constraints

**Recommendation:** Implement all HIGH-risk mitigations before proceeding. The feature is valuable but needs safeguards to prevent runaway task generation.
