/**
 * Coder prompt templates
 * Following the exact templates from PROMPTS.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, RejectionEntry } from '../database/queries.js';

export interface CoderPromptContext {
  task: Task;
  projectPath: string;
  previousStatus: string;
  rejectionNotes?: string;
  rejectionHistory?: RejectionEntry[];  // Full rejection history
  gitStatus?: string;
  gitDiff?: string;
}

/**
 * Read AGENTS.md content if present
 */
function getAgentsMd(projectPath: string): string {
  const agentsPath = join(projectPath, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, 'utf-8');
    // Truncate if too long (max 5000 chars per spec)
    if (content.length > 5000) {
      return content.substring(0, 5000) + '\n\n[Content truncated]';
    }
    return content;
  }
  return 'No AGENTS.md found. Follow standard coding practices.';
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
 * Format rejection history for coder
 */
function formatRejectionHistoryForCoder(
  taskId: string,
  rejectionHistory?: RejectionEntry[],
  latestNotes?: string
): string {
  if (!rejectionHistory || rejectionHistory.length === 0) {
    return '';
  }

  const historyLines = rejectionHistory.map(r => {
    const commitRef = r.commit_sha ? ` (commit: ${r.commit_sha.substring(0, 7)})` : '';
    const notes = r.notes || '(no detailed notes)';
    return `### Rejection #${r.rejection_number}${commitRef}
${notes}
`;
  });

  // Always provide guidance, with extra emphasis after multiple rejections
  const guidanceNote = `
**Before implementing, you MUST:**
1. Read ALL the rejection notes above carefully
2. Look for patterns - is the same issue being raised repeatedly?
3. Use \`git show <commit-hash>\` to see what you tried before
4. The reviewer should have provided file:line references - use them
5. Look for similar working patterns in the codebase
${rejectionHistory.length >= 5 ? `
**⚠️ HIGH REJECTION COUNT (${rejectionHistory.length})** - Consider if you're misunderstanding the specification
` : ''}`;

  return `
---

## Rejection History

**CRITICAL:** Review this history before implementing. Your past attempts were rejected for specific reasons.
Use the commit hashes to examine what you tried: \`git show <hash>\`
${guidanceNote}
${historyLines.join('\n')}
---

You MUST address the feedback above. This is rejection #${rejectionHistory.length} of 15.
After 15 rejections, this task will require human intervention.

If you believe the reviewer is fundamentally wrong about the specification, you may dispute:
\`\`\`bash
steroids dispute create ${taskId} --reason "explanation" --type coder
\`\`\`

But only dispute if there's a genuine specification disagreement. Frivolous disputes will be deleted.
`;
}

/**
 * Generate the coder prompt for a new task
 */
export function generateCoderPrompt(context: CoderPromptContext): string {
  const { task, projectPath, previousStatus, rejectionNotes, rejectionHistory } = context;

  const agentsMd = getAgentsMd(projectPath);
  const sourceContent = getSourceFileContent(projectPath, task.source_file);

  // Build rejection section with full history
  const rejectionSection = formatRejectionHistoryForCoder(task.id, rejectionHistory, rejectionNotes);

  return `# STEROIDS CODER TASK

You are a CODER in an automated task execution system. Your job is to implement the task below according to the specification.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Status:** ${previousStatus} → in_progress
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}

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

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
   - Do NOT read, write, or modify any files in .steroids/
   - This includes .db, .yaml, and .yml files

2. **BUILD AND TESTS MUST PASS before submitting**
   - Run the project's build command
   - Run the project's test command
   - Fix any errors until BOTH pass
   - **Do NOT submit for review if build OR tests fail**

3. **Use CLI for status updates**
   When you are DONE and BUILD PASSES, run:
   \`\`\`bash
   steroids tasks update ${task.id} --status review
   \`\`\`

4. **Commit your work with a meaningful message**
   Before marking as review, commit your changes with a descriptive message:
   \`\`\`bash
   git add <files>
   git commit -m "<type>: <descriptive message based on what you implemented>"
   \`\`\`
   Write a commit message that describes what you actually built, not just the task title.
   Use conventional commit types: feat, fix, refactor, test, docs, chore.

5. **Never modify TODO.md directly**
   The CLI manages task status.

---

## When You Are Done

**CRITICAL: You MUST verify the project builds AND tests pass before submitting for review.**

### If work already existed (you found it in step 1):
1. Run \`git log --oneline -20\` to find the commit hash
2. Run \`git show <hash> --stat\` to verify files match spec
3. Run build and tests to confirm it works
4. Submit with the **exact commit hash** so the reviewer can verify:
   \`\`\`bash
   steroids tasks update ${task.id} --status review --notes "Implementation at commit abc1234. Files: src/foo.ts, src/bar.ts. Matches spec requirements X, Y, Z."
   \`\`\`

**The reviewer will run \`git show <hash>\` to verify. Be precise about which commit.**

### If you implemented new work:
1. **Run the build command** for this project type (npm run build, cargo build, go build, make, etc.)
2. **Run the test command** for this project type (npm test, cargo test, go test, pytest, etc.)
3. **Fix any errors** until BOTH build and tests pass
4. **Commit your work** with a meaningful commit message:
   \`\`\`bash
   git add <your-changed-files>
   git commit -m "<type>: <descriptive message>"
   \`\`\`
5. **Submit for review:**
   \`\`\`bash
   steroids tasks update ${task.id} --status review
   \`\`\`

**Both build AND tests MUST pass.** If you submit code that doesn't build or has failing tests, it will be rejected, wasting a review cycle.

If you do NOT run \`steroids tasks update\`, your work will not be submitted and you will be restarted on the next cycle.

---

## Start Now

Begin by reading ${task.source_file ?? 'the specification above'} and implementing the task.
`;
}

/**
 * Generate the coder prompt for resuming partial work
 */
export function generateResumingCoderPrompt(context: CoderPromptContext): string {
  const { task, projectPath, gitStatus, gitDiff } = context;

  const sourceContent = getSourceFileContent(projectPath, task.source_file);

  return `# STEROIDS CODER TASK (RESUMING)

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
