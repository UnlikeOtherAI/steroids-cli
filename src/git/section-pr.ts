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

// ─── Terminal state check ────────────────────────────────────────────────────

interface SectionCounts {
  total: number;
  active: number;
  completed: number;
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
      '--jq', '.[0].number',
    ], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
    return output ? parseInt(output, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Create a GitHub PR for the section branch and return its number.
 * Throws on failure.
 */
function createPr(
  projectPath: string,
  sectionName: string,
  headBranch: string,
  baseBranch: string,
  completedTaskTitles: string[]
): number {
  const prBody = [
    `## ${sectionName}`,
    '',
    '### Completed tasks',
    completedTaskTitles.map(t => `- ${t}`).join('\n'),
    '',
    '_Auto-created by steroids on section completion._',
  ].join('\n');

  const output = execFileSync('gh', [
    'pr', 'create',
    '--base', baseBranch,
    '--head', headBranch,
    '--title', `Section: ${sectionName}`,
    '--body', prBody,
  ], {
    cwd: projectPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim();

  // `gh pr create` outputs the PR URL on success. Extract the number from the URL.
  const match = output.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`gh pr create succeeded but output was unexpected: ${output}`);
  }
  return parseInt(match[1], 10);
}

// ─── Core function ───────────────────────────────────────────────────────────

/**
 * Check whether a section is complete and create a PR if auto_pr is enabled.
 *
 * Idempotent: if pr_number is already set, does nothing.
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
): Promise<void> {
  if (!sectionId) return;

  const section = getSection(db, sectionId);
  if (!section) return;

  // Skip if auto_pr is not enabled
  if (!section.auto_pr) return;

  // Skip if no branch is set (can't create PR without a branch)
  if (!section.branch) return;

  // Idempotent: skip if PR already exists
  if (section.pr_number != null) return;

  // Check task completion
  const counts = getSectionCounts(db, sectionId);
  if (counts.total === 0 || counts.active > 0 || counts.completed === 0) return;

  // All tasks are in terminal states and at least one completed — create the PR
  const baseBranch = config.git?.branch ?? 'main';

  // Check for existing PR first (handles race or external creation)
  const existingPrNumber = findExistingPr(projectPath, section.branch, baseBranch);
  if (existingPrNumber !== null) {
    console.log(`[section-pr] PR #${existingPrNumber} already exists for section "${section.name}" — recording it`);
    setSectionPrNumber(db, sectionId, existingPrNumber);
    return;
  }

  // Collect completed task titles for PR body
  const tasks = listTasks(db, { sectionId });
  const completedTitles = tasks
    .filter(t => t.status === 'completed')
    .map(t => t.title);

  if (!isGhAvailable()) {
    console.warn(`[section-pr] Section "${section.name}" complete but gh CLI not available — skipping PR creation`);
    return;
  }

  try {
    const prNumber = createPr(projectPath, section.name, section.branch, baseBranch, completedTitles);
    setSectionPrNumber(db, sectionId, prNumber);
    console.log(`[section-pr] Created PR #${prNumber} for section "${section.name}" (${section.branch} → ${baseBranch})`);
  } catch (error) {
    console.error(
      `[section-pr] Failed to create PR for section "${section.name}":`,
      error instanceof Error ? error.message : String(error)
    );
    // Don't throw — commits are already pushed. PR failure is non-fatal.
  }
}
