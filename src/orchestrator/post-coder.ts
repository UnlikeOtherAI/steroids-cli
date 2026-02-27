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

**CRITICAL: Your response MUST end with the required signal lines below. No JSON.**

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
- Exit code non-zero + timeout → STATUS: ERROR (process killed)
- Exit code non-zero + no commits + no changes → STATUS: ERROR (failed to start)
- Stderr contains "fatal" / "Permission denied" → STATUS: ERROR

### 2. Incomplete Work
- Exit 0 but no commits and no changes → STATUS: RETRY (did nothing)
- Timeout but has commits/changes → STATUS: REVIEW (save progress)
- Output contains "need more time" / "continuing" → STATUS: RETRY

### 3. Completion Without Commit
- Exit 0 + uncommitted changes + completion signal → STATUS: REVIEW
- Look for: "changes ready", "implementation complete", "finished"

### 4. Normal Completion
- Exit 0 + commits exist → STATUS: REVIEW
- Most common happy path

### 5. First-Submission Self-Checklist
- If \`Rejection Count\` is 0, require a \`SELF_REVIEW_CHECKLIST\` block in coder output
- Checklist must include a final self-review confirmation item
- If missing, return:
  - STATUS: RETRY
  - REASON: CHECKLIST_REQUIRED: <details>

### 6. Rejection Response Contract (Required on Resubmissions)
- If \`Rejection Count\` is > 0, require a \`REJECTION_RESPONSE\` block
- The block must contain one line per rejection item using:
  - \`ITEM-<n> | IMPLEMENTED | ...\`
  - or \`ITEM-<n> | WONT_FIX | ...\`
  - or \`ITEM-<n> | REVERTED | ...\` (for \`[OUT_OF_SCOPE]\` items that were removed)
- If missing or clearly incomplete, return:
  - STATUS: RETRY
  - REASON: REJECTION_RESPONSE_REQUIRED: <details>
- \`REJECTION_RESPONSE\` completeness check must use \`Open Rejection Items (latest)\` from task context
- Require sequential responses: \`ITEM-1\` through \`ITEM-N\`
- \`REVERTED\` responses are always valid for \`[OUT_OF_SCOPE]\` items — do NOT flag these as WONT_FIX_OVERRIDE

### 7. WONT_FIX Claims (High Priority on Rejected Tasks)
- If task has prior rejections and coder output includes \`WONT_FIX\`, apply strict scrutiny
- A \`WONT_FIX\` is acceptable ONLY when all are present:
  - Clear technical reason (impossible/unsafe/out-of-scope conflict)
  - Concrete evidence the task still works without that item
  - No conflict with any mandatory override guidance
- If any of the above is missing, return:
  - STATUS: RETRY
  - REASON: WONT_FIX_OVERRIDE: <item1>; <item2>; ...
- If evidence is strong and functionality is complete, STATUS: REVIEW is allowed

### 8. Uncertainty Default
- When signals conflict → STATUS: RETRY (safer than error)

---

## Required Output (last lines)

STATUS: REVIEW | RETRY | ERROR
REASON: <one sentence why, max 100 chars>

Optional:
CONFIDENCE: HIGH | MEDIUM | LOW
COMMIT_MESSAGE: <message if uncommitted changes need committing>

### Status Values

- \`REVIEW\` → Work complete, ready for review (maps to submit or stage_commit_submit)
- \`RETRY\` → Incomplete or unclear, run coder again
- \`ERROR\` → Fatal issue, needs human intervention

### REASON Prefixes (for contract violations)

- \`REASON: CHECKLIST_REQUIRED: <details>\` — first submission missing self-checklist
- \`REASON: REJECTION_RESPONSE_REQUIRED: <details>\` — resubmission missing ITEM responses
- \`REASON: WONT_FIX_OVERRIDE: <item1>; <item2>; ...\` — mandatory fixes when WONT_FIX is rejected

---

## Examples

### Example 1: Normal Completion

STATUS: REVIEW
REASON: Clean exit with 2 commits
CONFIDENCE: HIGH

### Example 2: Uncommitted Work

STATUS: REVIEW
REASON: Work complete but not committed
CONFIDENCE: HIGH
COMMIT_MESSAGE: feat: implement task specification

### Example 3: Timeout with no output

STATUS: RETRY
REASON: Timeout with no output, retrying
CONFIDENCE: HIGH

### Example 4: Fatal error

STATUS: ERROR
REASON: Non-zero exit with no changes, fatal
CONFIDENCE: HIGH

### Example 5: Missing self-checklist

STATUS: RETRY
REASON: CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found
CONFIDENCE: HIGH

---

Analyze the context above and respond with the signal lines:`;
}
