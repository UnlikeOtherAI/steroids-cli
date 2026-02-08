/**
 * Reviewer prompt templates
 * Following the exact templates from PROMPTS.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, RejectionEntry } from '../database/queries.js';

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
 * Generate the reviewer prompt
 */
export function generateReviewerPrompt(context: ReviewerPromptContext): string {
  const { task, projectPath, reviewerModel, gitDiff, modifiedFiles, sectionTasks, rejectionHistory } = context;

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
${formatSectionTasks(task.id, sectionTasks)}${formatRejectionHistory(rejectionHistory)}
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

### REJECT (needs changes)
If there are issues that must be fixed:
\`\`\`bash
steroids tasks reject ${task.id} --model codex --notes "specific feedback for coder"
\`\`\`
Be specific in your notes. The coder will use them to fix the issues.
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

If you do NOT run a command, the task will remain in review and you will be invoked again.

---

## Review Now

Examine the diff above, then run the appropriate command to record your decision.
`;
}
