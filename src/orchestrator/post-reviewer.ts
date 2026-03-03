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
  const stdout_tail = stdout.slice(-5000);
  const stderr_tail = stderr.slice(-5000);

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

**Output (last 5000 chars):**
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

**CRITICAL FOR NOTES FORMAT:** When the reviewer used checkbox format (\`- [ ] ...\`), reproduce those lines VERBATIM in NOTES. Do NOT rephrase or convert to numbered prose. Structured tags like \`[OUT_OF_SCOPE]\`, \`[UNRESOLVED]\`, and \`[NEW]\` must be preserved exactly as written.

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
NOTES:
- [ ] Add error handling in parseConfig() — src/config.ts:42
- [ ] [OUT_OF_SCOPE] Added API route in src/api/users.ts belongs to sibling task "Add users API endpoint"
- [ ] Fix type error on line 42 of src/config.ts
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
 * Generate multi-reviewer orchestrator prompt for arbitration and note consolidation
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

You are arbitrating ${reviewer_results.length} independent reviewer outputs for one task.
Your job is to produce ONE final decision and notes.

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

## Arbitration Rules

1. You must output exactly one final decision: APPROVE, REJECT, or DISPUTE.
2. If no reviewer decision is \`dispute\` and at least one reviewer decision is \`reject\`, your decision MUST be either APPROVE or REJECT (not DISPUTE).
3. If final decision is REJECT:
   - merge reviewer findings into one actionable checklist,
   - preserve structured tags (\`[OUT_OF_SCOPE]\`, \`[UNRESOLVED]\`, \`[NEW]\`) exactly,
   - do not add new findings that were not in reviewer outputs.
4. If final decision is APPROVE:
   - explain why rejection findings are resolved or non-blocking.
5. Do not infer from sentiment; use reviewer decisions and evidence.
6. Keep notes concise and deterministic.

---

## Required Output (last lines)

DECISION: APPROVE | REJECT | DISPUTE
NOTES: <required; checklist required when REJECT>
CONFIDENCE: HIGH | MEDIUM | LOW

### Follow-Up Tasks
- **Title:** Description

---

Analyze the context above and respond with the signal lines:`;
}
