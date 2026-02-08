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
 * Shows the LATEST rejection prominently, with summary of earlier ones
 */
function formatRejectionHistoryForCoder(
  taskId: string,
  rejectionHistory?: RejectionEntry[],
  latestNotes?: string
): string {
  if (!rejectionHistory || rejectionHistory.length === 0) {
    return '';
  }

  const latest = rejectionHistory[rejectionHistory.length - 1];
  const latestCommitRef = latest.commit_sha ? ` (commit: ${latest.commit_sha.substring(0, 7)})` : '';

  // For high rejection counts, only show last 2 rejections in full to avoid overwhelming
  const recentRejections = rejectionHistory.length > 3
    ? rejectionHistory.slice(-2)
    : rejectionHistory;

  const olderCount = rejectionHistory.length - recentRejections.length;

  const recentLines = recentRejections.map(r => {
    const commitRef = r.commit_sha ? ` (commit: ${r.commit_sha.substring(0, 7)})` : '';
    const notes = r.notes || '(no detailed notes)';
    return `### Rejection #${r.rejection_number}${commitRef}
${notes}
`;
  });

  const olderSummary = olderCount > 0
    ? `\n_${olderCount} earlier rejection(s) omitted - they raised the same issues._\n`
    : '';

  return `
---

## ⚠️ REJECTION #${rejectionHistory.length} OF 15 - FIX THESE SPECIFIC ISSUES

**YOU HAVE BEEN REJECTED ${rejectionHistory.length} TIMES FOR THE SAME ISSUES.**

The reviewer has given you EXACT file:line references. You MUST:
1. **Open each file mentioned** and go to the exact line number
2. **Make the specific change requested** - do not improvise
3. **Run the tests** to verify coverage meets 80%
4. **Do NOT submit** until every issue below is addressed

---

## LATEST REJECTION${latestCommitRef}

**READ THIS CAREFULLY - EVERY ISSUE MUST BE FIXED:**

${latest.notes || '(no notes)'}

---
${olderSummary}
${recentLines.length > 1 ? `## Previous Rejection (for context)\n\n${recentLines[0]}` : ''}
---

## CHECKLIST BEFORE SUBMITTING

Before running \`steroids tasks update ${taskId} --status review\`, verify:

- [ ] Each file:line mentioned above has been edited
- [ ] The specific type/code changes requested have been made
- [ ] The project builds successfully (if applicable)
- [ ] Tests pass (if the project has tests)
- [ ] You tested the specific scenarios mentioned in the rejection

**DO NOT claim "implementation complete" or "all tests pass" without addressing EVERY point above.**

If you believe the reviewer is wrong, dispute with:
\`\`\`bash
steroids dispute create ${taskId} --reason "explanation" --type coder
\`\`\`
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

## Attempt Before Skip (IMPORTANT)

**You MUST attempt any task that can be run locally, even if it might fail.**

Many tasks look like they need external setup, but they're actually runnable commands. Your job is to TRY them first.

### ALWAYS ATTEMPT These (Do NOT Skip)

| Task Type | Why It's Runnable | What To Do |
|-----------|-------------------|------------|
| "Test Docker build" | \`docker build .\` is a local command | Run it, fix Dockerfile errors if any |
| "Run tests" | \`npm test\` / \`pytest\` runs locally | Run it, fix failing tests |
| "Build the project" | \`npm run build\` / \`make\` runs locally | Run it, fix build errors |
| "Deploy locally" | \`make deploy-local\` runs locally | Run it, fix any issues |
| "Test CI workflow" | \`act\` or similar can run locally | Try it with available tools |
| "Verify Makefile targets" | \`make <target>\` runs locally | Run it, see what happens |
| "Test database migrations" | SQLite/local DB works | Run against local DB |
| "Lint/format code" | \`npm run lint\` runs locally | Run it, fix issues |

**The rule is simple:** If you can type a command and hit Enter, ATTEMPT IT.

Even if it fails, that failure is valuable information. The reviewer wants to see that you tried.

### Example: Docker Build Task

**BAD (skipping too early):**
\`\`\`bash
steroids tasks skip ${task.id} --partial --notes "Docker build requires infrastructure"
# ❌ You didn't even try!
\`\`\`

**GOOD (attempting first):**
\`\`\`bash
docker build -t myapp:test .
# If it fails: read the error, fix the Dockerfile, try again
# If it succeeds: run the container, verify it works
# THEN submit for review with actual results
\`\`\`

---

## When To Actually Skip (External Setup Only)

**Only skip when the task TRULY requires external action you cannot perform:**

### Legitimate Skip Scenarios

| Truly External | Why You Can't Do It |
|----------------|---------------------|
| "Create GCP Cloud SQL instance" | Requires GCP Console/gcloud with credentials |
| "Set up AWS account" | Requires human account creation |
| "Configure DNS records" | Requires domain registrar access |
| "Create API keys for service X" | Requires external account login |
| "Set up OAuth app in Google Console" | Requires manual console configuration |
| "Purchase SSL certificate" | Requires payment/verification |
| "Create Kubernetes cluster" | Requires cloud provider console |

**The test:** If you literally cannot type a command to do it, THEN consider skipping.

**BEFORE skipping, check the spec section for:**
- \`> ⚠️ **SKIP**\` or \`> SKIP\` markers
- "manual setup", "handled manually", "external setup"
- Cloud infrastructure tasks with NO automation scripts provided

**If the task requires EXTERNAL action you cannot perform:**

1. **Fully external** (e.g., "Create Cloud SQL instance" with no Terraform/scripts):
   \`\`\`bash
   steroids tasks skip ${task.id} --notes "SKIP REASON: Requires GCP Console access to create Cloud SQL instance - no Terraform/scripts provided. WHAT'S NEEDED: Human must create instance via console. BLOCKING: Tasks #31-#34 depend on this."
   \`\`\`

2. **Partial** (you coded some parts, rest needs human action):
   - Implement what you CAN (deployment YAML, config files, etc.)
   - Commit your work with a descriptive message
   - Then:
   \`\`\`bash
   steroids tasks skip ${task.id} --partial --notes "DONE: Created deployment.yaml, service.yaml, and ran 'kubectl apply --dry-run' successfully. NEEDS HUMAN: GKE cluster must be created via GCP Console. BLOCKING: Cannot deploy until cluster exists."
   \`\`\`

**Your skip notes MUST include:**
- WHY it's being skipped (requires console access, no automation available, etc.)
- WHAT specific action a human needs to take
- WHAT tasks are blocked until this is done (if known)
- WHAT you attempted before deciding to skip

**DO NOT:**
- Skip tasks because they're "hard" or "might fail"
- Skip tasks with runnable commands you haven't tried
- Flip checkboxes from [ ] to [x] without concrete evidence
- Mark tasks complete that require human action you cannot verify
- Get stuck in a loop trying to "complete" infrastructure tasks

**The reviewer will verify:**
1. You actually attempted runnable commands before skipping
2. The spec actually says SKIP/manual OR requires true external access
3. The skip reason is legitimate
4. If partial, the coded work is correct

If approved, the task moves to skipped/partial status and the runner continues to the next task.

---

## CRITICAL RULES

1. **NEVER touch .steroids/ directory**
   - Do NOT read, write, or modify any files in .steroids/
   - This includes .db, .yaml, and .yml files

2. **BUILD MUST PASS before submitting**
   - Run the project's build command (if applicable)
   - Run tests (if the project has them)
   - Fix any errors before submitting
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
1. **Run the build command** for this project type (if applicable)
2. **Run tests** if the project has them
3. **Fix any errors** before proceeding
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
${task.rejection_count > 0 ? `
## ⚠️ THIS TASK HAS BEEN REJECTED ${task.rejection_count} TIME(S)

**You MUST address the reviewer's feedback before submitting again.**

The reviewer provides SPECIFIC repro steps. Before claiming done:

1. **Extract every test case** from the rejection notes above
2. **Run each one** and verify the EXACT expected behavior
3. **Fix issues at the source** - not just surface symptoms
4. **Test again** after each fix

Example: If the reviewer says:
> "\`steroids init --dry-run --json\` outputs nothing"

You must:
1. Run \`steroids init --dry-run --json\` yourself
2. See that it outputs nothing
3. Find WHY (trace the code path)
4. Fix the root cause
5. Run the command again to verify it now works
6. THEN move to the next issue

Do NOT submit for review until you have tested EVERY scenario mentioned.

` : ''}---

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
