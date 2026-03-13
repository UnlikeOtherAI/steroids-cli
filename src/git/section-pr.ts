/**
 * Auto-PR creation for section completion.
 *
 * checkSectionCompletionAndPR() is called from all three approval paths:
 *   1. Pool reviewer approval (loop-phases-reviewer.ts — pool path)
 *   2. Non-pool reviewer approval (loop-phases-reviewer.ts — legacy path)
 *   3. Manual CLI approval (tasks.ts approveTaskCmd)
 *
 * GitHub-only: uses `gh` CLI. GitLab/Bitbucket are not supported.
 */

import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import { getSection, listTasks, setSectionPrNumber } from '../database/queries.js';
import { handleIntakePostPR } from '../intake/post-pr.js';

// ─── Terminal state check ────────────────────────────────────────────────────

interface SectionCounts {
  total: number;
  active: number;
  completed: number;
}

interface PrMetadata {
  labels: string[];
  assignees: string[];
  reviewers: string[];
  draft: boolean;
}

function getSectionCounts(db: Database.Database, sectionId: string): SectionCounts {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('pending','in_progress','review','partial') THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM tasks WHERE section_id = ?
  `).get(sectionId) as SectionCounts;
}

function normalizeMetadataList(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseSectionPrLabels(rawLabels: string | null | undefined): string[] {
  if (!rawLabels) {
    return [];
  }

  return rawLabels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function getPrMetadata(section: { pr_labels?: string | null; pr_draft?: number | null }, config: SteroidsConfig): PrMetadata {
  return {
    labels: parseSectionPrLabels(section.pr_labels),
    assignees: normalizeMetadataList(config.git?.prAssignees),
    reviewers: normalizeMetadataList(config.git?.prReviewers),
    draft: section.pr_draft === 1,
  };
}

// ─── gh CLI helpers ──────────────────────────────────────────────────────────

/**
 * Check whether `gh` is available on PATH.
 */
export function isGhAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Look for an existing open PR for the given head branch.
 * Returns the PR number if found, or null.
 *
 * Uses `--jq '.[0].number // empty'` to produce empty output (not the string
 * "null") when no PR exists, avoiding parseInt("null") → NaN.
 */
function findExistingPr(
  projectPath: string,
  headBranch: string,
  baseBranch: string
): number | null {
  try {
    const output = execFileSync('gh', [
      'pr', 'list',
      '--head', headBranch,
      '--base', baseBranch,
      '--json', 'number',
      '--jq', '.[0].number // empty',
    ], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
    if (!output) return null;
    const n = parseInt(output, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Create a GitHub PR for the section branch and return its number.
 * Uses `--json number` for deterministic structured output (not URL regex parsing).
 * Throws on failure.
 */
function createPr(
  projectPath: string,
  sectionName: string,
  headBranch: string,
  baseBranch: string,
  completedTaskTitles: string[],
  metadata: PrMetadata
): number {
  const prBody = [
    `## ${sectionName}`,
    '',
    '### Completed tasks',
    completedTaskTitles.map(t => `- ${t}`).join('\n'),
    '',
    '_Auto-created by steroids on section completion._',
  ].join('\n');

  const args = [
    'pr', 'create',
    '--base', baseBranch,
    '--head', headBranch,
    '--title', `Section: ${sectionName}`,
    '--body', prBody,
    '--json', 'number',
  ];

  if (metadata.draft) {
    args.push('--draft');
  }
  for (const label of metadata.labels) {
    args.push('--label', label);
  }
  for (const assignee of metadata.assignees) {
    args.push('--assignee', assignee);
  }
  for (const reviewer of metadata.reviewers) {
    args.push('--reviewer', reviewer);
  }

  const output = execFileSync('gh', args, {
    cwd: projectPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim();

  // `gh pr create --json number` outputs `{"number": 123}`.
  const parsed = JSON.parse(output) as { number?: number };
  if (!parsed.number || !Number.isInteger(parsed.number)) {
    throw new Error(`gh pr create --json number returned unexpected output: ${output}`);
  }
  return parsed.number;
}

function updatePrMetadata(
  projectPath: string,
  prNumber: number,
  metadata: Pick<PrMetadata, 'labels' | 'assignees' | 'reviewers'>
): void {
  const args = ['pr', 'edit', String(prNumber)];

  for (const label of metadata.labels) {
    args.push('--add-label', label);
  }
  for (const assignee of metadata.assignees) {
    args.push('--add-assignee', assignee);
  }
  for (const reviewer of metadata.reviewers) {
    args.push('--add-reviewer', reviewer);
  }

  if (args.length === 3) {
    return;
  }

  execFileSync('gh', args, {
    cwd: projectPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// ─── Core function ───────────────────────────────────────────────────────────

/**
 * Check whether a section is complete and create a PR if auto_pr is enabled.
 *
 * Idempotent: if pr_number is already set, it returns the recorded PR number and
 * only attempts metadata refreshes.
 * Safe to call after every task approval — cheap unless all conditions are met.
 *
 * @param db         Project database (read/write)
 * @param projectPath  User's project directory (for git remote URL and gh invocation)
 * @param sectionId  ID of the section whose task was just approved
 * @param config     Project config (provides git.branch as the base branch)
 */
export async function checkSectionCompletionAndPR(
  db: Database.Database,
  projectPath: string,
  sectionId: string | null | undefined,
  config: SteroidsConfig
): Promise<number | null> {
  if (!sectionId) return null;

  const section = getSection(db, sectionId);
  if (!section) return null;

  // Skip if auto_pr is not enabled
  if (!section.auto_pr) return null;

  // Skip if no branch is set (can't create PR without a branch)
  if (!section.branch) return null;

  const metadata = getPrMetadata(section, config);

  // Idempotent fast path: keep existing recorded PR number and avoid duplicate creation.
  if (section.pr_number != null) {
    try {
      updatePrMetadata(projectPath, section.pr_number, metadata);
    } catch (error) {
      console.error(
        `[section-pr] Failed to update PR metadata for section "${section.name}" (#${section.pr_number}):`,
        error instanceof Error ? error.message : String(error)
      );
    }
    await handleIntakePostPR({ db, sectionId, prNumber: section.pr_number, config, projectPath });
    return section.pr_number;
  }

  // Check task completion
  const counts = getSectionCounts(db, sectionId);
  if (counts.total === 0 || counts.active > 0 || counts.completed === 0) return null;

  // All tasks are in terminal states and at least one completed — create the PR
  const baseBranch = config.git?.branch ?? 'main';

  // Check for existing PR first (handles race or external creation)
  const existingPrNumber = findExistingPr(projectPath, section.branch, baseBranch);
  if (existingPrNumber !== null) {
    console.log(`[section-pr] PR #${existingPrNumber} already exists for section "${section.name}" — recording it`);
    setSectionPrNumber(db, sectionId, existingPrNumber);
    try {
      updatePrMetadata(projectPath, existingPrNumber, metadata);
    } catch (error) {
      console.error(
        `[section-pr] Failed to update PR metadata for section "${section.name}" (#${existingPrNumber}):`,
        error instanceof Error ? error.message : String(error)
      );
    }
    await handleIntakePostPR({ db, sectionId, prNumber: existingPrNumber, config, projectPath });
    return existingPrNumber;
  }

  // Collect completed task titles for PR body
  const tasks = listTasks(db, { sectionId });
  const completedTitles = tasks
    .filter(t => t.status === 'completed')
    .map(t => t.title);

  if (!isGhAvailable()) {
    console.warn(`[section-pr] Section "${section.name}" complete but gh CLI not available — skipping PR creation`);
    return null;
  }

  try {
    const prNumber = createPr(projectPath, section.name, section.branch, baseBranch, completedTitles, metadata);
    setSectionPrNumber(db, sectionId, prNumber);
    console.log(`[section-pr] Created PR #${prNumber} for section "${section.name}" (${section.branch} → ${baseBranch})`);
    await handleIntakePostPR({ db, sectionId, prNumber, config, projectPath });
    return prNumber;
  } catch (error) {
    console.error(
      `[section-pr] Failed to create PR for section "${section.name}":`,
      error instanceof Error ? error.message : String(error)
    );
    // Don't throw — commits are already pushed. PR failure is non-fatal.
    return null;
  }
}
