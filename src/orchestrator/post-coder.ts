/**
 * Post-Coder Orchestrator
 * Analyzes coder output and decides if work is ready for review
 */

import { CoderContext } from './types.js';

const CONTEXT_TAIL_CHARS = 6000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(output: string, heading: string): string | null {
  const pattern = new RegExp(
    `(^|\\n)##\\s*${escapeRegExp(heading)}\\s*[\\r\\n]+([\\s\\S]*?)(?=\\n##\\s|$)`,
    'i'
  );
  const match = output.match(pattern);
  if (!match) return null;
  return `## ${heading}\n${match[2].trim()}`.trim();
}

/**
 * Generate post-coder orchestrator prompt
 */
export function buildPostCoderPrompt(context: CoderContext): string {
  const {
    task,
    coder_output: { stdout, stderr, exit_code, timed_out, duration_ms },
    git_state: { commits, files_changed, has_uncommitted_changes }
  } = context;

  const duration_seconds = (duration_ms / 1000).toFixed(1);
  const stdout_tail = stdout.length > CONTEXT_TAIL_CHARS ? stdout.slice(-CONTEXT_TAIL_CHARS) : stdout;
  const stderr_tail = stderr.length > CONTEXT_TAIL_CHARS ? stderr.slice(-CONTEXT_TAIL_CHARS) : stderr;
  const selfReviewChecklist = extractMarkdownSection(stdout, 'SELF_REVIEW_CHECKLIST');
  const rejectionResponse = extractMarkdownSection(stdout, 'REJECTION_RESPONSE');

  let rejectionSection = '';
  if (task.rejection_notes) {
    rejectionSection = `
**Previous Rejection:** ${task.rejection_notes}
**Rejection Count:** ${task.rejection_count || 0}
**Open Rejection Items (latest):** ${task.rejection_item_count ?? 0}
`;
  }

  let commitsSection = '';
  if (commits.length > 0) {
    commitsSection = commits.map(c => `- ${c.sha} - ${c.message}`).join('\n');
  }

  let filesSection = '';
  if (files_changed.length > 0) {
    filesSection = files_changed.map(f => `- ${f}`).join('\n');
  }

  let stderrSection = '';
  if (stderr) {
    stderrSection = `
**Errors (tail ${CONTEXT_TAIL_CHARS} chars):**
\`\`\`
${stderr_tail}
\`\`\`
`;
  }

  const extractedBlocks: string[] = [];
  if (selfReviewChecklist) {
    extractedBlocks.push(`### Extracted SELF_REVIEW_CHECKLIST\n\`\`\`\n${selfReviewChecklist}\n\`\`\``);
  }
  if (rejectionResponse) {
    extractedBlocks.push(`### Extracted REJECTION_RESPONSE\n\`\`\`\n${rejectionResponse}\n\`\`\``);
  }

  const extractedBlocksSection = extractedBlocks.length > 0
    ? `
---

## Extracted Required Blocks (from full output)

${extractedBlocks.join('\n\n')}
`
    : '';

  return `# POST-CODER ORCHESTRATOR

You are a state machine that analyzes coder output and determines the next action.

**CRITICAL: You MUST respond ONLY with valid JSON. No markdown, no other text.**

---

## Task Context

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**Task Status:** in_progress
${rejectionSection}
---

## Coder Execution

**Exit Code:** ${exit_code}
**Timed Out:** ${timed_out}
**Duration:** ${duration_seconds}s

**Output (tail ${CONTEXT_TAIL_CHARS} chars):**
\`\`\`
${stdout_tail}
\`\`\`
${stderrSection}
${extractedBlocksSection}
---

## Git State

**Commits Made:** ${commits.length}
${commitsSection}

**Files Changed:** ${files_changed.length}
${filesSection}

**Uncommitted Changes:** ${has_uncommitted_changes}

---

## Decision Rules

### 1. Error States
- Exit code non-zero + timeout → \`error\` (process killed)
- Exit code non-zero + no commits + no changes → \`error\` (failed to start)
- Stderr contains "fatal" / "Permission denied" → \`error\`

### 2. Incomplete Work
- Exit 0 but no commits and no changes → \`retry\` (did nothing)
- Timeout but has commits/changes → \`stage_commit_submit\` (save progress)
- Output contains "need more time" / "continuing" → \`retry\`

### 3. Completion Without Commit
- Exit 0 + uncommitted changes + completion signal → \`stage_commit_submit\`
- Look for: "changes ready", "implementation complete", "finished"

### 4. Normal Completion
- Exit 0 + commits exist → \`submit\`
- Most common happy path

### 5. First-Submission Self-Checklist
- If \`Rejection Count\` is 0, require a \`SELF_REVIEW_CHECKLIST\` block in coder output
- Checklist must include a final self-review confirmation item
- If missing, return:
  - \`action: "retry"\`
  - \`next_status: "in_progress"\`
  - \`reasoning\` starting with \`CHECKLIST_REQUIRED:\` (short)
  - \`contract_violation: "checklist_required"\`

### 6. Rejection Response Contract (Required on Resubmissions)
- If \`Rejection Count\` is > 0, require a \`REJECTION_RESPONSE\` block
- The block must contain one line per rejection item using:
  - \`ITEM-<n> | IMPLEMENTED | ...\`
  - or \`ITEM-<n> | WONT_FIX | ...\`
- If missing or clearly incomplete, return:
  - \`action: "retry"\`
  - \`next_status: "in_progress"\`
  - \`reasoning\` starting with \`REJECTION_RESPONSE_REQUIRED:\` (short)
  - \`contract_violation: "rejection_response_required"\`
- \`REJECTION_RESPONSE\` completeness check must use \`Open Rejection Items (latest)\` from task context
- Require sequential responses: \`ITEM-1\` through \`ITEM-N\`

### 7. WONT_FIX Claims (High Priority on Rejected Tasks)
- If task has prior rejections and coder output includes \`WONT_FIX\`, apply strict scrutiny
- A \`WONT_FIX\` is acceptable ONLY when all are present:
  - Clear technical reason (impossible/unsafe/out-of-scope conflict)
  - Concrete evidence the task still works without that item
  - No conflict with any mandatory override guidance
- If any of the above is missing, return:
  - \`action: "retry"\`
  - \`next_status: "in_progress"\`
  - \`reasoning\` that starts with \`WONT_FIX_OVERRIDE:\` (short)
  - \`wont_fix_override_items\` containing specific mandatory fixes
- If evidence is strong and functionality is complete, \`submit\` is allowed

### 8. Uncertainty Default
- When signals conflict → \`retry\` (safer than error)

---

## Output Format (JSON ONLY)

\`\`\`json
{
  "action": "submit" | "retry" | "stage_commit_submit" | "error",
  "reasoning": "One sentence why (max 100 chars)",
  "commits": ["sha1", "sha2"],
  "commit_message": "Only if stage_commit_submit",
  "contract_violation": "checklist_required" | "rejection_response_required" | null,
  "wont_fix_override_items": ["specific required fix", "another required fix"],
  "next_status": "review" | "in_progress" | "failed",
  "metadata": {
    "files_changed": 0,
    "confidence": "high" | "medium" | "low",
    "exit_clean": true,
    "has_commits": false
  }
}
\`\`\`

### Field Rules

**action:**
- \`submit\` → Work complete, has commits, ready for review
- \`retry\` → Incomplete or unclear, run coder again
- \`stage_commit_submit\` → Work complete but not committed
- \`error\` → Fatal issue, needs human intervention

**contract_violation:**
- \`checklist_required\` when first submission missing required self-checklist
- \`rejection_response_required\` when resubmission misses required ITEM responses
- \`null\` when no contract violation

**wont_fix_override_items:**
- Optional list of mandatory fixes when WONT_FIX is rejected by orchestrator
- Use this field for detailed override items (do NOT put long detail in reasoning)

**next_status:**
- \`review\` for submit and stage_commit_submit
- \`in_progress\` for retry
- \`failed\` for error

**confidence:**
- \`high\` - Clear signals, obvious decision
- \`medium\` - Reasonable inference from context
- \`low\` - Uncertain, making best guess

---

## Examples

### Example 1: Normal Completion
\`\`\`json
{
  "action": "submit",
  "reasoning": "Clean exit with 2 commits",
  "commits": ["abc123", "def456"],
  "commit_message": null,
  "next_status": "review",
  "metadata": {
    "files_changed": 3,
    "confidence": "high",
    "exit_clean": true,
    "has_commits": true
  }
}
\`\`\`

### Example 2: Uncommitted Work
\`\`\`json
{
  "action": "stage_commit_submit",
  "reasoning": "Work complete but not committed",
  "commits": [],
  "commit_message": "feat: implement task specification",
  "next_status": "review",
  "metadata": {
    "files_changed": 2,
    "confidence": "high",
    "exit_clean": true,
    "has_commits": false
  }
}
\`\`\`

### Example 3: Timeout
\`\`\`json
{
  "action": "retry",
  "reasoning": "Timeout with no output, retrying",
  "commits": [],
  "commit_message": null,
  "next_status": "in_progress",
  "metadata": {
    "files_changed": 0,
    "confidence": "high",
    "exit_clean": false,
    "has_commits": false
  }
}
\`\`\`

---

Analyze the context above and respond with JSON:`;
}
