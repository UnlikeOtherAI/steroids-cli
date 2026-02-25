/**
 * Post-Reviewer Orchestrator
 * Analyzes reviewer output and decides task outcome
 */

import { ReviewerContext, MultiReviewerContext } from './types.js';

/**
 * Generate post-reviewer orchestrator prompt
 */
export function buildPostReviewerPrompt(context: ReviewerContext): string {
  const {
    task,
    reviewer_output: { stdout, stderr, exit_code, timed_out, duration_ms },
    git_context: { commit_sha, files_changed, additions, deletions }
  } = context;

  const duration_seconds = (duration_ms / 1000).toFixed(1);
  const stdout_tail = stdout.slice(-2000);
  const stderr_tail = stderr.slice(-2000);

  let stderrSection = '';
  if (stderr) {
    stderrSection = `
**Stderr (informational - CLI tools commonly write progress, warnings, and debug info here):**
\`\`\`
${stderr_tail}
\`\`\`
`;
  }

  return `# POST-REVIEWER ORCHESTRATOR

You are a state machine that analyzes reviewer output and determines the next action.

**CRITICAL: Your response MUST end with the required signal lines below. No JSON.**

---

## Task Context

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15

---

## Reviewer Execution

**Exit Code:** ${exit_code}
**Timed Out:** ${timed_out}
**Duration:** ${duration_seconds}s

**Output (last 2000 chars):**
\`\`\`
${stdout_tail}
\`\`\`
${stderrSection}
---

## Git Diff

**Commit:** ${commit_sha}
**Files Changed:** ${files_changed.length}
**Lines:** +${additions} -${deletions}

---

## Decision Rules

### 1. Explicit Decision Token (HIGHEST PRIORITY)
- Parse decision from an explicit token in stdout only:
  - \`DECISION: APPROVE\` → \`approve\`
  - \`DECISION: REJECT\` → \`reject\`
  - \`DECISION: DISPUTE\` → \`dispute\`
  - \`DECISION: SKIP\` → \`skip\`
- Also accept formatting variants with the same explicit token:
  - \`DECISION - APPROVE\`
  - \`**DECISION:** APPROVE\`
- Accept a bare first-line token only if it is exactly one of:
  - \`APPROVE\`, \`REJECT\`, \`DISPUTE\`, \`SKIP\`
- Do NOT infer approval/rejection from sentiment or keywords like "looks good".
- Stderr warnings/info do NOT override an explicit token in stdout.
- Non-zero exit code WITH explicit token → honor token.

### 2. Unclear
- No explicit decision token found in stdout → \`unclear\`
- Timeout → \`unclear\`
- **IMPORTANT:** Stderr output alone does NOT make a decision unclear.

### 6. Rejection Threshold
- Rejection count = 15 → automatically \`dispute\` (prevent infinite loops)

---

## Required Output (last lines)

DECISION: APPROVE | REJECT | DISPUTE | SKIP
NOTES: <feedback for coder, required if REJECT>
CONFIDENCE: HIGH | MEDIUM | LOW

Optional (only on APPROVE):
### Follow-Up Tasks
- **Title:** Description

### Decision Values

- \`APPROVE\` → Work meets requirements, task complete
- \`REJECT\` → Issues found, send back to coder
- \`DISPUTE\` → Fundamental disagreement or hit limit, needs human
- \`SKIP\` → Task requires external work, no code needed

If you cannot determine a decision, omit the DECISION line (will be treated as unclear).

### NOTES

Required if REJECT (specific feedback for coder). Include all issues found.

### Follow-Up Tasks

Optional (0-3 items). Use ONLY for approvals where non-blocking improvements or technical debt were identified.

---

## Examples

### Example 1: Approval with Follow-up

DECISION: APPROVE
NOTES: Implementation meets all requirements
CONFIDENCE: HIGH

### Follow-Up Tasks
- **Add unit tests for edge cases in validation.ts:** Add tests for null/undefined inputs in the new validation logic.

### Example 2: Rejection

DECISION: REJECT
NOTES: 1. Add error handling in parseConfig(). 2. Missing test for edge case. 3. Fix type error on line 42.
CONFIDENCE: HIGH

### Example 3: Dispute (Repeated)

DECISION: DISPUTE
NOTES: Reviewer demanding global test coverage outside task scope. Human decision needed.
CONFIDENCE: HIGH

### Example 4: Unclear output

(no DECISION line — will trigger retry)

---

Analyze the context above and respond with the signal lines:`;
}

/**
 * Generate multi-reviewer orchestrator prompt for merging notes
 */
export function buildMultiReviewerOrchestratorPrompt(context: MultiReviewerContext): string {
  const {
    task,
    reviewer_results,
    git_context: { commit_sha, files_changed, additions, deletions }
  } = context;

  const reviewers_formatted = reviewer_results.map((r, i) => `
### Reviewer ${i} (${r.provider}/${r.model})
**Decision:** ${r.decision}
**Stdout (last 5000 chars):**
\`\`\`
${r.stdout.slice(-5000)}
\`\`\`
`).join('\n---\n');

  return `# MULTI-REVIEWER ORCHESTRATOR

You are receiving rejection notes from ${reviewer_results.length} independent reviewers.
The DECISION is already REJECT. Your job is to MERGE THE NOTES into a single checklist.

**CRITICAL: Your response MUST end with the required signal lines below. No JSON.**

---

## Task Context

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15

---

## Reviewer Execution Outputs
${reviewers_formatted}

---

## Git Diff Context

**Commit:** ${commit_sha}
**Files Changed:** ${files_changed.join(', ')}
**Lines:** +${additions} -${deletions}

---

## Your Task (Review Note Merger)

1. Group findings by file path, then by line proximity (within 5 lines = same area).
2. When multiple reviewers flag the same issue, consolidate and note it was caught by multiple.
3. **Do NOT rewrite findings** -- quote the original reviewer text verbatim where possible.
4. **Do NOT add your own findings** -- you are a grouper, not a reviewer.
5. **Do NOT drop any finding**, even if it seems minor.
6. If findings conflict on STYLE (not correctness), mark as [STYLE CONFLICT] and keep only the primary reviewer's preference (Reviewer 0 is primary).
7. Order: file path -> line number.
8. Use checkbox format for the final notes: - [ ] Finding text (Reviewer Name)
9. **Follow-up Tasks:** If any reviewer suggested a follow-up task, consolidate and deduplicate them. Include them in the \`follow_up_tasks\` field.
10. **Prevent Death Loops:** If the coder has made significant progress and the remaining issues are non-blocking (technical debt, missing docs, minor refactors), you are ENCOURAGED to APPROVE the current task and move the remaining issues to a FOLLOW-UP TASK. This prevents infinite rejection cycles.

---

## Required Output (last lines)

DECISION: REJECT
NOTES:
## Merged Review Findings
### File.ts
- [ ] Issue found (Reviewer name)
...

### Follow-Up Tasks
- **Title:** Description

CONFIDENCE: HIGH | MEDIUM | LOW

---

Analyze the context above and respond with the signal lines:`;
}
