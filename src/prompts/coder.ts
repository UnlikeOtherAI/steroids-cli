/**
 * Coder prompt templates
 * Following the exact templates from PROMPTS.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';

export interface CoderPromptContext {
  task: Task;
  projectPath: string;
  previousStatus: string;
  rejectionNotes?: string;
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
 * Generate the coder prompt for a new task
 */
export function generateCoderPrompt(context: CoderPromptContext): string {
  const { task, projectPath, previousStatus, rejectionNotes } = context;

  const agentsMd = getAgentsMd(projectPath);
  const sourceContent = getSourceFileContent(projectPath, task.source_file);

  // Build rejection section if applicable
  let rejectionSection = '';
  if (task.rejection_count > 0 && rejectionNotes) {
    rejectionSection = `
---

## Previous Rejection Feedback

The reviewer rejected your previous attempt with this feedback:

> ${rejectionNotes}

You MUST address this feedback. This is rejection #${task.rejection_count} of 15.
After 15 rejections, this task will require human intervention.

If you believe the reviewer is wrong, you may dispute:
\`\`\`bash
steroids dispute create ${task.id} --reason "explanation" --type coder
\`\`\`

But only dispute if there's a genuine specification disagreement. Frivolous disputes will be deleted.
`;
  }

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

## Your Instructions

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

1. **Detect and run the build command** for this project type (npm run build, cargo build, go build, make, etc.)
2. **Detect and run the test command** for this project type (npm test, cargo test, go test, pytest, etc.)
3. **Fix any errors** until BOTH build and tests pass
4. **Commit your work** with a meaningful commit message that describes what you implemented:
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
