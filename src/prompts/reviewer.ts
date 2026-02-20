/**
 * Reviewer prompt templates
 * Following the exact templates from PROMPTS.md
 */

import type { Task, RejectionEntry } from '../database/queries.js';
import type { SteroidsConfig } from '../config/loader.js';
import { getSourceFileContent, buildFileAnchorSection, formatSectionTasks } from './prompt-helpers.js';
import type { SectionTask } from './prompt-helpers.js';

export interface ReviewerPromptContext {
  task: Task;
  projectPath: string;
  reviewerModel: string;
  gitDiff: string;
  modifiedFiles: string[];
  sectionTasks?: SectionTask[];  // Other tasks in the same section
  rejectionHistory?: RejectionEntry[];  // Past rejections with commit hashes
  submissionNotes?: string | null;  // Notes from coder when submitting for review
  config: SteroidsConfig;  // Config for quality settings
  coordinatorGuidance?: string;  // Guidance from coordinator after repeated rejections
  coordinatorDecision?: string;  // Coordinator's decision type
}

/**
 * Format rejection history for display
 */
function formatRejectionHistory(rejections?: RejectionEntry[]): string {
  if (!rejections || rejections.length === 0) {
    return `
---

## Rejection History

No previous rejections. This is the first review.
`;
  }

  const lines = rejections.map(r => {
    const commitRef = r.commit_sha ? ` (commit: ${r.commit_sha.substring(0, 7)})` : '';
    const notes = r.notes || '(no notes provided)';
    return `### Rejection #${r.rejection_number}${commitRef}
${notes}
`;
  });

  // Always provide specific guidance - don't wait for high rejection count
  const guidanceNote = `
**Rejection Best Practices:**
- Provide specific file:line references (e.g., \`src/foo.ts:42\`)
- Include exact code snippets that need to change
- Point to similar working patterns in the codebase
- Explain WHY the current approach doesn't work, not just WHAT is wrong
- **NEVER demand global/overall project coverage** - only coverage for THIS task's modified files
- **Follow the project's architecture** - if coder's approach matches existing patterns, accept it`;

  const highRejectionWarning = rejections.length >= 3 ? `

**CRITICAL: This task has been rejected ${rejections.length} times.**
- If you are about to reject for the SAME reasons as before, consider whether the requirement is achievable
- If the coder has attempted to address your feedback but can't fully resolve it, consider APPROVING with notes
- If there's a fundamental disagreement, use DISPUTE instead of rejecting again
- Ask yourself: "Is what I'm asking for within the scope of THIS single task?"
` : '';

  return `
---

## Rejection History (${rejections.length} previous)
${highRejectionWarning}
**Review this history carefully before making your decision.**
- Look for patterns: Is the same issue being raised repeatedly?
- If an issue was raised before and not fixed, be MORE SPECIFIC about what exactly needs to change
- Use commit hashes to examine previous attempts: \`git show <hash>\`
- The coder only sees YOUR rejection notes - make them actionable
${guidanceNote}
${lines.join('\n')}
`;
}

/**
 * Format section tasks for display
 */
/**
 * Format coordinator guidance for the reviewer
 * Makes coordinator decisions visible as advisory context for the reviewer
 */
function formatCoordinatorGuidance(guidance?: string, decision?: string): string {
  if (!guidance) return '';

  const decisionLabels: Record<string, string> = {
    'guide_coder': 'Guide coder (reviewer feedback is valid, coder needs clearer direction)',
    'override_reviewer': 'Override reviewer (some reviewer demands are out of scope or unachievable)',
    'narrow_scope': 'Narrow scope (task scope reduced to achievable subset)',
  };

  const decisionLabel = decisionLabels[decision || ''] || decision || 'unknown';

  return `
---

## COORDINATOR INTERVENTION

A coordinator has reviewed the rejection history for this task and made the following decision:

**Decision:** ${decisionLabel}

**Coordinator's Guidance:**

${guidance}

**Use this as advisory context, not an approval gate:**
- If the coordinator decided **override_reviewer**: treat it as a scope hint, but still verify correctness, security, and spec compliance in the actual diff.
- If the coordinator decided **narrow_scope**: prioritize the narrowed scope for disputed points, but still review for any blocking defects.
- If the coordinator decided **guide_coder**: check whether the coder followed the guidance, then continue full independent review.
- You may reject for any blocking issue, including new or previously missed issues.
- Never auto-approve because coordinator guidance was followed.
- If coordinator guidance conflicts with clear spec/security/correctness requirements, follow those requirements and explain the conflict.
- If you disagree with coordinator scope advice, explicitly state why in your rejection notes so the next coordinator pass can converge.

`;
}

/**
 * Generate test coverage instructions if required
 * Coverage is scoped to MODIFIED FILES ONLY - not global project coverage
 */
function getTestCoverageInstructions(config: SteroidsConfig, modifiedFiles?: string[]): string {
  if (!config.quality?.tests?.required) {
    return '';
  }

  const minCoverage = config.quality.tests.minCoverage ?? 80;

  const filesScope = modifiedFiles && modifiedFiles.length > 0
    ? `- Coverage applies to files MODIFIED IN THIS TASK:\n${modifiedFiles.map(f => `  - ${f}`).join('\n')}`
    : '- Coverage applies to the files modified in this task';

  return `

## Test Coverage (REQUIRED - SCOPED TO THIS TASK)

**This project requires tests for new code.**

${filesScope}
- Target coverage for THIS TASK's modified files: ${minCoverage}%
- Tests must exercise the new/changed code paths
- **DO NOT demand global/overall project coverage from a single task**
- Other modules' coverage is tracked separately and is NOT this task's responsibility
- REJECT only if tests for the NEW CODE in this task are missing or inadequate
`;
}

/**
 * Generate the reviewer prompt
 */
export function generateReviewerPrompt(context: ReviewerPromptContext): string {
  const { task, projectPath, reviewerModel, gitDiff, modifiedFiles, sectionTasks, rejectionHistory, submissionNotes, config, coordinatorGuidance, coordinatorDecision } = context;

  // Format coder's submission notes if present
  const submissionNotesSection = submissionNotes
    ? `
---

## Coder's Notes

The coder included these notes when submitting for review:

> ${submissionNotes}

**CRITICAL: If the coder claims work already exists:**
1. **DO NOT reject just because the diff is empty or only shows version bumps**
2. If a commit hash is mentioned, run \`git show <hash>\` to verify the work
3. Check if the files/functionality described actually exist in the codebase
4. If the existing work fulfills the specification: **APPROVE**
5. If gaps remain: specify exactly what's missing, don't ask for re-implementation
`
    : '';

  const sourceContent = getSourceFileContent(projectPath, task.source_file);
  const fileAnchorSection = buildFileAnchorSection(task);

  // Truncate diff if too long (max 20000 chars per spec)
  let diffContent = gitDiff;
  if (diffContent.length > 20000) {
    diffContent = diffContent.substring(0, 20000) + '\n\n[Diff truncated]';
  }

  const filesListFormatted = modifiedFiles.length > 0
    ? modifiedFiles.map(f => `- ${f}`).join('\n')
    : 'No files modified';

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title}
# Status: review | Rejections: ${task.rejection_count}/15

You are a REVIEWER in an automated task execution system. Your job is to verify the coder's implementation matches the specification.

**Follow the project's existing architecture.** If the coder's implementation follows the patterns already established in the codebase (as described in AGENTS.md), do not reject for architectural style differences. Focus on correctness and spec compliance.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}
${fileAnchorSection}${formatSectionTasks(task.id, sectionTasks)}${formatRejectionHistory(rejectionHistory)}${submissionNotesSection}${formatCoordinatorGuidance(coordinatorGuidance, coordinatorDecision)}
## Original Specification

From ${task.source_file ?? '(not specified)'}:

${sourceContent}

---

## Changes Made by Coder

\`\`\`diff
${diffContent}
\`\`\`

---

## Files Modified

${filesListFormatted}

---

## Review Checklist

Answer these questions:
1. Does the implementation match the specification?
2. Are there bugs or logic errors?
3. Are tests present and adequate?
4. Does code follow AGENTS.md guidelines?
5. Are all files under 500 lines?

## Security Review

**Check the coder's NEW or CHANGED code for security vulnerabilities.**

**Scope rule:** Only evaluate code in the diff. Pre-existing patterns in unchanged code are NOT the coder's responsibility — note them as advisory but do NOT reject for them. If the coder follows an existing pattern already in the codebase, that is acceptable even if the pattern is imperfect.

Check for:
- **Injection attacks**: User input concatenated directly into SQL strings (instead of parameterized queries), or user input interpolated into shell command strings. String interpolation of hardcoded constants or internal config values is NOT injection.
- **Shell safety**: When passing user-controlled or external values as arguments to commands, prefer array-based APIs (e.g., Node \`execFileSync(cmd, [args])\`, Python \`subprocess.run([cmd, args])\` without \`shell=True\`). Using \`execSync\` with hardcoded commands, shell features (pipes, chaining), or user-configured hook commands is acceptable.
- **Path traversal**: File paths from end-user CLI input should be validated to stay within the expected directory. Internally-constructed paths to known locations (\`~/.steroids/\`, temp dirs, config paths) are fine.
- **Secrets exposure**: No real API keys, tokens, or passwords hardcoded in source. Placeholder/example values, checksums, env var names, and test fixtures are NOT secrets.
- **Unsafe code execution**: No \`eval()\`, \`new Function()\`, or dynamic code execution on any input. \`JSON.parse\` is safe to use — validate the parsed result before using it in security-sensitive operations (file paths, shell commands, SQL). Simple \`JSON.parse\` with try/catch is acceptable.
- **Permission escalation**: Do not set overly permissive modes (e.g., 0o777) or disable security controls. Default permissions (0o644 files, 0o755 executables) are acceptable.
- **Information leakage**: For HTTP/API responses, do not expose stack traces or internal paths. For CLI output, showing file paths and error details is expected and helpful — only ensure credentials are never logged.
- **Dependency hygiene** (advisory only): If new dependencies are added, list them as a note and suggest alternatives if known. Do NOT reject solely for dependency choice.

If you find a genuine vulnerability where an attacker could exploit the NEW code to gain unauthorized access, execute arbitrary code, or exfiltrate data — **REJECT** with a clear explanation and remediation steps. If the coder's notes explain why a flagged pattern is safe in context, evaluate their justification before rejecting. If you are uncertain, describe the concern as a security note rather than rejecting on uncertainty alone.
${getTestCoverageInstructions(config, modifiedFiles)}
---

## Your Decision

Your first non-empty line MUST be an explicit decision token in this exact format:
- \`DECISION: APPROVE\`
- \`DECISION: REJECT\`
- \`DECISION: DISPUTE\`
- \`DECISION: SKIP\`

After the decision token, include the matching details below.

### APPROVE (implementation is correct)
If the code correctly implements the specification:
**Output:**
\`\`\`
DECISION: APPROVE
APPROVE - Implementation meets all requirements
\`\`\`

### APPROVE WITH NOTE (minor issues, not blocking)
If you have minor concerns but the implementation is acceptable:
**Output:**
\`\`\`
DECISION: APPROVE
APPROVE - <your feedback here>
\`\`\`

### SKIP (external setup required)
If the coder requested a SKIP and it's legitimate:
1. **Verify** the spec section says SKIP, MANUAL, or requires external action
2. **Verify** the skip notes explain WHAT human action is needed
3. If valid:
**Output:**
\`\`\`
DECISION: SKIP
SKIP - Verified: spec says SKIP. Human must [action]. Approved to unblock pipeline.
\`\`\`

### REJECT (needs changes)
If there are issues that must be fixed:
**Output:** \`DECISION: REJECT\` followed by specific feedback

**CRITICAL: Format rejection feedback with checkboxes for EACH actionable item:**

\`\`\`
- [ ] [NEW] Fix type error in src/foo.ts:42 - change \`string\` to \`number\`
- [ ] [UNRESOLVED] src/bar.ts:15 still dereferences \`.data\` without null check (same issue from prior review; verified in current diff)
- [ ] [NEW] Add unit test for the new \`processItem()\` function
- [ ] [NEW] Remove unused import on line 3
\`\`\`

**Why checkboxes?** The coder will use these to verify they've addressed EVERY issue before resubmitting. Each checkbox = one specific action.

**Rules for rejection notes:**
1. One checkbox per actionable item (not paragraphs of prose)
2. Start each checkbox with \`[NEW]\` or \`[UNRESOLVED]\`
3. For each \`[UNRESOLVED]\` item, include evidence of what remains broken now (file:line or concrete behavior)
4. Include file:line references where applicable
5. Be specific about WHAT to change, not just WHAT is wrong
6. Group related items logically

This will be rejection #${task.rejection_count + 1}.

### DISPUTE (fundamental disagreement)
Only if there's a genuine specification or architecture conflict:
**Output:**
\`\`\`
DECISION: DISPUTE
DISPUTE - <explanation>
\`\`\`

Use sparingly. Most issues should be resolved via reject/fix cycle.

**The orchestrator will parse your decision and update task status accordingly. Do NOT run any \`steroids tasks\` commands.**

---

## CRITICAL RULES

1. **NEVER modify code yourself** - only review it
2. **Be specific in rejection notes** - vague feedback wastes cycles
3. **Approve if it works** - don't reject for style preferences
4. **You MUST include an explicit decision token** (\`DECISION: APPROVE|REJECT|DISPUTE|SKIP\`)
5. **Verify coder's claims** - if coder says work exists in a commit, CHECK IT before rejecting
6. **Empty diff ≠ no work** - work may exist in earlier commits the coder referenced
7. **SKIP requests are valid** - if spec says SKIP/manual, approve the skip to unblock the pipeline
8. **Don't reject skips for infrastructure tasks** - Cloud SQL, GKE, etc. truly need human action
9. **DO NOT run any \`steroids tasks\` commands** - the orchestrator handles all status updates

---

## Feedback Notes

**After making your decision**, you may include feedback notes for anything a human should review later. These are advisory only and will NOT block the pipeline.

Include feedback notes when you notice:
- A pre-existing security concern in unchanged code
- A minor design dispute even if you approved
- Something uncertain that a human should verify
- A suggestion the coder should consider for a future task

Simply include these as notes in your decision output. They will be logged for human review.

---

## Review Now

Examine the diff above, then output your explicit decision token first, followed by any notes.
The orchestrator will parse your decision and update task status accordingly.
`;
}

/**
 * Context for batch reviewer prompts
 */
export interface BatchReviewerPromptContext {
  tasks: Task[];
  projectPath: string;
  sectionName: string;
  gitDiff: string;
  modifiedFiles: string[];
  config: SteroidsConfig;
}

/**
 * Generate the reviewer prompt for a batch of tasks
 */
export function generateBatchReviewerPrompt(context: BatchReviewerPromptContext): string {
  const { tasks, projectPath, sectionName, gitDiff, modifiedFiles, config } = context;

  // Build task specs for each task
  const taskSpecs = tasks.map((task, index) => {
    const sourceContent = getSourceFileContent(projectPath, task.source_file);
    return `
### Task ${index + 1}: ${task.title}
**Task ID:** ${task.id}
**Spec File:** ${task.source_file ?? '(not specified)'}

${sourceContent}
`;
  }).join('\n---\n');

  // Truncate diff if too long
  let diffContent = gitDiff;
  if (diffContent.length > 30000) {
    diffContent = diffContent.substring(0, 30000) + '\n\n[Diff truncated - review individual commits for full changes]';
  }

  const filesListFormatted = modifiedFiles.length > 0
    ? modifiedFiles.map(f => `- ${f}`).join('\n')
    : 'No files modified';

  const taskIds = tasks.map(t => t.id);

  return `# STEROIDS BATCH REVIEWER TASK

You are a REVIEWER reviewing MULTIPLE tasks from section "${sectionName}".

**IMPORTANT:** Review all changes as a cohesive unit. The coder implemented all these tasks together.

## Section: ${sectionName}
**Total Tasks:** ${tasks.length}
**Project:** ${projectPath}

---

## TASKS BEING REVIEWED

${taskSpecs}

---

## Combined Changes (All Tasks)

\`\`\`diff
${diffContent}
\`\`\`

---

## Files Modified

${filesListFormatted}

---
${getTestCoverageInstructions(config, modifiedFiles)}
## Review Checklist (For Each Task)

For EACH task, verify:
1. Does the implementation match the specification?
2. Are there bugs, security issues, or logic errors?
3. Are tests present and adequate (if project requires tests)?
4. Does code follow project guidelines?
5. Are all files under 500 lines?

---

## YOUR WORKFLOW

Review all tasks, then state your decision for EACH one:

**For each task that passes review:**
Output: "APPROVE <task-id> - Implementation correct"

**For each task that needs changes:**
Output: "REJECT <task-id>" followed by checkbox list:
\`\`\`
- [ ] specific issue 1
- [ ] specific issue 2
\`\`\`

**CRITICAL:** You MUST state a decision for EACH task. Use checkboxes in rejection notes. The orchestrator will parse your decisions and update task status accordingly.

---

## TASK IDS

${taskIds.map((id, i) => `- Task ${i + 1}: ${id}`).join('\n')}

---

## CRITICAL RULES

1. **NEVER modify code yourself** - only review it
2. **Review ALL tasks** - don't skip any
3. **Be specific in rejection notes** - use checkboxes for each issue
4. **Consider tasks as a unit** - they were implemented together
5. **You MUST state approve/reject for EACH task**
6. **DO NOT run \`steroids tasks\` commands** - the orchestrator handles status updates

---

## Review Now

Examine the diff, verify each task's specification is met, then clearly state your decision for each task.
The orchestrator will parse your decisions and update task status accordingly.
`;
}
