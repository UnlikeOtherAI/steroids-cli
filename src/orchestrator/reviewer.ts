/**
 * Reviewer invocation
 * Uses AI provider system for flexible LLM support
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import { listTasks, getTaskRejections, getLatestSubmissionNotes } from '../database/queries.js';
import { openDatabase } from '../database/connection.js';
import {
  generateReviewerPrompt,
  generateBatchReviewerPrompt,
  type ReviewerPromptContext,
  type BatchReviewerPromptContext,
} from '../prompts/reviewer.js';
import type { SectionTask } from '../prompts/prompt-helpers.js';
import {
  getGitDiff,
  getModifiedFiles,
  findTaskCommit,
  getCommitDiff,
  getCommitFiles,
} from '../git/status.js';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';

export interface ReviewerResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  decision?: 'approve' | 'reject' | 'dispute';
  notes?: string;
}

export interface BatchReviewerResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  taskCount: number;
}

/**
 * Write prompt to temp file
 */
function writePromptToTempFile(prompt: string): string {
  const tempPath = join(tmpdir(), `steroids-reviewer-${Date.now()}.txt`);
  writeFileSync(tempPath, prompt, 'utf-8');
  return tempPath;
}

/**
 * Parse reviewer output for decision
 */
function parseReviewerDecision(output: string): { decision?: 'approve' | 'reject' | 'dispute'; notes?: string } {
  const upperOutput = output.toUpperCase();

  // Look for explicit decision markers
  if (upperOutput.includes('DECISION: APPROVE') || upperOutput.includes('**APPROVE**') || /\bAPPROVE\b/.test(upperOutput)) {
    // Extract notes if present
    const notesMatch = output.match(/(?:notes?|feedback|comments?):\s*["']?([^"'\n]+)/i);
    return { decision: 'approve', notes: notesMatch?.[1]?.trim() };
  }

  if (upperOutput.includes('DECISION: REJECT') || upperOutput.includes('**REJECT**') || /\bREJECT\b/.test(upperOutput)) {
    // Extract rejection notes
    const notesMatch = output.match(/(?:notes?|reason|feedback|issues?):\s*["']?([^"'\n]+)/i);
    return { decision: 'reject', notes: notesMatch?.[1]?.trim() || 'See reviewer output for details' };
  }

  if (upperOutput.includes('DECISION: DISPUTE') || upperOutput.includes('**DISPUTE**') || /\bDISPUTE\b/.test(upperOutput)) {
    const notesMatch = output.match(/(?:reason|notes?):\s*["']?([^"'\n]+)/i);
    return { decision: 'dispute', notes: notesMatch?.[1]?.trim() };
  }

  return {};
}

/**
 * Invoke AI provider with prompt
 * Uses configuration to determine which provider to use
 */
async function invokeProvider(
  promptFile: string,
  timeoutMs: number = 600_000, // 10 minutes default for reviewer
  taskId?: string,
  projectPath?: string
): Promise<ReviewerResult> {
  // Load configuration to get reviewer provider settings
  // Project config overrides global config
  const config = loadConfig(projectPath);
  const reviewerConfig = config.ai?.reviewer;

  if (!reviewerConfig?.provider || !reviewerConfig?.model) {
    throw new Error(
      'Reviewer AI provider not configured. Run "steroids config ai reviewer" to configure.'
    );
  }

  // Get the provider from registry
  const registry = getProviderRegistry();
  const provider = registry.get(reviewerConfig.provider);

  // Check if provider is available
  if (!(await provider.isAvailable())) {
    throw new Error(
      `Provider '${reviewerConfig.provider}' is not available. ` +
      `Ensure the CLI is installed and in PATH.`
    );
  }

  // Read prompt content
  const promptContent = readFileSync(promptFile, 'utf-8');

  // Invoke the provider
  const result = await provider.invoke(promptContent, {
    model: reviewerConfig.model,
    timeout: timeoutMs,
    cwd: process.cwd(),
    promptFile,
    role: 'reviewer',
    streamOutput: true,
  });

  // Log the invocation (to both file and database)
  logInvocation(promptContent, result, {
    role: 'reviewer',
    provider: reviewerConfig.provider,
    model: reviewerConfig.model,
    taskId,
    projectPath,
  });

  // Parse the decision from output
  const { decision, notes } = parseReviewerDecision(result.stdout);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration: result.duration,
    timedOut: result.timedOut,
    decision,
    notes,
  };
}

/**
 * Invoke reviewer for a task
 * @param coordinatorGuidance Optional guidance from coordinator after repeated rejections
 * @param coordinatorDecision Optional decision type from coordinator
 */
export async function invokeReviewer(
  task: Task,
  projectPath: string,
  coordinatorGuidance?: string,
  coordinatorDecision?: string
): Promise<ReviewerResult> {
  // Load config to show provider/model being used
  const config = loadConfig(projectPath);
  const reviewerConfig = config.ai?.reviewer;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`REVIEWER: ${task.title}`);
  console.log(`Task ID: ${task.id}`);
  console.log(`Rejection count: ${task.rejection_count}/15`);
  console.log(`Provider: ${reviewerConfig?.provider ?? 'not configured'}`);
  console.log(`Model: ${reviewerConfig?.model ?? 'not configured'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Try to find the specific commit for this task
  let gitDiff: string;
  let modifiedFiles: string[];
  const commitHash = findTaskCommit(projectPath, task.title);

  if (commitHash) {
    console.log(`Found task commit: ${commitHash}`);
    gitDiff = getCommitDiff(projectPath, commitHash);
    modifiedFiles = getCommitFiles(projectPath, commitHash);
  } else {
    // Fallback to HEAD~1 if no matching commit found
    console.log('No matching commit found, using HEAD~1 diff');
    gitDiff = getGitDiff(projectPath, 'HEAD~1');
    modifiedFiles = getModifiedFiles(projectPath);
  }

  // Fetch other tasks in the same section for context
  let sectionTasks: SectionTask[] = [];
  let rejectionHistory: ReturnType<typeof getTaskRejections> = [];
  let submissionNotes: string | null = null;

  try {
    const { db, close } = openDatabase(projectPath);

    // Get section tasks
    if (task.section_id) {
      const allSectionTasks = listTasks(db, { sectionId: task.section_id });
      sectionTasks = allSectionTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
      }));
    }

    // Get rejection history - ALWAYS fetch this so reviewer can see past attempts
    rejectionHistory = getTaskRejections(db, task.id);
    if (rejectionHistory.length > 0) {
      console.log(`Found ${rejectionHistory.length} previous rejection(s) for this task`);
    }

    // Get coder's submission notes (if any)
    submissionNotes = getLatestSubmissionNotes(db, task.id);
    if (submissionNotes) {
      console.log(`Coder included notes with submission`);
    }

    close();
  } catch (error) {
    console.warn('Could not fetch task context:', error);
  }

  // Reuse config loaded earlier, get reviewer model
  const reviewerModel = reviewerConfig?.model || 'unknown';

  const context: ReviewerPromptContext = {
    task,
    projectPath,
    reviewerModel,
    gitDiff,
    modifiedFiles,
    sectionTasks,
    rejectionHistory,
    submissionNotes,
    config,
    coordinatorGuidance,
    coordinatorDecision,
  };

  const prompt = generateReviewerPrompt(context);

  // Write prompt to temp file
  const promptFile = writePromptToTempFile(prompt);

  try {
    const result = await invokeProvider(promptFile, 600_000, task.id, projectPath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`REVIEWER COMPLETED`);
    console.log(`Exit code: ${result.exitCode}`);
    console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
    console.log(`${'='.repeat(60)}\n`);

    return result;
  } finally {
    // Clean up temp file
    if (existsSync(promptFile)) {
      unlinkSync(promptFile);
    }
  }
}

/**
 * Invoke reviewer for a batch of tasks
 */
export async function invokeReviewerBatch(
  tasks: Task[],
  sectionName: string,
  projectPath: string
): Promise<BatchReviewerResult> {
  // Load config for quality settings and to show provider/model being used
  const config = loadConfig(projectPath);
  const reviewerConfig = config.ai?.reviewer;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`BATCH REVIEWER: Section "${sectionName}"`);
  console.log(`Tasks: ${tasks.length}`);
  tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} (${t.id})`));
  console.log(`Provider: ${reviewerConfig?.provider ?? 'not configured'}`);
  console.log(`Model: ${reviewerConfig?.model ?? 'not configured'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Get combined git diff for all tasks (compare against base before batch started)
  // We look for the earliest task's commit and diff from there
  const gitDiff = getGitDiff(projectPath, 'HEAD~' + tasks.length);
  const modifiedFiles = getModifiedFiles(projectPath);

  const context: BatchReviewerPromptContext = {
    tasks,
    projectPath,
    sectionName,
    gitDiff,
    modifiedFiles,
    config,
  };

  const prompt = generateBatchReviewerPrompt(context);
  const promptFile = writePromptToTempFile(prompt);

  try {
    // Longer timeout for batch: base 20 minutes + 3 minutes per task
    const timeoutMs = 20 * 60 * 1000 + tasks.length * 3 * 60 * 1000;
    const result = await invokeProvider(promptFile, timeoutMs, undefined, projectPath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`BATCH REVIEWER COMPLETED`);
    console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
    console.log(`${'='.repeat(60)}\n`);

    return { ...result, taskCount: tasks.length };
  } finally {
    if (existsSync(promptFile)) {
      unlinkSync(promptFile);
    }
  }
}
