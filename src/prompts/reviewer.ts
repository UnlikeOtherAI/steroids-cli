/**
 * Reviewer prompt templates
 * Following the exact templates from PROMPTS.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, RejectionEntry } from '../database/queries.js';
import type { SteroidsConfig } from '../config/loader.js';

export interface SectionTask {
  id: string;
  title: string;
  status: string;
}

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
}

/**
 * Read source file content if specified
 */
function getSourceFileContent(
  projectPath: string,
  sourceFile?: string | null
): string {
  if (!sourceFile) {
    return 'No specification file linked.';
  }

  const fullPath = join(projectPath, sourceFile);
  if (!existsSync(fullPath)) {
    return `Specification file not found: ${sourceFile}`;
  }

  const content = readFileSync(fullPath, 'utf-8');
  // Truncate if too long (max 10000 chars per spec)
  if (content.length > 10000) {
    return content.substring(0, 10000) + `\n\n[Content truncated. Full file at: ${sourceFile}]`;
  }
  return content;
}

// Maximum tasks to show in section context (prevents prompt bloat)
const MAX_SECTION_TASKS = 15;

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
${rejections.length >= 5 ? `
**⚠️ HIGH REJECTION COUNT (${rejections.length})** - Consider explaining from a different angle
` : ''}`;

  return `
---

## Rejection History

**IMPORTANT:** Review this history carefully before making your decision.
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
function formatSectionTasks(currentTaskId: string, sectionTasks?: SectionTask[]): string {
  if (!sectionTasks || sectionTasks.length <= 1) {
    return '';
  }

  const statusEmoji: Record<string, string> = {
    'pending': '⏳',
    'in_progress': '🔄',
    'review': '👀',
    'completed': '✅',
  };

  const otherTasks = sectionTasks.filter(t => t.id !== currentTaskId);
  const tasksToShow = otherTasks.slice(0, MAX_SECTION_TASKS);
  const remainingCount = otherTasks.length - tasksToShow.length;

  const lines = tasksToShow.map(t => {
    const emoji = statusEmoji[t.status] || '❓';
    const marker = t.status === 'completed' ? ' (done)' : t.status === 'pending' ? ' (pending)' : '';
    return `- ${emoji} ${t.title}${marker}`;
  });

  if (remainingCount > 0) {
    lines.push(`- ... and ${remainingCount} more task${remainingCount > 1 ? 's' : ''}`);
  }

  if (lines.length === 0) return '';

  return `
---

## Other Tasks in This Section

**IMPORTANT:** The task you are reviewing is ONE of several tasks implementing this feature.
Do NOT reject this task for issues that are explicitly listed as separate tasks below.
Focus ONLY on whether THIS task's scope is correctly implemented.

${lines.join('\n')}

`;
}

/**
 * Generate test coverage instructions if required
 */
function getTestCoverageInstructions(config: SteroidsConfig): string {
  if (!config.quality?.tests?.required) {
    return '';
  }

  const minCoverageNote = config.quality.tests.minCoverage !== undefined
    ? `- Minimum coverage: ${config.quality.tests.minCoverage}%`
    : '';

  return `

## Test Coverage (REQUIRED)

**This project requires tests for new code:**
- Verify new functionality has corresponding tests
- Tests must actually exercise the new code paths
${minCoverageNote}
- REJECT if tests are missing or inadequate
`;
}

/**
 * Generate the reviewer prompt
 */
export function generateReviewerPrompt(context: ReviewerPromptContext): string {
  const { task, projectPath, reviewerModel, gitDiff, modifiedFiles, sectionTasks, rejectionHistory, submissionNotes, config } = context;

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

  // Truncate diff if too long (max 20000 chars per spec)
  let diffContent = gitDiff;
  if (diffContent.length > 20000) {
    diffContent = diffContent.substring(0, 20000) + '\n\n[Diff truncated]';
  }

  const filesListFormatted = modifiedFiles.length > 0
    ? modifiedFiles.map(f => `- ${f}`).join('\n')
    : 'No files modified';

  return `# STEROIDS REVIEWER TASK

You are a REVIEWER in an automated task execution system. Your job is to verify the coder's implementation matches the specification.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Status:** review (submitted by coder)
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}
${formatSectionTasks(task.id, sectionTasks)}${formatRejectionHistory(rejectionHistory)}${submissionNotesSection}
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
2. Are there bugs, security issues, or logic errors?
3. Are tests present and adequate?
4. Does code follow AGENTS.md guidelines?
5. Are all files under 500 lines?
${getTestCoverageInstructions(config)}
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
${getTestCoverageInstructions(config)}
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
