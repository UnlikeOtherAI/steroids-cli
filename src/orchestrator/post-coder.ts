/**
 * Post-Coder Orchestrator
 * Analyzes coder output and decides if work is ready for review
 */

import { CoderContext } from './types.js';

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
  const stdout_tail = stdout.slice(-2000);
  const stderr_tail = stderr.slice(-2000);

  let rejectionSection = '';
  if (task.rejection_notes) {
    rejectionSection = `
**Previous Rejection:** ${task.rejection_notes}
**Rejection Count:** ${task.rejection_count || 0}
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
**Errors:**
\`\`\`
${stderr_tail}
\`\`\`
`;
  }

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

**Output (last 2000 chars):**
\`\`\`
${stdout_tail}
\`\`\`
${stderrSection}
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

### 5. Uncertainty Default
- When signals conflict → \`retry\` (safer than error)

---

## Output Format (JSON ONLY)

\`\`\`json
{
  "action": "submit" | "retry" | "stage_commit_submit" | "error",
  "reasoning": "One sentence why (max 100 chars)",
  "commits": ["sha1", "sha2"],
  "commit_message": "Only if stage_commit_submit",
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
