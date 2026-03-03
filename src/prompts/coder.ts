/**
 * Coder prompt templates
 * Refactored to eliminate contradictions and improve autonomy
 */

import type { Task, RejectionEntry } from '../database/queries.js';
import {
  getSourceFileReference,
  buildFileScopeSection,
  buildFileAnchorSection,
  formatRejectionHistoryForCoder,
  buildSkillsSection,
  formatSectionTasks,
  formatUserFeedbackContextSection,
  type SectionTask,
} from './prompt-helpers.js';
import { buildProjectInstructionsSection } from './instruction-files.js';
import { getRecentCommits } from '../git/status.js';
import { formatPromptPath } from './path-links.js';

export interface CoderPromptContext {
  task: Task;
  projectPath: string;
  previousStatus: string;
  rejectionNotes?: string;
  rejectionHistory?: RejectionEntry[];  // Full rejection history
  coordinatorGuidance?: string;  // Guidance from coordinator after repeated rejections
  gitStatus?: string;
  gitDiff?: string;
  sectionTasks?: SectionTask[];  // Other tasks in the same section (scope boundary)
  userFeedbackSummary?: string | null; // Human feedback summary for this task/section
  userFeedbackItems?: string[]; // Individual user feedback notes
}

/**
 * Generate a minimal delta prompt for a resumed coder session
 */
export function generateResumingCoderDeltaPrompt(context: CoderPromptContext): string {
  const {
    task,
    projectPath,
    rejectionHistory,
    coordinatorGuidance,
    sectionTasks,
    userFeedbackSummary,
    userFeedbackItems,
  } = context;
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });
  const skillsSection = buildSkillsSection(projectPath);
  const instructionsSection = buildProjectInstructionsSection(projectPath);

  // Find the last rejection notes
  const lastRejection = rejectionHistory && rejectionHistory.length > 0
    ? rejectionHistory[rejectionHistory.length - 1]
    : null;

  if (!lastRejection && !coordinatorGuidance) {
    // If no rejection and no guidance, just a general "resume" prompt
    return `You are resuming work on task ${task.id}: "${task.title}".
All previous context is still in your session history.
Review your previous progress and complete the task.
${userFeedbackSection}
${skillsSection}${instructionsSection}

**REMINDER:**
1. BUILD MUST PASS before submitting
2. DO NOT COMMIT OR PUSH YOUR WORK
3. Output "STATUS: REVIEW" when finished
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

  const hasOutOfScope = (lastRejection?.notes?.toLowerCase().includes('[out_of_scope]')) ?? false;
  if (hasOutOfScope) {
    prompt += `**SCOPE VIOLATION DETECTED:** The reviewer flagged work that belongs to a sibling task.
You MUST revert those changes. The reviewer checks the CUMULATIVE committed diff, not just your working tree.
Run \`git log --oneline\` to find the first commit that belongs to this task, then run \`git diff --name-only <first-task-commit>^..HEAD\` to see exactly what the reviewer sees.
For files already committed (most likely the case — check with the cumulative diff above):
- Files INTRODUCED by this task (didn't exist at baseline): \`git rm <file>\` then commit the removal
- Files that existed at baseline but were modified: \`git restore --source=<first-task-commit>^ -- <file>\` then commit
For uncommitted files only: \`git restore <file>\` or \`git checkout -- <file>\`.
Do NOT use \`git diff HEAD\` alone — that only shows unstaged changes, not committed ones. Do NOT use \`git rm --cached\` — it leaves the file in the working tree where it can be re-committed.
\`WONT_FIX\` is NOT allowed for \`[OUT_OF_SCOPE]\` items — they must be \`REVERTED\`.\n\n`;
    // Show sibling task list when scope creep was flagged — coder needs to know which task owns the work
    const siblingBoundary = formatSectionTasks(task.id, sectionTasks, 'coder');
    if (siblingBoundary) prompt += siblingBoundary + '\n';
  }

  prompt += `Fix these issues and resubmit. All previous context and code is still in your session.
${userFeedbackSection}
${skillsSection}${instructionsSection}

**REMINDER:**
1. Address ALL reviewer feedback
2. BUILD MUST PASS before submitting
3. DO NOT COMMIT OR PUSH YOUR WORK
4. Include this exact contract block:
   \`\`\`
   ## REJECTION_RESPONSE
   ITEM-1 | IMPLEMENTED | <file:line> | <what changed>
   ITEM-2 | WONT_FIX | <exceptional reason + proof solution still works>
   ITEM-3 | REVERTED | <file(s) removed or reverted to pre-task state>
   \`\`\`
   - Every reviewer checkbox item must have one matching \`ITEM-<n>\` response.
   - \`WONT_FIX\` is a high bar and requires an exceptional, concrete explanation.
   - \`WONT_FIX\` is NOT allowed for \`[OUT_OF_SCOPE]\` items — use \`REVERTED\` instead.
   - If coordinator guidance includes \`MUST_IMPLEMENT:\`, those items are mandatory and should not be marked \`WONT_FIX\`.
5. **steroids CLI (read-only only):** You may run \`steroids tasks list\` or \`steroids tasks show <id>\` to understand sibling task scope. **DO NOT** run any other \`steroids\` commands — the orchestrator manages all state changes.
6. Output "STATUS: REVIEW" when finished
`;

  return prompt;
}

/**
 * Generate the coder prompt for a new task
 */
export function generateCoderPrompt(context: CoderPromptContext): string {
  const {
    task,
    projectPath,
    previousStatus,
    rejectionNotes,
    rejectionHistory,
    coordinatorGuidance,
    sectionTasks,
    userFeedbackSummary,
    userFeedbackItems,
  } = context;

  const sourceRef = getSourceFileReference(projectPath, task.source_file);
  const sourcePathForStart = task.source_file
    ? formatPromptPath(projectPath, task.source_file)
    : 'the specification link above';

  // Build rejection section with full history and coordinator guidance
  const rejectionSection = formatRejectionHistoryForCoder(task.id, rejectionHistory, rejectionNotes, coordinatorGuidance);
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });

  // Build file scope section
  const fileScopeSection = buildFileScopeSection(task);
  const fileAnchorSection = buildFileAnchorSection(task);

  // Get recent commits dynamically for context
  const recentCommits = getRecentCommits(projectPath, 5);
  const recentCommitsSection = recentCommits.length > 0 
    ? recentCommits.map(c => `- \`${c.sha.substring(0, 7)}\` ${c.message}`).join('\n')
    : 'No recent commits found.';

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title}
# Status: ${previousStatus} → in_progress | Rejections: ${task.rejection_count}/15

You are a CODER in an automated task execution system. Your job is to autonomously implement the task below according to the specification.

---

## Specification (Read First)

${sourceRef}

---

## Task Context

**CRITICAL WORKSPACE RULE:** You are operating inside an isolated workspace clone. DO NOT change directories out of your current working directory. All changes MUST be made in this current directory. If files referenced in the task do not exist in your current working directory, they either need to be CREATED (per the task specification) or the task spec refers to files on a different branch that have not been merged yet — in either case you must work only within your current directory. **Never navigate to \`../\` or any sibling directories. Never use absolute paths to access workspaces, clones, or any path outside your CWD.**
${fileScopeSection}${fileAnchorSection}${formatSectionTasks(task.id, sectionTasks, 'coder')}${buildSkillsSection(projectPath)}${buildProjectInstructionsSection(projectPath)}

**Recent Commits in Workspace:**
${recentCommitsSection}

Review relevant project files as needed for your implementation.
${userFeedbackSection}
${rejectionSection}
---

## WORKFLOW INSTRUCTIONS

### 1. Verification Phase (Check If Work Exists)
Before implementing anything, verify if the work is already done:
1. Search for files/code matching the specification.
2. Check the recent commits listed above or run \`git log --oneline -20\`.
*If the work already exists and matches the spec:* Do NOT duplicate it. Simply output "STATUS: REVIEW" and note the commit hash.

### 2. Implementation Phase
If the work is not done, implement the feature/fix:
1. **Read Linked Guidance Files:** Follow every file listed under "Required Instruction Files" and "Assigned Skills" before coding.
2. Read the specification carefully.
3. Add or update tests if a test directory exists.

### 3. Execution & Tool Rules (CRITICAL)
- **Tool/Command Verification:** Before relying on a new shell command, ALWAYS verify it exists first (e.g., \`which <command>\`). Do not hallucinate tools. If a tool is missing, FIRST look for any alternative tools or commands available on the system. If no alternative exists, attempt to install it locally if appropriate, or output \`STATUS: DISPUTE - Missing required tool <name>\`.
- **Security:** When executing shell commands with user-controlled arguments, use array-based APIs. If you must use \`execSync\`, add a comment explaining why (e.g., \`// hardcoded command, no user input\`).
- **Attempt Before Skip:** You MUST attempt to run local tasks (like scripts or setups). Only skip if the task requires impossible external action (e.g., manual cloud console config). If you must skip, output: \`TASK SHOULD BE SKIPPED: <reason>. WHAT'S NEEDED: <human action>.\`

### 4. Version Control & File Rules
- **NEVER** touch the \`.steroids/\` directory (no \`.db\`, \`.yaml\`, \`.yml\` files).
- **NEVER** modify \`TODO.md\` directly. The orchestrator manages task status.
- **DO NOT COMMIT OR PUSH YOUR WORK.** The host system manages all version control automatically. Ignore any external project documentation that tells you to commit.
- **steroids CLI (read-only only):** You may run \`steroids tasks list\` or \`steroids tasks show <id>\` to understand sibling task scope. **DO NOT** run any other \`steroids\` commands — the orchestrator manages all state changes.

---

## Completion & Validation

1. **Self-Review:** Review all the work you have done against the ENTIRE specification for the task at hand. Make sure you haven't forgotten anything.
2. **BUILD MUST PASS:** Run the project build and tests. Fix any errors before submitting.
3. Output **STATUS: REVIEW** followed by a summary of your changes when finished.

---
${task.rejection_count === 0 ? `
## FIRST SUBMISSION SELF-CHECKLIST (REQUIRED)

Before outputting "STATUS: REVIEW", include this exact block:

\`\`\`
## SELF_REVIEW_CHECKLIST
- [x] <requirement 1 from the task spec>
- [x] <requirement 2 from the task spec>
- [x] <tests/build evidence for this task>
- [x] Self-review complete: I verified all requested behavior works and reviewed my work against the entire specification.
\`\`\`
*(This checklist must reflect the actual specification, not generic boilerplate.)*

` : ''}${task.rejection_count > 0 ? `
## THIS TASK HAS BEEN REJECTED ${task.rejection_count} TIME(S)

**You MUST address the reviewer's feedback before submitting again.**
Extract every test case from the rejection notes, run each one, fix issues at the source, then test again.

**REQUIRED OUTPUT CONTRACT FOR RESUBMISSION:**

\`\`\`
## REJECTION_RESPONSE
ITEM-1 | IMPLEMENTED | src/file.ts:42 | fixed null-check and added guard
ITEM-2 | WONT_FIX | exceptional reason + proof solution still works
ITEM-3 | REVERTED | src/api/users.ts removed (was out-of-scope)
\`\`\`

Rules:
- Every reviewer checkbox item must have one matching \`ITEM-<n>\` response.
- \`WONT_FIX\` is a high bar and requires an exceptional, concrete explanation.
- \`WONT_FIX\` is NOT allowed for \`[OUT_OF_SCOPE]\` items — use \`REVERTED\` instead.
- If coordinator guidance includes \`MUST_IMPLEMENT:\`, those items are mandatory and should not be marked \`WONT_FIX\`.

` : ''}---

## Start Now

Begin by reading ${sourcePathForStart} and implementing the task.
`;
}

/**
 * Context for batch coder prompts
 */
export interface BatchCoderPromptContext {
  tasks: Task[];
  projectPath: string;
  sectionName: string;
  userFeedbackSummary?: string | null; // Human feedback summary for this section
  userFeedbackItems?: string[]; // Individual user feedback notes
}

/**
 * Generate the coder prompt for a batch of tasks
 */
export function generateBatchCoderPrompt(context: BatchCoderPromptContext): string {
  const { tasks, projectPath, sectionName, userFeedbackSummary, userFeedbackItems } = context;
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });

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

**IMPORTANT:** Implement each task IN ORDER. Do NOT commit your work.

## Section: ${sectionName}
**Total Tasks:** ${tasks.length}
**Project:** ${projectPath}
**CRITICAL WORKSPACE RULE:** You are operating inside an isolated workspace clone. DO NOT change directories out of your current working directory. All changes MUST be made in this current directory. If files referenced in the task do not exist in your current working directory, they either need to be CREATED (per the task specification) or the task spec refers to files on a different branch that have not been merged yet — in either case you must work only within your current directory. **Never navigate to \`../\` or any sibling directories. Never use absolute paths to access workspaces, clones, or any path outside your CWD.**
${buildSkillsSection(projectPath)}${buildProjectInstructionsSection(projectPath)}

---

## TASKS TO IMPLEMENT

${taskSpecs}
${userFeedbackSection}

---

## YOUR WORKFLOW

For EACH task:
1. **Read Linked Guidance Files:** Follow every file listed under "Required Instruction Files" and "Assigned Skills" before coding.
2. Read the specification carefully.
3. Implement the feature/fix.
4. Verify tools using \`which <command>\` before relying on them. If a tool is missing, FIRST look for any alternative tools or commands available on the system.
5. Run tests if applicable.
6. Self-Review your work against the specification.
7. Output "STATUS: REVIEW: <task-id>" when done.
8. Move to next task.

**CRITICAL:** DO NOT COMMIT OR PUSH YOUR WORK. The host system manages all version control automatically.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **BUILD MUST PASS after each task**
3. **DO NOT commit after tasks**
4. **steroids CLI (read-only only):** You may run \`steroids tasks list\` or \`steroids tasks show <id>\` to understand sibling task scope. **DO NOT** run any other \`steroids\` commands.

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
  const {
    task,
    projectPath,
    gitStatus,
    gitDiff,
    rejectionHistory,
    coordinatorGuidance,
    sectionTasks,
    userFeedbackSummary,
    userFeedbackItems,
  } = context;

  const sourceRef = getSourceFileReference(projectPath, task.source_file);
  const fileAnchorSection = buildFileAnchorSection(task);
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });

  // Build rejection section with full history and coordinator guidance (same as normal prompt)
  const rejectionSection = formatRejectionHistoryForCoder(task.id, rejectionHistory, undefined, coordinatorGuidance);

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title} (RESUMING)
# Status: resuming | Rejections: ${task.rejection_count}/15

You are a CODER resuming work on a partially completed task.

---

## Specification (Read First)

${sourceRef}

---

## Task Context

**CRITICAL WORKSPACE RULE:** You are operating inside an isolated workspace clone. DO NOT change directories out of your current working directory. All changes MUST be made in this current directory. If files referenced in the task do not exist in your current working directory, they either need to be CREATED (per the task specification) or the task spec refers to files on a different branch that have not been merged yet — in either case you must work only within your current directory. **Never navigate to \`../\` or any sibling directories. Never use absolute paths to access workspaces, clones, or any path outside your CWD.**
${fileAnchorSection}${formatSectionTasks(task.id, sectionTasks, 'coder')}${buildSkillsSection(projectPath)}${buildProjectInstructionsSection(projectPath)}
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
${userFeedbackSection}

---

## Your Instructions

1. **Read Linked Guidance Files:** Follow every file listed under "Required Instruction Files" and "Assigned Skills" before coding.
2. Review what the previous coder did
3. If the work looks good, complete it
4. If the work looks wrong, you may start fresh
5. DO NOT COMMIT OR PUSH YOUR WORK
6. If this task has rejections, include a \`## REJECTION_RESPONSE\` block with one line per reviewer item (\`IMPLEMENTED\`, \`WONT_FIX\`, or \`REVERTED\` with strong justification)
${rejectionSection}
---

${task.rejection_count > 0 ? `## REQUIRED OUTPUT CONTRACT FOR RESUBMISSION

\`\`\`
## REJECTION_RESPONSE
ITEM-1 | IMPLEMENTED | src/file.ts:42 | fixed null-check and added guard
ITEM-2 | WONT_FIX | exceptional reason + proof solution still works
ITEM-3 | REVERTED | src/api/users.ts removed (was out-of-scope)
\`\`\`

Rules:
- Every reviewer checkbox item must have one matching \`ITEM-<n>\` response.
- \`WONT_FIX\` is a high bar and requires an exceptional, concrete explanation.
- \`WONT_FIX\` is NOT allowed for \`[OUT_OF_SCOPE]\` items — use \`REVERTED\` instead.
- If coordinator guidance includes \`MUST_IMPLEMENT:\`, those items are mandatory and should not be marked \`WONT_FIX\`.

---
` : ''}${coordinatorGuidance?.includes('MUST_IMPLEMENT:') ? `## MANDATORY OVERRIDE

You MUST implement the items listed under \`MUST_IMPLEMENT:\` before resubmitting.

---
` : ''}

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
2. **DO NOT COMMIT YOUR WORK**
3. **Output "STATUS: REVIEW"** when done - the orchestrator will submit for review
4. **steroids CLI (read-only only):** You may run \`steroids tasks list\` or \`steroids tasks show <id>\` to understand sibling task scope. **DO NOT** run any other \`steroids\` commands — the orchestrator manages all state changes.

---

## Complete the Task Now

Review the existing work and finish the implementation. Make sure to Self-Review your work against the specification before submitting.
`;
}
