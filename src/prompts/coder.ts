/**
 * Coder prompt templates
 * Following the exact templates from PROMPTS.md
 */

import type { Task, RejectionEntry } from '../database/queries.js';
import {
  getAgentsMd,
  getSourceFileReference,
  buildFileScopeSection,
  buildFileAnchorSection,
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
 * Generate a minimal delta prompt for a resumed coder session
 */
export function generateResumingCoderDeltaPrompt(context: CoderPromptContext): string {
  const { task, rejectionHistory, coordinatorGuidance } = context;

  // Find the last rejection notes
  const lastRejection = rejectionHistory && rejectionHistory.length > 0
    ? rejectionHistory[rejectionHistory.length - 1]
    : null;

  if (!lastRejection && !coordinatorGuidance) {
    // If no rejection and no guidance, just a general "resume" prompt
    return `You are resuming work on task ${task.id}: "${task.title}".
All previous context is still in your session history.
Review your previous progress and complete the task.

**REMINDER:**
1. BUILD MUST PASS before submitting
2. COMMIT YOUR WORK with a descriptive message
3. Output "TASK COMPLETE" when finished
`;
  }

  let prompt = `The reviewer rejected your last submission for task ${task.id}: "${task.title}".\n\n`;

  if (lastRejection) {
    prompt += `**Rejection #${lastRejection.rejection_number} notes:**
"${lastRejection.notes}"\n\n`;
  }

  if (coordinatorGuidance) {
    prompt += `**Coordinator guidance:**
"${coordinatorGuidance}"\n\n`;
  }

  if (coordinatorGuidance?.includes('MUST_IMPLEMENT:')) {
    prompt += `**MANDATORY OVERRIDE:** Items listed under MUST_IMPLEMENT are required before resubmission.
Do not mark those items as WONT_FIX unless you provide hard new evidence and the orchestrator explicitly clears them.\n\n`;
  }

  prompt += `Fix these issues and resubmit. All previous context and code is still in your session.

**REMINDER:**
1. Address ALL reviewer feedback
2. BUILD MUST PASS before submitting
3. COMMIT YOUR WORK with a descriptive message
4. Include this exact contract block:
   \`\`\`
   ## REJECTION_RESPONSE
   ITEM-1 | IMPLEMENTED | <file:line> | <what changed>
   ITEM-2 | WONT_FIX | <exceptional reason + proof solution still works>
   \`\`\`
   - Every reviewer checkbox item must have one matching \`ITEM-<n>\` response.
   - \`WONT_FIX\` is a high bar and requires an exceptional, concrete explanation.
   - If coordinator guidance includes \`MUST_IMPLEMENT:\`, those items are mandatory and should not be marked \`WONT_FIX\`.
5. Output "TASK COMPLETE" when finished
`;

  return prompt;
}

/**
 * Generate the coder prompt for a new task
 */
export function generateCoderPrompt(context: CoderPromptContext): string {
  const { task, projectPath, previousStatus, rejectionNotes, rejectionHistory, coordinatorGuidance } = context;

  const agentsMd = getAgentsMd(projectPath);
  const sourceRef = getSourceFileReference(projectPath, task.source_file);

  // Build rejection section with full history and coordinator guidance
  const rejectionSection = formatRejectionHistoryForCoder(task.id, rejectionHistory, rejectionNotes, coordinatorGuidance);

  // Build file scope section
  const fileScopeSection = buildFileScopeSection(task);
  const fileAnchorSection = buildFileAnchorSection(task);

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
${fileScopeSection}${fileAnchorSection}
---

## Specification

${sourceRef}

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

**IF THE WORK ALREADY EXISTS:**

1. Verify it matches the spec:

\`\`\`bash
git log --oneline -20  # Find the commit hash
git show <commit-hash> --stat  # Verify it matches the spec
\`\`\`

2. Note which commit contains the work in your response
3. **Do NOT implement duplicate code** - state "TASK COMPLETE" and the orchestrator will submit for review

---

**IF THE WORK DOES NOT EXIST, CONTINUE BELOW:**

---

## Your Instructions (If Work Is NOT Already Done)

1. Read the specification carefully
2. Implement the feature/fix as specified
3. Write tests if the project has a test directory
4. Keep files under 500 lines
5. Follow the coding standards in AGENTS.md

### Security Notes

- When executing shell commands with user-controlled arguments, use array-based APIs (e.g., \`execFileSync(cmd, [args])\`). Add a comment like \`// hardcoded command, no user input\` when using \`execSync\` intentionally for fixed commands or shell features.
- If you make a security-relevant decision (e.g., choosing \`execSync\` over \`execFileSync\` because you need pipes), explain your reasoning in your commit message or output.

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

**If you must skip, output:** "TASK SHOULD BE SKIPPED: <reason>. WHAT'S NEEDED: <human action>."
The orchestrator will handle the skip status.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory** (no .db, .yaml, .yml files)
2. **BUILD MUST PASS before submitting** (run build and tests, fix errors)
3. **COMMIT YOUR WORK** with a meaningful message when complete
4. **DO NOT run any \`steroids tasks\` commands** - the orchestrator handles all status updates
5. **Never modify TODO.md directly** - the CLI manages task status

---

## When You Are Done

**Verify the project builds AND tests pass, then commit your work:**

\`\`\`bash
git add <your-changed-files>
git commit -m "<type>: <descriptive message>"
\`\`\`

**Output "TASK COMPLETE" followed by a summary of your changes.**

The orchestrator will automatically detect your completion and submit the task for review. Do NOT run any \`steroids tasks\` commands - the orchestrator handles all status updates.

---
${task.rejection_count === 0 ? `
## FIRST SUBMISSION SELF-CHECKLIST (REQUIRED)

Before "TASK COMPLETE", include:

\`\`\`
## SELF_REVIEW_CHECKLIST
- [x] <requirement 1 from the task spec>
- [x] <requirement 2 from the task spec>
- [x] <tests/build evidence for this task>
- [x] Self-review complete: I verified all requested behavior works.
\`\`\`

This checklist must reflect the actual specification, not generic boilerplate.

` : ''}${task.rejection_count > 0 ? `
## THIS TASK HAS BEEN REJECTED ${task.rejection_count} TIME(S)

**You MUST address the reviewer's feedback before submitting again.**
Extract every test case from the rejection notes, run each one, fix issues at the source, then test again.

**REQUIRED OUTPUT CONTRACT FOR RESUBMISSION:**

\`\`\`
## REJECTION_RESPONSE
ITEM-1 | IMPLEMENTED | src/file.ts:42 | fixed null-check and added guard
ITEM-2 | WONT_FIX | exceptional reason + proof solution still works
\`\`\`

Rules:
- Every reviewer checkbox item must have one matching \`ITEM-<n>\` response.
- \`WONT_FIX\` is a high bar and requires an exceptional, concrete explanation.
- If coordinator guidance includes \`MUST_IMPLEMENT:\`, those items are mandatory and should not be marked \`WONT_FIX\`.

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
    const specRef = getSourceFileReference(projectPath, task.source_file);
    return `
### Task ${index + 1}: ${task.title}
**Task ID:** ${task.id}

${specRef}
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
5. Output "TASK COMPLETE: <task-id>" when done
6. Move to next task

**CRITICAL:** Each task MUST have its own commit. The orchestrator will handle status updates.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **BUILD MUST PASS after each task**
3. **Commit after EACH task** with a descriptive message
4. **DO NOT run \`steroids tasks\` commands** - the orchestrator handles status

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
  const { task, projectPath, gitStatus, gitDiff, rejectionHistory, coordinatorGuidance } = context;

  const sourceRef = getSourceFileReference(projectPath, task.source_file);
  const fileAnchorSection = buildFileAnchorSection(task);

  // Build rejection section with full history and coordinator guidance (same as normal prompt)
  const rejectionSection = formatRejectionHistoryForCoder(task.id, rejectionHistory, undefined, coordinatorGuidance);

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title} (RESUMING)
# Status: resuming | Rejections: ${task.rejection_count}/15

You are a CODER resuming work on a partially completed task.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Status:** in_progress (resuming)
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}
${fileAnchorSection}
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
5. If this task has rejections, include a \`## REJECTION_RESPONSE\` block with one line per reviewer item (\`IMPLEMENTED\` or \`WONT_FIX\` with strong justification)
${rejectionSection}
---

${task.rejection_count > 0 ? `## REQUIRED OUTPUT CONTRACT FOR RESUBMISSION

\`\`\`
## REJECTION_RESPONSE
ITEM-1 | IMPLEMENTED | src/file.ts:42 | fixed null-check and added guard
ITEM-2 | WONT_FIX | exceptional reason + proof solution still works
\`\`\`

Rules:
- Every reviewer checkbox item must have one matching \`ITEM-<n>\` response.
- \`WONT_FIX\` is a high bar and requires an exceptional, concrete explanation.
- If coordinator guidance includes \`MUST_IMPLEMENT:\`, those items are mandatory and should not be marked \`WONT_FIX\`.

---
` : ''}${coordinatorGuidance?.includes('MUST_IMPLEMENT:') ? `## MANDATORY OVERRIDE

You MUST implement the items listed under \`MUST_IMPLEMENT:\` before resubmitting.

---
` : ''} 

## Specification

${sourceRef}

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **COMMIT YOUR WORK** when complete
3. **Output "TASK COMPLETE"** when done - the orchestrator will submit for review
4. **DO NOT run any \`steroids tasks\` commands** - the orchestrator handles all status updates

---

## Complete the Task Now

Review the existing work and finish the implementation.
`;
}
