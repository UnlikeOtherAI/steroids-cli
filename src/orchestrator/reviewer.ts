/**
 * Reviewer invocation
 * Uses AI provider system for flexible LLM support
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import {
  listTasks,
  getTaskRejections,
  getLatestSubmissionNotes,
  getSubmissionCommitShas,
  findResumableSession,
  invalidateSession,
} from '../database/queries.js';
import { openDatabase } from '../database/connection.js';
import {
  generateReviewerPrompt,
  generateResumingReviewerDeltaPrompt,
  generateBatchReviewerPrompt,
  type ReviewerPromptContext,
  type BatchReviewerPromptContext,
} from '../prompts/reviewer.js';
import type { SectionTask } from '../prompts/prompt-helpers.js';
import { loadConfig, type ReviewerConfig, type SteroidsConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { SessionNotFoundError } from '../providers/interface.js';
import { countTokens, pruneResponseOutputs } from '../utils/tokens.js';
import { resolveSubmissionCommitHistoryWithRecovery, resolveSubmissionCommitWithRecovery } from '../git/submission-resolution.js';

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
  coordinatorDecision?: string,
  runnerId?: string
): Promise<ReviewerResult[]> {
  const results = await Promise.allSettled(
    reviewerConfigs.map(config =>
      invokeReviewer(task, projectPath, coordinatorGuidance, coordinatorDecision, config, runnerId)
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
  resumeSessionId?: string,
  runnerId?: string
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
            runnerId,
          }  );

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
  reviewerConfig?: ReviewerConfig,
  runnerId?: string
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

  // Fetch other tasks in the same section for context
  let sectionTasks: SectionTask[] = [];
  let rejectionHistory: ReturnType<typeof getTaskRejections> = [];
  let submissionNotes: string | null = null;
  let resumeSessionId: string | null = null;
  let submissionCommitHash: string | null = null;
  let submissionCommitHashes: string[] = [];
  let unresolvedSubmissionCommits: string[] = [];

  try {
    const { db, close } = openDatabase(projectPath);
    try {
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
      
      const submissionHistory = resolveSubmissionCommitHistoryWithRecovery(
        projectPath,
        getSubmissionCommitShas(db, task.id)
      );
      if (!submissionHistory.latestReachableSha) {
        const attemptsText = submissionHistory.attempts.join(' | ') || 'none';
        throw new Error(
          `No reachable submission commit hash found for task ${task.id} (${submissionHistory.reason ?? 'not_reachable'}; attempts: ${attemptsText})`
        );
      }
      submissionCommitHash = submissionHistory.latestReachableSha;
      submissionCommitHashes = submissionHistory.reachableShasOldestFirst;
      unresolvedSubmissionCommits = submissionHistory.unreachableShas;
      console.log(`Using submission commit chain (${submissionCommitHashes.length} reachable), latest: ${submissionCommitHash}`);
      if (unresolvedSubmissionCommits.length > 0) {
        console.log(`Warning: ${unresolvedSubmissionCommits.length} historical submission commit(s) unresolved`);
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
    } finally {
      close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch reviewer context: ${message}`);
  }

  // Reuse config loaded earlier, get reviewer model
  const reviewerModel = effectiveReviewerConfig?.model || 'unknown';

  const context: ReviewerPromptContext = {
    task,
    projectPath,
    reviewerModel,
    submissionCommitHash: submissionCommitHash!,
    submissionCommitHashes,
    unresolvedSubmissionCommits,
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
    let result: ReviewerResult;
    let sessionNotFound = false;
    try {
      result = await invokeProvider(
        promptFile,
        600_000,
        task.id,
        projectPath,
        effectiveReviewerConfig,
        resumeSessionId ?? undefined,
        runnerId
      );
    } catch (err: any) {
      if (err instanceof SessionNotFoundError) {
        console.warn(`Session not found for resume (${resumeSessionId?.substring(0, 8)}) — invalidating session and retrying fresh`);
        sessionNotFound = true;
        result = { success: false, exitCode: 1, stdout: '', stderr: '', duration: 0, timedOut: false, provider: '', model: '' };
      } else {
        throw err;
      }
    }

    // If session resume failed because session was not found, retry fresh
    if (resumeSessionId && sessionNotFound) {
      const providerName = effectiveReviewerConfig?.provider ?? 'unknown';
      const modelName = effectiveReviewerConfig?.model ?? 'unknown';
      let guardedPrompt = '';
      
      const { getTokenLimitForModel } = await import('../providers/registry.js');
      const { getTaskInvocationsBySession } = await import('../database/queries.js');

      const maxContextWindow = await getTokenLimitForModel(providerName, modelName);
      const reservedHeadroom = 8000;
      const safeLimit = maxContextWindow - reservedHeadroom;

      try {
        const { db, close } = openDatabase(projectPath);

        const baseContext = { ...context, rejectionHistory: [] };
        const basePrompt = generateReviewerPrompt(baseContext);
        const systemPromptSize = countTokens(basePrompt, modelName);
        
        if (systemPromptSize > safeLimit) {
          close();
          throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit (${systemPromptSize} > ${safeLimit} tokens). Task cannot be processed.`);
        }

        const invocations = getTaskInvocationsBySession(db, task.id, resumeSessionId);
        
        const buildHistory = (invs: typeof invocations, pruneOlder: boolean) => {
          let hist = '';
          for (let i = 0; i < invs.length; i++) {
            const inv = invs[i];
            // Skip the base prompt of the session (which is always the very first invocation in the DB for this session)
            // If we have shifted the array, we must not accidentally skip a continuation prompt.
            // We check if this invocation is the true original first one.
            const isOriginalFirst = inv.id === invocations[0].id;
            
            if (inv.prompt && !isOriginalFirst) {
               hist += `\n\n--- USER CONTINUATION ---\n${inv.prompt}`;
            }
            if (inv.response) {
               const isOlder = i < invs.length - 1;
               const responseText = (pruneOlder && isOlder) ? pruneResponseOutputs(inv.response) : inv.response;
               hist += `\n\n--- ASSISTANT RESPONSE ---\n${responseText}`;
            }
          }
          return hist;
        };

        let currentSize = countTokens(basePrompt + buildHistory(invocations, false), modelName);
        let finalHistoryText = '';
        const guardedInvocations = [...invocations];

        if (currentSize <= safeLimit) {
           finalHistoryText = buildHistory(guardedInvocations, false);
        } else {
           // Token Guard: First attempt to selectively prune tool outputs and thought blocks
           finalHistoryText = buildHistory(guardedInvocations, true);
           currentSize = countTokens(basePrompt + finalHistoryText, modelName);

           // Token Guard: Truncate history if still necessary by dropping oldest executions entirely
           while (currentSize > safeLimit && guardedInvocations.length > 0) {
             guardedInvocations.shift(); // Prune oldest entry
             finalHistoryText = buildHistory(guardedInvocations, true);
             currentSize = countTokens(basePrompt + finalHistoryText, modelName);
           }
           
           if (guardedInvocations.length < invocations.length) {
             console.warn(`Token Guard: Pruned ${invocations.length - guardedInvocations.length} older execution(s) entirely to fit within ${safeLimit} token limit.`);
           } else {
             console.warn(`Token Guard: Selectively pruned tool/thought blocks to fit within ${safeLimit} token limit.`);
           }
        }

        guardedPrompt = basePrompt + finalHistoryText;

        invalidateSession(db, resumeSessionId);
        close();
      } catch (e: any) {
         if (e.message.includes('Context Too Large')) throw e;
         guardedPrompt = generateReviewerPrompt(context);
         if (countTokens(guardedPrompt, modelName) > safeLimit) {
            throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit. Task cannot be processed.`);
         }
      }

      // Generate guarded fresh prompt and retry
      const freshPromptFile = writePromptToTempFile(guardedPrompt);
      try {
        result = await invokeProvider(
          freshPromptFile,
          600_000,
          task.id,
          projectPath,
          effectiveReviewerConfig,
          undefined,
          runnerId
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

  const { db, close } = openDatabase(projectPath);
  let taskCommits: Array<{ taskId: string; commitHash: string }> = [];
  try {
    const unresolved: string[] = [];

    taskCommits = tasks.map(task => {
      const submissionResolution = resolveSubmissionCommitWithRecovery(
        projectPath,
        getSubmissionCommitShas(db, task.id)
      );
      if (submissionResolution.status !== 'resolved') {
        const attemptsText = submissionResolution.attempts.join(' | ') || 'none';
        unresolved.push(`${task.id} (${submissionResolution.reason}; attempts: ${attemptsText})`);
      }
      return { taskId: task.id, commitHash: submissionResolution.status === 'resolved' ? submissionResolution.sha : '' };
    });

    if (unresolved.length > 0) {
      throw new Error(`Missing reachable submission commit hash for batch review tasks: ${unresolved.join(', ')}`);
    }
  } finally {
    close();
  }

  const context: BatchReviewerPromptContext = {
    tasks,
    projectPath,
    sectionName,
    taskCommits,
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
