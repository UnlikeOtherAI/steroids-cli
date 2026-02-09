/**
 * Coder prompt templates
 * Following the exact templates from PROMPTS.md
 */

import type { Task, RejectionEntry } from '../database/queries.js';
import {
  getAgentsMd,
  getSourceFileContent,
  buildFileScopeSection,
  formatRejectionHistoryForCoder,
} from './prompt-helpers.js';

export interface CoderPromptContext {
  task: Task;
  projectPath: string;
  previousStatus: string;
  rejectionNotes?: string;
  rejectionHistory?: RejectionEntry[];  // Full rejection history
  coordinatorGuidance?: string;  // Guidance from coordinator after repeated rejections
  gitStatus?: string;
  gitDiff?: string;
}

/**
 * Generate the coder prompt for a new task
 */
export function generateCoderPrompt(context: CoderPromptContext): string {
  const { task, projectPath, previousStatus, rejectionNotes, rejectionHistory, coordinatorGuidance } = context;

  const agentsMd = getAgentsMd(projectPath);
  const sourceContent = getSourceFileContent(projectPath, task.source_file);

  // Build rejection section with full history and coordinator guidance
  const rejectionSection = formatRejectionHistoryForCoder(task.id, rejectionHistory, rejectionNotes, coordinatorGuidance);

  // Build file scope section
  const fileScopeSection = buildFileScopeSection(task, sourceContent);

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title}
# Status: ${previousStatus} → in_progress | Rejections: ${task.rejection_count}/15

You are a CODER in an automated task execution system. Your job is to implement the task below according to the specification.

**Follow the project's existing architecture and patterns.** Read AGENTS.md and existing code to understand how things are structured before making changes.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}
${fileScopeSection}
---

## Specification

The full specification is in: ${task.source_file ?? '(not specified)'}

${sourceContent}

---

## Project Guidelines

${agentsMd}

---

## Existing Code Context

Review relevant project files as needed for your implementation.
${rejectionSection}
---

## FIRST: Check If Work Is Already Done

**Before implementing anything, check if the work already exists:**

1. Search for files/code that match the specification requirements
2. Run \`git log --oneline -20\` to see recent commits
3. If the implementation already exists:
   - Identify which commit contains the work (you NEED the hash)
   - Verify it matches the specification with \`git show <hash>\`
   - **Do NOT create duplicate code**
   - Submit for review with a note including the commit hash AND file list

\`\`\`bash
# Example: If work exists in commit abc1234
git log --oneline -20  # Find commits
git show abc1234 --stat  # Verify it matches spec, note the files

# IMPORTANT: Include commit hash and files in your notes
steroids tasks update ${task.id} --status review --notes "Work exists in commit abc1234. Files: src/foo.ts, src/bar.ts. Verified against spec."
\`\`\`

The reviewer will check the commit you reference. Be precise about the hash and files.

---

## Your Instructions (If Work Is NOT Already Done)

1. Read the specification carefully
2. Implement the feature/fix as specified
3. Write tests if the project has a test directory
4. Keep files under 500 lines
5. Follow the coding standards in AGENTS.md

---

## Attempt Before Skip (IMPORTANT)

**You MUST attempt any task that can be run locally, even if it might fail.**

Many tasks look like they need external setup, but they're actually runnable commands. Your job is to TRY them first.

**The rule is simple:** If you can type a command and hit Enter, ATTEMPT IT.

Even if it fails, that failure is valuable information. The reviewer wants to see that you tried.

**Only skip when the task TRULY requires external action you cannot perform** (e.g., cloud console access, DNS configuration, account creation).

**BEFORE skipping, check the spec section for:**
- \`> SKIP\` markers, "manual setup", "handled manually", "external setup"
- Cloud infrastructure tasks with NO automation scripts provided

**If you must skip:**
\`\`\`bash
steroids tasks skip ${task.id} --notes "SKIP REASON: <why>. WHAT'S NEEDED: <human action>. BLOCKING: <dependent tasks>."
\`\`\`

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory** (no .db, .yaml, .yml files)
2. **BUILD MUST PASS before submitting** (run build and tests, fix errors)
3. **Use CLI for status updates:** \`steroids tasks update ${task.id} --status review\`
4. **Commit your work** with a meaningful message before submitting
5. **Never modify TODO.md directly** - the CLI manages task status

---

## When You Are Done

**Verify the project builds AND tests pass, then:**

\`\`\`bash
git add <your-changed-files>
git commit -m "<type>: <descriptive message>"
steroids tasks update ${task.id} --status review
\`\`\`

If you do NOT run \`steroids tasks update\`, your work will not be submitted.

---
${task.rejection_count > 0 ? `
## THIS TASK HAS BEEN REJECTED ${task.rejection_count} TIME(S)

**You MUST address the reviewer's feedback before submitting again.**
Extract every test case from the rejection notes, run each one, fix issues at the source, then test again.

` : ''}---

## Start Now

Begin by reading ${task.source_file ?? 'the specification above'} and implementing the task.
`;
}

/**
 * Context for batch coder prompts
 */
export interface BatchCoderPromptContext {
  tasks: Task[];
  projectPath: string;
  sectionName: string;
}

/**
 * Generate the coder prompt for a batch of tasks
 */
export function generateBatchCoderPrompt(context: BatchCoderPromptContext): string {
  const { tasks, projectPath, sectionName } = context;

  const agentsMd = getAgentsMd(projectPath);

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

  const taskIds = tasks.map(t => t.id);

  return `# STEROIDS BATCH CODER TASK

You are a CODER assigned MULTIPLE tasks from section "${sectionName}".

**IMPORTANT:** Implement each task IN ORDER, committing after each one.

## Section: ${sectionName}
**Total Tasks:** ${tasks.length}
**Project:** ${projectPath}

---

## Project Guidelines

${agentsMd}

---

## TASKS TO IMPLEMENT

${taskSpecs}

---

## YOUR WORKFLOW

For EACH task:
1. Read the specification
2. Implement the feature/fix
3. Run tests if applicable
4. Commit: \`git add <files> && git commit -m "<type>: <message>"\`
5. Update status: \`steroids tasks update <task-id> --status review\`
6. Move to next task

**CRITICAL:** Each task MUST have its own commit and status update.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **BUILD MUST PASS after each task**
3. **Commit after EACH task** with a descriptive message
4. **Update status after EACH commit**

---

## TASK IDS

${taskIds.map((id, i) => `- Task ${i + 1}: ${id}`).join('\n')}

---

## Start Now

Begin with Task 1 and work through each task in order.
`;
}

/**
 * Generate the coder prompt for resuming partial work
 */
export function generateResumingCoderPrompt(context: CoderPromptContext): string {
  const { task, projectPath, gitStatus, gitDiff } = context;

  const sourceContent = getSourceFileContent(projectPath, task.source_file);

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title} (RESUMING)

You are a CODER resuming work on a partially completed task.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Status:** in_progress (resuming)
**Project:** ${projectPath}

---

## Previous Work Detected

A previous coder started this task but did not complete it. You may find:
- Uncommitted changes in the working directory
- Partial implementations in progress

**Git Status:**
\`\`\`
${gitStatus ?? 'No uncommitted changes'}
\`\`\`

**Uncommitted Changes:**
\`\`\`diff
${gitDiff ?? 'No changes'}
\`\`\`

---

## Your Instructions

1. Review what the previous coder did
2. If the work looks good, complete it
3. If the work looks wrong, you may start fresh
4. Commit all changes when done

---

## Specification

${sourceContent}

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **Commit your work before submitting**
3. **Run \`steroids tasks update ${task.id} --status review\` when done**

If you do NOT update the task status, you will be restarted.

---

## Complete the Task Now

Review the existing work and finish the implementation.
`;
}
