/**
 * Shared prompt helper functions
 * Used by coder, reviewer, and coordinator prompts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, RejectionEntry } from '../database/queries.js';

/**
 * Read AGENTS.md content if present
 */
export function getAgentsMd(projectPath: string): string {
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
export function getSourceFileContent(
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
 * Extract first line of rejection notes as a title/summary
 */
export function extractRejectionTitle(notes: string | null | undefined): string {
  if (!notes) return '(no notes)';
  const firstLine = notes.split('\n').find(l => l.trim().length > 0) || '(no notes)';
  // Strip markdown formatting for summary
  return firstLine.replace(/^[-*#\s[\]]+/, '').trim().substring(0, 100);
}

/**
 * Detect repeated patterns in rejection history
 */
export function detectRejectionPatterns(rejectionHistory: RejectionEntry[]): string {
  if (rejectionHistory.length < 3) return '';

  // Extract titles and count duplicates
  const titles = rejectionHistory.map(r => extractRejectionTitle(r.notes));
  const counts = new Map<string, number>();
  for (const t of titles) {
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  const repeated = [...counts.entries()].filter(([, count]) => count >= 3);
  if (repeated.length === 0) return '';

  const lines = repeated.map(([title, count]) =>
    `- "${title}" - raised ${count} times`
  );

  return `
**PATTERN DETECTED - The following issues keep repeating:**

${lines.join('\n')}

If you cannot resolve these, DISPUTE the task instead of resubmitting the same work:
\`\`\`bash
steroids dispute create <task-id> --reason "Cannot resolve: <explain why>" --type coder
\`\`\`
`;
}

/**
 * Extract file paths mentioned in text (task title, spec content)
 * Looks for common source file patterns
 */
export function extractFileHints(title: string, specContent: string): string[] {
  const combined = `${title}\n${specContent}`;
  // Match file paths like src/foo/bar.ts, lib/utils.js, etc.
  const filePattern = /(?:^|\s|`|"|'|\()((?:src|lib|test|tests|migrations|scripts|config|commands|hooks|runners|orchestrator|prompts|providers|disputes|database|git|cli|utils)\/[\w./-]+\.\w+)/gm;
  const matches = new Set<string>();
  let match;
  while ((match = filePattern.exec(combined)) !== null) {
    matches.add(match[1]);
  }
  return [...matches];
}

/**
 * Build a file scope section for the prompt
 */
export function buildFileScopeSection(task: Task, specContent: string): string {
  const fileHints = extractFileHints(task.title, specContent);
  if (fileHints.length === 0) return '';

  return `
---

## FILE SCOPE

Based on the task specification, these files are likely relevant:
${fileHints.map(f => `- \`${f}\``).join('\n')}

**Focus your changes on these files.** If you find yourself modifying unrelated files, STOP and re-read the specification.

`;
}

/**
 * Format rejection history for coder prompt
 * Shows ALL rejection titles for pattern visibility, full details of last 3
 */
export function formatRejectionHistoryForCoder(
  taskId: string,
  rejectionHistory?: RejectionEntry[],
  latestNotes?: string,
  coordinatorGuidance?: string
): string {
  if (!rejectionHistory || rejectionHistory.length === 0) {
    return '';
  }

  const latest = rejectionHistory[rejectionHistory.length - 1];
  const latestCommitRef = latest.commit_sha ? ` (commit: ${latest.commit_sha.substring(0, 7)})` : '';

  // Show ALL rejection titles for pattern visibility
  const rejectionTitlesList = rejectionHistory.map(r =>
    `${r.rejection_number}. ${extractRejectionTitle(r.notes)}`
  ).join('\n');

  // Show full details of last 3 rejections
  const detailedRejections = rejectionHistory.length > 3
    ? rejectionHistory.slice(-3)
    : rejectionHistory;

  const detailedLines = detailedRejections.map(r => {
    const commitRef = r.commit_sha ? ` (commit: ${r.commit_sha.substring(0, 7)})` : '';
    return `### Rejection #${r.rejection_number}${commitRef}
${r.notes || '(no detailed notes)'}
`;
  });

  // Detect patterns
  const patternWarning = detectRejectionPatterns(rejectionHistory);

  // Coordinator guidance section (injected after 2nd rejection)
  const coordinatorSection = coordinatorGuidance ? `
---

## COORDINATOR GUIDANCE

A coordinator has reviewed the rejection history and provides this guidance:

${coordinatorGuidance}

**Follow the coordinator's guidance above. It takes priority over conflicting reviewer feedback.**

` : '';

  return `
---

## REJECTION HISTORY (${rejectionHistory.length} total, max 15)

${rejectionTitlesList}

${patternWarning}
---

## LATEST REJECTION${latestCommitRef}

**ADDRESS EACH CHECKBOX BELOW:**

${latest.notes || '(no notes)'}

---
${detailedLines.length > 1 ? `## Previous Rejections (for context)\n\n${detailedLines.slice(0, -1).join('\n---\n')}` : ''}
${coordinatorSection}---

## BEFORE SUBMITTING

1. For each \`- [ ]\` item in the rejection:
   - Open the file mentioned
   - Make the exact change requested
   - Verify the fix works

2. Run the build and tests:
   - The project must build successfully
   - Tests must pass (if the project has tests)

3. Only THEN submit for review:
   \`\`\`bash
   steroids tasks update ${taskId} --status review
   \`\`\`

**DO NOT submit until you have addressed EVERY checkbox in the rejection notes.**

If you believe the reviewer is wrong or the requirement is impossible, dispute:
\`\`\`bash
steroids dispute create ${taskId} --reason "explanation" --type coder
\`\`\`
`;
}
