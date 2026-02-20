/**
 * Post-Reviewer Orchestrator
 * Analyzes reviewer output and decides task outcome
 */

import { ReviewerContext } from './types.js';

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

**CRITICAL: You MUST respond ONLY with valid JSON. No markdown, no other text.**

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

## Output Format (JSON ONLY)

\`\`\`json
{
  "decision": "approve" | "reject" | "dispute" | "skip" | "unclear",
  "reasoning": "One sentence why (max 100 chars)",
  "notes": "Feedback for coder (required if reject)",
  "next_status": "completed" | "in_progress" | "disputed" | "skipped" | "review",
  "metadata": {
    "rejection_count": 0,
    "confidence": "high" | "medium" | "low",
    "push_to_remote": false,
    "repeated_issue": false
  }
}
\`\`\`

### Field Rules

**decision:**
- \`approve\` → Work meets requirements, task complete
- \`reject\` → Issues found, send back to coder
- \`dispute\` → Fundamental disagreement or hit limit, needs human
- \`skip\` → Task requires external work, no code needed
- \`unclear\` → Couldn't determine decision, retry review

**next_status:**
- \`completed\` for approve
- \`in_progress\` for reject
- \`disputed\` for dispute
- \`skipped\` for skip
- \`review\` for unclear

**notes:** Required if reject (specific feedback for coder)

**metadata.push_to_remote:**
- \`true\` for approve, dispute, skip
- \`false\` for reject, unclear

---

## Examples

### Example 1: Approval
\`\`\`json
{
  "decision": "approve",
  "reasoning": "Explicit approval signal",
  "notes": "Implementation meets all requirements",
  "next_status": "completed",
  "metadata": {
    "rejection_count": 0,
    "confidence": "high",
    "push_to_remote": true,
    "repeated_issue": false
  }
}
\`\`\`

### Example 2: Rejection
\`\`\`json
{
  "decision": "reject",
  "reasoning": "Specific issues identified",
  "notes": "1. Add error handling in parseConfig(). 2. Missing test for edge case. 3. Fix type error on line 42.",
  "next_status": "in_progress",
  "metadata": {
    "rejection_count": 1,
    "confidence": "high",
    "push_to_remote": false,
    "repeated_issue": false
  }
}
\`\`\`

### Example 3: Dispute (Repeated)
\`\`\`json
{
  "decision": "dispute",
  "reasoning": "Same issue repeated 4 times, hitting limit",
  "notes": "Reviewer demanding global test coverage outside task scope. Human decision needed.",
  "next_status": "disputed",
  "metadata": {
    "rejection_count": 11,
    "confidence": "high",
    "push_to_remote": true,
    "repeated_issue": true
  }
}
\`\`\`

### Example 4: Unclear
\`\`\`json
{
  "decision": "unclear",
  "reasoning": "No decision statement in output",
  "notes": "Reviewer did not complete analysis",
  "next_status": "review",
  "metadata": {
    "rejection_count": 2,
    "confidence": "low",
    "push_to_remote": false,
    "repeated_issue": false
  }
}
\`\`\`

---

Analyze the context above and respond with JSON:`;
}
