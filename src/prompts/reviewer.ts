/**
 * Reviewer prompt templates
 * Following the exact templates from PROMPTS.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';

export interface ReviewerPromptContext {
  task: Task;
  projectPath: string;
  reviewerModel: string;
  gitDiff: string;
  modifiedFiles: string[];
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

/**
 * Generate the reviewer prompt
 */
export function generateReviewerPrompt(context: ReviewerPromptContext): string {
  const { task, projectPath, reviewerModel, gitDiff, modifiedFiles } = context;

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

---

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

After reviewing, you MUST output ONE of these decisions:

### APPROVE (implementation is correct)
If the code correctly implements the specification:
\`\`\`
DECISION: APPROVE
\`\`\`

### APPROVE WITH NOTE (minor issues, not blocking)
If you have minor concerns but the implementation is acceptable:
\`\`\`
DECISION: APPROVE
Notes: [your minor feedback here]
\`\`\`

### REJECT (needs changes)
If there are issues that must be fixed:
\`\`\`
DECISION: REJECT
Notes: [specific feedback for the coder]
\`\`\`
Be specific in your notes. The coder will use them to fix the issues.
This will be rejection #${task.rejection_count + 1}.

### DISPUTE (fundamental disagreement)
Only if there's a genuine specification or architecture conflict:
\`\`\`
DECISION: DISPUTE
Reason: [explanation of the conflict]
\`\`\`
Use sparingly. Most issues should be resolved via reject/fix cycle.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **NEVER modify code yourself** - only review it
3. **Be specific in rejection notes** - vague feedback wastes cycles
4. **Approve if it works** - don't reject for style preferences
5. **You MUST output a DECISION block** exactly as shown above

---

## Review Now

Examine the diff above and make your decision. End your response with a DECISION block.
`;
}
