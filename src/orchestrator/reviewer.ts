/**
 * Reviewer invocation
 * Uses AI provider system for flexible LLM support
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import { listTasks, getTaskRejections, getLatestSubmissionNotes, findResumableSession, invalidateSession } from '../database/queries.js';
import { openDatabase } from '../database/connection.js';
import {
  generateReviewerPrompt,
  generateResumingReviewerDeltaPrompt,
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
import { loadConfig, type ReviewerConfig, type SteroidsConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';

export interface ReviewerResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  decision?: 'approve' | 'reject' | 'dispute' | 'skip';
  notes?: string;
  provider?: string;
  model?: string;
}

export type FinalDecision = 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';

/**
 * Deterministic policy engine for multi-reviewer decisions
 */
export function resolveDecision(
  results: ReviewerResult[],
): { decision: FinalDecision; needsMerge: boolean } {
  if (results.length === 0) return { decision: 'unclear', needsMerge: false };

  // Use the decision matrix priority: REJECT > DISPUTE > APPROVE > SKIP
  const decisions = results.map(r => r.decision);

  // 1. Any reject -> REJECT
  if (decisions.some(d => d === 'reject')) {
    const rejectorsWithNotes = results.filter(r => r.decision === 'reject' && r.notes);
    return { decision: 'reject', needsMerge: rejectorsWithNotes.length > 1 };
  }

  // 2. Any dispute (with no rejections) -> DISPUTE
  if (decisions.some(d => d === 'dispute')) {
    return { decision: 'dispute', needsMerge: false };
  }

  // 3. All approve -> APPROVE
  if (decisions.length > 0 && decisions.every(d => d === 'approve')) {
    return { decision: 'approve', needsMerge: false };
  }

  // 4. Mix of approve/skip or all skip -> depends
  const approvals = decisions.filter(d => d === 'approve').length;
  if (approvals === 0) {
    if (decisions.every(d => d === 'skip')) {
      return { decision: 'skip', needsMerge: false };
    }
    return { decision: 'unclear', needsMerge: false };
  }

  // Some approve, some skip -> not enough approvals for a definitive APPROVE in multi-review
  return { decision: 'unclear', needsMerge: false };
}

/**
 * Helper to get reviewer configurations, handling both singular and plural config
 */
export function getReviewerConfigs(config: SteroidsConfig): ReviewerConfig[] {
  if (config.ai?.reviewers && config.ai.reviewers.length > 0) {
    return config.ai.reviewers;
  }
  if (config.ai?.reviewer) {
    return [config.ai.reviewer];
  }
  return [];
}

/**
 * Check if multi-review is enabled
 */
export function isMultiReviewEnabled(config: SteroidsConfig): boolean {
  return !!(config.ai?.reviewers && config.ai.reviewers.length > 1);
}

/**
 * Invoke multiple reviewers in parallel
 */
export async function invokeReviewers(
  task: Task,
  projectPath: string,
  reviewerConfigs: ReviewerConfig[],
  coordinatorGuidance?: string,
  coordinatorDecision?: string
): Promise<ReviewerResult[]> {
  const results = await Promise.allSettled(
    reviewerConfigs.map(config =>
      invokeReviewer(task, projectPath, coordinatorGuidance, coordinatorDecision, config)
    )
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') {
      return r.value;
    } else {
      // Return a failed reviewer result
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: r.reason?.message || String(r.reason),
        duration: 0,
        timedOut: false,
        provider: reviewerConfigs[i].provider,
        model: reviewerConfigs[i].model,
      };
    }
  });
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
function parseReviewerDecision(output: string): { decision?: 'approve' | 'reject' | 'dispute' | 'skip'; notes?: string } {
  const tokenMap: Record<string, 'approve' | 'reject' | 'dispute' | 'skip'> = {
    APPROVE: 'approve',
    REJECT: 'reject',
    DISPUTE: 'dispute',
    SKIP: 'skip',
  };

  const explicitToken = output.match(
    /^\s*(?:\*\*)?DECISION(?:\*\*)?\s*(?::|-)\s*(APPROVE|REJECT|DISPUTE|SKIP)\b/im
  )?.[1]?.toUpperCase();

  const firstNonEmptyLine = output.split('\n').find(line => line.trim().length > 0)?.trim();
  const firstLineToken = firstNonEmptyLine?.match(/^(APPROVE|REJECT|DISPUTE|SKIP)\b/i)?.[1]?.toUpperCase();

  const resolvedToken = explicitToken || firstLineToken;
  if (!resolvedToken || !tokenMap[resolvedToken]) {
    return {};
  }

  const decision = tokenMap[resolvedToken];
  const notesMatch = output.match(/(?:notes?|reason|feedback|issues?|comments?):\s*["']?([^"'\n]+)/i);
  const extractedNotes = notesMatch?.[1]?.trim();

  if (decision === 'reject') {
    return { decision, notes: extractedNotes || 'See reviewer output for details' };
  }

  return { decision, notes: extractedNotes };
}

/**
 * Invoke AI provider with prompt
 * Uses configuration to determine which provider to use
 */
async function invokeProvider(
  promptFile: string,
  timeoutMs: number = 600_000, // 10 minutes default for reviewer
  taskId?: string,
  projectPath?: string,
  reviewerConfig?: ReviewerConfig,
  resumeSessionId?: string
): Promise<ReviewerResult> {
  // Load configuration to get reviewer provider settings if not provided
  // Project config overrides global config
  if (!reviewerConfig) {
    const config = loadConfig(projectPath);
    reviewerConfig = config.ai?.reviewer;
  }

  const providerName = reviewerConfig?.provider;
  const modelName = reviewerConfig?.model;

  if (!providerName || !modelName) {
    throw new Error(
      'Reviewer AI provider not configured. Run "steroids config ai reviewer" to configure.'
    );
  }

  // Get the provider from registry
  const registry = await getProviderRegistry();
  const provider = registry.get(providerName);

  // Check if provider is available
  if (!(await provider.isAvailable())) {
    throw new Error(
      `Provider '${providerName}' is not available. ` +
      `Ensure the CLI is installed and in PATH.`
    );
  }

  // Read prompt content
  const promptContent = readFileSync(promptFile, 'utf-8');

  const result = await logInvocation(
    promptContent,
    (ctx) =>
      provider.invoke(promptContent, {
        model: modelName,
        timeout: timeoutMs,
        cwd: projectPath ?? process.cwd(),
        promptFile,
        role: 'reviewer',
        streamOutput: true,
        onActivity: ctx?.onActivity,
        resumeSessionId,
      }),
    {
      role: 'reviewer',
      provider: providerName,
      model: modelName,
      taskId,
      projectPath,
      resumedFromSessionId: resumeSessionId ?? undefined,
      invocationMode: resumeSessionId ? 'resume' : 'fresh',
    }
  );

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
    provider: providerName,
    model: modelName,
  };
}

/**
 * Invoke reviewer for a task
 * @param coordinatorGuidance Optional guidance from coordinator after repeated rejections
 * @param coordinatorDecision Optional decision type from coordinator
 * @param reviewerConfig Optional reviewer configuration to override default
 */
export async function invokeReviewer(
  task: Task,
  projectPath: string,
  coordinatorGuidance?: string,
  coordinatorDecision?: string,
  reviewerConfig?: ReviewerConfig
): Promise<ReviewerResult> {
  // Load config to show provider/model being used
  const config = loadConfig(projectPath);
  const effectiveReviewerConfig = reviewerConfig || config.ai?.reviewer;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`REVIEWER: ${task.title}`);
  console.log(`Task ID: ${task.id}`);
  console.log(`Rejection count: ${task.rejection_count}/15`);
  console.log(`Provider: ${effectiveReviewerConfig?.provider ?? 'not configured'}`);
  console.log(`Model: ${effectiveReviewerConfig?.model ?? 'not configured'}`);
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
  let resumeSessionId: string | null = null;

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

    // Check for resumable session (same provider/model/role)
    if (effectiveReviewerConfig?.provider && effectiveReviewerConfig?.model) {
      resumeSessionId = findResumableSession(
        db,
        task.id,
        'reviewer',
        effectiveReviewerConfig.provider,
        effectiveReviewerConfig.model
      );
      if (resumeSessionId) {
        console.log(`Found resumable session: ${resumeSessionId.substring(0, 8)}... (resuming with delta prompt)`);
      }
    }

    close();
  } catch (error) {
    console.warn('Could not fetch task context:', error);
  }

  // Reuse config loaded earlier, get reviewer model
  const reviewerModel = effectiveReviewerConfig?.model || 'unknown';

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

  let prompt: string;
  if (resumeSessionId) {
    prompt = generateResumingReviewerDeltaPrompt(context);
  } else {
    prompt = generateReviewerPrompt(context);
  }

  // Write prompt to temp file
  const promptFile = writePromptToTempFile(prompt);

  try {
    let result = await invokeProvider(
      promptFile,
      600_000,
      task.id,
      projectPath,
      effectiveReviewerConfig,
      resumeSessionId ?? undefined
    );

    // If session resume returned empty output, invalidate session and retry fresh
    if (resumeSessionId && result.stdout.trim().length === 0) {
      console.warn(`Session resume returned empty output — invalidating session ${resumeSessionId.substring(0, 8)}... and retrying fresh`);
      try {
        const { db, close } = openDatabase(projectPath);
        invalidateSession(db, resumeSessionId);
        close();
      } catch {}

      // Generate fresh prompt and retry
      const freshPrompt = generateReviewerPrompt(context);
      const freshPromptFile = writePromptToTempFile(freshPrompt);
      try {
        result = await invokeProvider(
          freshPromptFile,
          600_000,
          task.id,
          projectPath,
          effectiveReviewerConfig
        );
      } finally {
        if (existsSync(freshPromptFile)) unlinkSync(freshPromptFile);
      }
    }

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
 * @param tasks Tasks to review
 * @param sectionName Section name
 * @param projectPath Project path
 * @param reviewerConfig Optional reviewer configuration to override default
 */
export async function invokeReviewerBatch(
  tasks: Task[],
  sectionName: string,
  projectPath: string,
  reviewerConfig?: ReviewerConfig
): Promise<BatchReviewerResult> {
  // Load config for quality settings and to show provider/model being used
  const config = loadConfig(projectPath);
  const effectiveReviewerConfig = reviewerConfig || config.ai?.reviewer;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`BATCH REVIEWER: Section "${sectionName}"`);
  console.log(`Tasks: ${tasks.length}`);
  tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} (${t.id})`));
  console.log(`Provider: ${effectiveReviewerConfig?.provider ?? 'not configured'}`);
  console.log(`Model: ${effectiveReviewerConfig?.model ?? 'not configured'}`);
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
    const result = await invokeProvider(promptFile, timeoutMs, undefined, projectPath, effectiveReviewerConfig);

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
