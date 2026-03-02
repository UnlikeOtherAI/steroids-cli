/**
 * Reviewer prompt templates
 * Following the exact templates from PROMPTS.md
 */

import type { Task, RejectionEntry } from '../database/queries.js';
import type { SteroidsConfig } from '../config/loader.js';
import {
  getSourceFileReference,
  buildFileAnchorSection,
  formatSectionTasks,
  formatUserFeedbackContextSection,
} from './prompt-helpers.js';
import type { SectionTask } from './prompt-helpers.js';
import { buildProjectInstructionsSection } from './instruction-files.js';
import {
  buildReviewerDecisionSection,
  buildReviewerSecuritySection,
  formatCoordinatorGuidance,
  formatRejectionHistory,
  formatReviewerCustomInstructions,
  getTestCoverageInstructions,
} from './reviewer-template-sections.js';

export interface ReviewerPromptContext {
  task: Task;
  projectPath: string;
  reviewerModel: string;
  submissionCommitHash: string;
  submissionCommitHashes?: string[]; // Ordered oldest -> newest
  unresolvedSubmissionCommits?: string[]; // Submission hashes not currently reachable
  sectionTasks?: SectionTask[];  // Other tasks in the same section
  rejectionHistory?: RejectionEntry[];  // Past rejections with commit hashes
  submissionNotes?: string | null;  // Notes from coder when submitting for review
  config: SteroidsConfig;  // Config for quality settings
  coordinatorGuidance?: string;  // Guidance from coordinator after repeated rejections
  coordinatorDecision?: string;  // Coordinator's decision type
  reviewerCustomInstructions?: string; // Per-reviewer custom instructions
  userFeedbackSummary?: string | null; // Human feedback summary for this task/section
  userFeedbackItems?: string[]; // Individual user feedback notes
}

/**
 * Generate a minimal delta prompt for a resumed reviewer session
 */
export function generateResumingReviewerDeltaPrompt(context: ReviewerPromptContext): string {
  const {
    task,
    submissionCommitHash,
    submissionCommitHashes,
    unresolvedSubmissionCommits,
    submissionNotes,
    rejectionHistory,
    projectPath,
    reviewerCustomInstructions,
    userFeedbackSummary,
    userFeedbackItems,
  } = context;
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });
  const submissionChain = submissionCommitHashes && submissionCommitHashes.length > 0
    ? submissionCommitHashes
    : [submissionCommitHash];
  const latestSubmissionCommit = submissionCommitHash;
  const oldestSubmissionCommit = submissionChain[0];
  const cumulativeRange = oldestSubmissionCommit === latestSubmissionCommit
    ? latestSubmissionCommit
    : `${oldestSubmissionCommit}^..${latestSubmissionCommit}`;
  const sourceRef = getSourceFileReference(projectPath, task.source_file);

  // Find the last rejection notes the reviewer gave
  const lastRejection = rejectionHistory && rejectionHistory.length > 0
    ? rejectionHistory[rejectionHistory.length - 1]
    : null;

  let prompt = `The coder has submitted a new attempt for task ${task.id}: "${task.title}".
All previous context and your past review notes are still in your session history.

If the submission notes begin with \`[NO_OP_SUBMISSION]\`, the coder made no new commits because it determined the work already existed. Verify whether the pre-existing code satisfies the task specification. Do NOT reject solely because there is no new diff.

---

## What to Review

## Specification

${sourceRef}
${formatReviewerCustomInstructions(reviewerCustomInstructions)}

## Submission Commit Chain (Oldest -> Newest)

${submissionChain.map((sha, idx) => `${idx + 1}. \`${sha}\``).join('\n')}

Latest submission commit:
\`${latestSubmissionCommit}\`

Cumulative range across this task:
\`git diff --stat ${cumulativeRange}\`
\`git diff ${cumulativeRange}\`

Inspect each attempt:
\`git show <sha>\`

---

## Files touched in latest commit

Use: \`git show ${latestSubmissionCommit} --name-only\`
${userFeedbackSection}
`;

  if (unresolvedSubmissionCommits && unresolvedSubmissionCommits.length > 0) {
    prompt += `\n---

## Unresolved Historical Submission Hashes

The following historical submission hashes are currently unreachable in this workspace:
${unresolvedSubmissionCommits.map(sha => `- \`${sha}\``).join('\n')}

Continue review using the reachable commit chain above and note any uncertainty caused by missing history.
`;
  }

  if (submissionNotes) {
    prompt += `\n---

## Coder's New Notes

> ${submissionNotes}
`;
  }

  if (lastRejection) {
    prompt += `\n---

## Your Previous Rejection Notes (Rejection #${lastRejection.rejection_number})

"${lastRejection.notes}"
`;
  }

  prompt += `\n---

## Your Decision

Review this new submission. Has the coder addressed your previous feedback? Are there any new issues?
All previous context is still in your session.

You MUST review cumulatively across the entire reachable submission chain for this task, not only the latest commit.
If a previously rejected item is still unresolved in the cumulative diff, mark it as [UNRESOLVED].

**REMINDER:**
1. Your first non-empty line MUST be an explicit decision token: \`DECISION: APPROVE|REJECT|DISPUTE|SKIP\`
2. If REJECTing, use checkboxes for EACH actionable item.
3. Be specific and actionable.
4. If the diff includes ANY \`[OUT_OF_SCOPE]\` work: REJECT. This is mandatory regardless of implementation quality.
`;

  return prompt;
}


/**
 * Generate the reviewer prompt
 */
export function generateReviewerPrompt(context: ReviewerPromptContext): string {
  const {
    task,
    projectPath,
    sectionTasks,
    rejectionHistory,
    submissionNotes,
    config,
    coordinatorGuidance,
    coordinatorDecision,
    submissionCommitHash,
    submissionCommitHashes,
    unresolvedSubmissionCommits,
    reviewerCustomInstructions,
    userFeedbackSummary,
    userFeedbackItems,
  } = context;
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });
  const submissionChain = submissionCommitHashes && submissionCommitHashes.length > 0
    ? submissionCommitHashes
    : [submissionCommitHash];
  const latestSubmissionCommit = submissionCommitHash;
  const oldestSubmissionCommit = submissionChain[0];
  const cumulativeRange = oldestSubmissionCommit === latestSubmissionCommit
    ? latestSubmissionCommit
    : `${oldestSubmissionCommit}^..${latestSubmissionCommit}`;

  // Format coder's submission notes if present
  const submissionNotesSection = submissionNotes
    ? `
---

## Coder's Notes

The coder included these notes when submitting for review:

> ${submissionNotes}

**CRITICAL: If the coder claims work already exists:**
1. **DO NOT reject just because the referenced commit is empty or appears unchanged**
2. If a commit hash is mentioned, run \`git show <hash>\` to verify the work
3. Check if the files/functionality described actually exist in the codebase
4. If the existing work fulfills the specification: **APPROVE**
5. If gaps remain: specify exactly what's missing, don't ask for re-implementation
`
    : '';

  const sourceRef = getSourceFileReference(projectPath, task.source_file);
  const fileAnchorSection = buildFileAnchorSection(task);
  const instructionsSection = buildProjectInstructionsSection(projectPath);
  const reviewerCustomInstructionsSection = formatReviewerCustomInstructions(reviewerCustomInstructions);

  const reviewerCommands = `git show --stat ${latestSubmissionCommit}`;
  const unresolvedHistorySection =
    unresolvedSubmissionCommits && unresolvedSubmissionCommits.length > 0
      ? `

## Historical Hash Gaps

Some older submission hashes are unreachable:
${unresolvedSubmissionCommits.map(sha => `- \`${sha}\``).join('\n')}

Continue with the reachable chain and explicitly mention any uncertainty from missing history.
`
      : '';

  return `# TASK: ${task.id.substring(0, 8)} - ${task.title}
# Status: review | Rejections: ${task.rejection_count}/15

You are a REVIEWER in an automated task execution system. Your job is to verify the coder's implementation matches the specification.

**Follow the project's existing architecture.** If the coder's implementation follows the patterns already established in the codebase (as described in AGENTS.md), do not reject for architectural style differences. Focus on correctness and spec compliance.

## No-op Submissions

If the submission notes begin with \`[NO_OP_SUBMISSION]\`, the coder made no new commits because it determined the work already existed in the codebase. Your job is to verify whether the pre-existing code actually satisfies the task specification fully.

- APPROVE if the existing code satisfies all acceptance criteria
- REJECT with specific missing items if it does not
- Do NOT reject solely because there is no new diff — the absence of a diff is expected

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}
${fileAnchorSection}${formatSectionTasks(task.id, sectionTasks)}${formatRejectionHistory(rejectionHistory)}${submissionNotesSection}${formatCoordinatorGuidance(coordinatorGuidance, coordinatorDecision)}${instructionsSection}
${reviewerCustomInstructionsSection}
## Specification

${sourceRef}

---

## Review Target

Inspect the full task evolution (oldest -> newest reachable submissions):
${submissionChain.map((sha, idx) => `${idx + 1}. \`${sha}\``).join('\n')}

Latest submission anchor:
\`${reviewerCommands}\`
\`git show --name-only ${latestSubmissionCommit}\`

Cumulative task diff:
\`git diff --stat ${cumulativeRange}\`
\`git diff ${cumulativeRange}\`
${unresolvedHistorySection}
${userFeedbackSection}

---

## Review Checklist

Answer these questions:
1. Does the implementation match the specification?
2. Are there bugs or logic errors?
3. Are tests present and adequate?
4. Does code follow AGENTS.md guidelines?
5. Are previously rejected checklist items now resolved across the cumulative task diff?
6. **Scope check:** Did the coder stay within this task's scope? If the diff includes changes that belong to a sibling task (see "Other Tasks in This Section"), flag each one as \`[OUT_OF_SCOPE]\`.
${buildReviewerSecuritySection()}${getTestCoverageInstructions(config)}

---

${buildReviewerDecisionSection(task.rejection_count + 1)}
`;
}

/**
 * Context for batch reviewer prompts
 */
export interface BatchReviewerPromptContext {
  tasks: Task[];
  projectPath: string;
  sectionName: string;
  taskCommits?: Array<{ taskId: string; commitHash: string }>;
  config: SteroidsConfig;
  reviewerCustomInstructions?: string;
  userFeedbackSummary?: string | null; // Human feedback summary for this section
  userFeedbackItems?: string[]; // Individual user feedback notes
}

/**
 * Generate the reviewer prompt for a batch of tasks
 */
export function generateBatchReviewerPrompt(context: BatchReviewerPromptContext): string {
  const {
    tasks,
    projectPath,
    sectionName,
    config,
    taskCommits,
    reviewerCustomInstructions,
    userFeedbackSummary,
    userFeedbackItems,
  } = context;
  const userFeedbackSection = formatUserFeedbackContextSection({ userFeedbackSummary, userFeedbackItems });

  // Build task specs for each task
  const commitMap = new Map(taskCommits?.map(item => [item.taskId, item.commitHash]) ?? []);
  const tasksMissingCommits = tasks.filter(task => !commitMap.get(task.id)).map(task => task.id);
  if (tasksMissingCommits.length > 0) {
    throw new Error(`Missing submission commit hash for batch review tasks: ${tasksMissingCommits.join(', ')}`);
  }
  const taskSpecs = tasks.map((task, index) => {
    const specRef = getSourceFileReference(projectPath, task.source_file);
    const commitRef = commitMap.get(task.id)!;
    return `
### Task ${index + 1}: ${task.title}
**Task ID:** ${task.id}
\`commit: ${commitRef}\`

${specRef}
`;
  }).join('\n---\n');

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
${userFeedbackSection}

---
${formatReviewerCustomInstructions(reviewerCustomInstructions)}

## Review Commands

For each task, inspect the indicated commit directly with:
\`git show <commit>\`
\`git show --name-only <commit>\`

---
${getTestCoverageInstructions(config)}
## Review Checklist (For Each Task)

For EACH task, verify:
1. Does the implementation match the specification?
2. Are there bugs, security issues, or logic errors?
3. Are tests present and adequate (if project requires tests)?
4. Does code follow project guidelines?

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

Inspect each referenced commit, verify each task's specification is met, then clearly state your decision for each task.
The orchestrator will parse your decisions and update task status accordingly.
`;
}
