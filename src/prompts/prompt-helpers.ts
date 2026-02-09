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
 * Normalize text for fuzzy comparison
 * Strips punctuation, lowercases, collapses whitespace
 */
function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Detect repeated patterns in rejection history
 * Uses normalized fuzzy matching to catch similar (not just identical) issues
 */
export function detectRejectionPatterns(rejectionHistory: RejectionEntry[]): string {
  if (rejectionHistory.length < 3) return '';

  // Extract titles and normalize for comparison
  const entries = rejectionHistory.map(r => ({
    title: extractRejectionTitle(r.notes),
    normalized: normalizeForComparison(extractRejectionTitle(r.notes)),
  }));

  // Group by normalized title (catches minor wording variations)
  const groups = new Map<string, { title: string; count: number }>();
  for (const entry of entries) {
    const existing = groups.get(entry.normalized);
    if (existing) {
      existing.count++;
    } else {
      groups.set(entry.normalized, { title: entry.title, count: 1 });
    }
  }

  // Also check for keyword-level overlap between non-identical entries
  // If 3+ rejections share significant keywords, flag it
  const allNotes = rejectionHistory.map(r => r.notes || '');
  const keywordCounts = new Map<string, number>();
  for (const note of allNotes) {
    // Extract significant words (4+ chars, not common words)
    const words = new Set(
      normalizeForComparison(note)
        .split(' ')
        .filter(w => w.length >= 4)
    );
    for (const word of words) {
      keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
    }
  }
  const hotKeywords = [...keywordCounts.entries()]
    .filter(([, count]) => count >= 3)
    .filter(([word]) => !['task', 'file', 'code', 'this', 'that', 'should', 'must', 'need'].includes(word))
    .map(([word]) => word);

  const repeated = [...groups.values()].filter(g => g.count >= 3);
  if (repeated.length === 0 && hotKeywords.length === 0) return '';

  const lines: string[] = [];
  for (const { title, count } of repeated) {
    lines.push(`- "${title}" - raised ${count} times`);
  }
  if (hotKeywords.length > 0 && repeated.length === 0) {
    lines.push(`- Recurring themes: ${hotKeywords.slice(0, 5).join(', ')}`);
  }

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
 * Language-agnostic: matches any path-like pattern with directory separators and file extensions
 */
export function extractFileHints(title: string, specContent: string): string[] {
  const combined = `${title}\n${specContent}`;
  // Match any path with at least one directory separator and a file extension (1-10 chars)
  // Examples: src/foo.ts, lib/utils/helpers.py, app/models/user.rb, pkg/api/handler.go
  const filePattern = /(?:^|\s|`|"|'|\()([\w][\w.-]*(?:\/[\w.-]+)+\.\w{1,10})/gm;
  const matches = new Set<string>();
  let match;
  while ((match = filePattern.exec(combined)) !== null) {
    const path = match[1];
    // Filter out URLs, version numbers, and common false positives
    if (path.includes('://') || /^\d+\.\d+\.\d+/.test(path) || path.includes('node_modules/')) {
      continue;
    }
    matches.add(path);
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

/**
 * Build a file anchor section for the prompt
 * Directs the coder/reviewer to a specific file and line
 */
export function buildFileAnchorSection(task: Task): string {
  if (!task.file_path) return '';

  const lineRef = task.file_line ? `:${task.file_line}` : '';
  const commitShort = task.file_commit_sha?.substring(0, 7) ?? 'unknown';

  return `
## FILE ANCHOR

**This task is anchored to a specific location in the codebase:**

- **File:** \`${task.file_path}${lineRef}\`
${task.file_line ? `- **Line:** ${task.file_line}\n` : ''}- **Commit:** \`${commitShort}\`

Start your investigation at this file${task.file_line ? ' and line' : ''}. Use \`git show ${commitShort}:${task.file_path}\` to see the version when this task was created.

---
`;
}

export interface SectionTask {
  id: string;
  title: string;
  status: string;
}

const MAX_SECTION_TASKS = 15;

/**
 * Format other tasks in the same section for context
 */
export function formatSectionTasks(currentTaskId: string, sectionTasks?: SectionTask[]): string {
  if (!sectionTasks || sectionTasks.length <= 1) {
    return '';
  }

  const statusEmoji: Record<string, string> = {
    'pending': '\u23F3',
    'in_progress': '\uD83D\uDD04',
    'review': '\uD83D\uDC40',
    'completed': '\u2705',
  };

  const otherTasks = sectionTasks.filter(t => t.id !== currentTaskId);
  const tasksToShow = otherTasks.slice(0, MAX_SECTION_TASKS);
  const remainingCount = otherTasks.length - tasksToShow.length;

  const lines = tasksToShow.map(t => {
    const emoji = statusEmoji[t.status] || '\u2753';
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
