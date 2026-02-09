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
 * Makes coordinator decisions visible and enforceable by the reviewer
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

**You MUST consider this when making your decision:**
- If the coordinator decided **override_reviewer**: do NOT re-raise the issues the coordinator flagged as out of scope or unachievable. Those demands have been ruled invalid.
- If the coordinator decided **narrow_scope**: evaluate the coder's work against the NARROWED scope described above, not the original full scope.
- If the coordinator decided **guide_coder**: the coder was given specific direction - check whether they followed it.
- You may still reject for NEW issues not addressed by the coordinator, but do not contradict the coordinator's ruling.

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

## Security Review (MANDATORY)

**You MUST check the coder's changes for security vulnerabilities.** Reject if any are found.

Check for:
- **Injection attacks**: SQL injection, command injection (shell commands built from user input), XSS, template injection
- **Shell safety**: Prefer \`execFileSync\` (array args) over \`execSync\` (string interpolation) when passing user-controlled values
- **Path traversal**: User-supplied file paths must be validated and confined to the project directory (no \`../\` escape)
- **Secrets exposure**: No hardcoded API keys, tokens, passwords, or credentials in code or config files
- **Unsafe deserialization**: No \`eval()\`, \`new Function()\`, or \`JSON.parse\` on untrusted input without validation
- **Permission escalation**: Code should not grant broader access than necessary (file permissions, API scopes, etc.)
- **Information leakage**: Error messages and logs should not expose internal paths, stack traces, or sensitive data to end users
- **Dependency hygiene** (advisory only): If new dependencies are added, note whether they appear well-known and maintained. Flag potential typosquatting but do NOT reject solely for dependency choice — just highlight it as a note and suggest a more established alternative if one exists

If you find a security vulnerability in the items above (excluding the advisory item), **REJECT immediately** with a clear explanation and remediation steps. Security vulnerabilities are never "minor".
${getTestCoverageInstructions(config, modifiedFiles)}
---

## Your Decision

You MUST run ONE of these commands to record your decision:

### APPROVE (implementation is correct)
If the code correctly implements the specification:
\`\`\`bash
steroids tasks approve ${task.id} --model codex
\`\`\`

### APPROVE WITH NOTE (minor issues, not blocking)
If you have minor concerns but the implementation is acceptable:
\`\`\`bash
steroids tasks approve ${task.id} --model codex --notes "Minor: your feedback here"
\`\`\`

### APPROVE SKIP (external setup required)
If the coder requested a SKIP and it's legitimate:
1. **Verify** the spec section says SKIP, MANUAL, or requires external action
2. **Verify** the skip notes explain WHAT human action is needed
3. If valid:
\`\`\`bash
steroids tasks skip ${task.id} --notes "Verified: spec says SKIP. Human must [action]. Approved to unblock pipeline."
\`\`\`

For **partial** skips (coder did some work, rest is external):
1. **Review the code** the coder submitted - it must be correct
2. **Verify** the external part truly cannot be automated
3. If valid:
\`\`\`bash
steroids tasks skip ${task.id} --partial --notes "Code reviewed and correct. External setup verified as manual-only."
\`\`\`

### REJECT (needs changes)
If there are issues that must be fixed:
\`\`\`bash
steroids tasks reject ${task.id} --model codex --notes "specific feedback for coder"
\`\`\`

**CRITICAL: Format rejection notes with checkboxes for EACH actionable item:**

\`\`\`
- [ ] Fix type error in src/foo.ts:42 - change \`string\` to \`number\`
- [ ] Add missing null check in src/bar.ts:15 before accessing \`.data\`
- [ ] Add unit test for the new \`processItem()\` function
- [ ] Remove unused import on line 3
\`\`\`

**Why checkboxes?** The coder will use these to verify they've addressed EVERY issue before resubmitting. Each checkbox = one specific action.

**Rules for rejection notes:**
1. One checkbox per actionable item (not paragraphs of prose)
2. Include file:line references where applicable
3. Be specific about WHAT to change, not just WHAT is wrong
4. Group related items logically

This will be rejection #${task.rejection_count + 1}.

### DISPUTE (fundamental disagreement)
Only if there's a genuine specification or architecture conflict:
\`\`\`bash
steroids dispute create ${task.id} --reason "explanation" --type reviewer
\`\`\`
Use sparingly. Most issues should be resolved via reject/fix cycle.

---

## CRITICAL RULES

1. **NEVER modify code yourself** - only review it
2. **Be specific in rejection notes** - vague feedback wastes cycles
3. **Approve if it works** - don't reject for style preferences
4. **You MUST run one of the commands above** to record your decision
5. **Verify coder's claims** - if coder says work exists in a commit, CHECK IT before rejecting
6. **Empty diff ≠ no work** - work may exist in earlier commits the coder referenced
7. **SKIP requests are valid** - if spec says SKIP/manual, approve the skip to unblock the pipeline
8. **Don't reject skips for infrastructure tasks** - Cloud SQL, GKE, etc. truly need human action

If you do NOT run a command, the task will remain in review and you will be invoked again.

---

## Review Now

Examine the diff above, then run the appropriate command to record your decision.
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

Review all tasks, then record your decision for EACH one:

**For each task that passes review:**
\`\`\`bash
steroids tasks approve <task-id> --model codex
\`\`\`

**For each task that needs changes:**
\`\`\`bash
steroids tasks reject <task-id> --model codex --notes "- [ ] specific issue 1
- [ ] specific issue 2"
\`\`\`

**CRITICAL:** You MUST run a command for EACH task. Use checkboxes in rejection notes.

---

## TASK IDS

${taskIds.map((id, i) => `- Task ${i + 1}: ${id}`).join('\n')}

---

## CRITICAL RULES

1. **NEVER modify code yourself** - only review it
2. **Review ALL tasks** - don't skip any
3. **Be specific in rejection notes** - use checkboxes for each issue
4. **Consider tasks as a unit** - they were implemented together
5. **You MUST run approve/reject for EACH task**

---

## Review Now

Examine the diff, verify each task's specification is met, then run the appropriate commands.
`;
}
