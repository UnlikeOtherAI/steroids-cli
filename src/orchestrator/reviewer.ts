/**
 * Reviewer invocation
 * Uses AI provider system for flexible LLM support
 */

import type { Task } from '../database/queries.js';
import {
  listTasks,
  getTaskRejections,
  getLatestSubmissionNotes,
  getSubmissionCommitShas,
  findResumableSession,
  invalidateSession,
} from '../database/queries.js';
import { withDatabase } from '../database/connection.js';
import {
  generateReviewerPrompt,
  generateResumingReviewerDeltaPrompt,
  generateBatchReviewerPrompt,
  type ReviewerPromptContext,
  type BatchReviewerPromptContext,
} from '../prompts/reviewer.js';
import type { SectionTask } from '../prompts/prompt-helpers.js';
import { loadConfig, type ReviewerConfig, type SteroidsConfig } from '../config/loader.js';
import { SessionNotFoundError } from '../providers/interface.js';
import { countTokens } from '../utils/tokens.js';
import { resolveSubmissionCommitHistoryWithRecovery, resolveSubmissionCommitWithRecovery } from '../git/submission-resolution.js';
import { HistoryManager } from './history-manager.js';
import { BaseRunner, type BaseRunnerResult } from './base-runner.js';
import { parseReviewerDecisionSignal } from './reviewer-decision-parser.js';

export interface ReviewerResult extends BaseRunnerResult {
  decision?: 'approve' | 'reject' | 'dispute' | 'skip';
  notes?: string;
  provider?: string;
  model?: string;
  /** True when coder submitted with [NO_OP_SUBMISSION] marker (no new commits, pre-existing work). */
  isNoOp?: boolean;
}

export type FinalDecision = 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';

export type MultiReviewRoute = 'direct' | 'local_reject_merge' | 'arbitrate';

/**
 * Deterministic policy engine for multi-reviewer decisions
 */
export function resolveDecision(
  results: ReviewerResult[],
): { decision: FinalDecision; needsMerge: boolean; route: MultiReviewRoute } {
  if (results.length === 0) return { decision: 'unclear', needsMerge: false, route: 'direct' };

  const decisions = results.map(r => r.decision);
  const defined = decisions.filter((d): d is Exclude<FinalDecision, 'unclear'> => d !== undefined);
  const hasReject = defined.includes('reject');
  const hasDispute = defined.includes('dispute');
  const hasApprove = defined.includes('approve');
  const hasSkip = defined.includes('skip');
  const hasUndefined = decisions.some(d => d === undefined);

  if (!hasUndefined && defined.length > 0 && defined.every(d => d === 'approve')) {
    return { decision: 'approve', needsMerge: false, route: 'direct' };
  }
  if (!hasUndefined && defined.length > 0 && defined.every(d => d === 'skip')) {
    return { decision: 'skip', needsMerge: false, route: 'direct' };
  }
  if (!hasUndefined && defined.length > 0 && defined.every(d => d === 'dispute')) {
    return { decision: 'dispute', needsMerge: false, route: 'direct' };
  }
  if (!hasUndefined && !hasDispute && hasReject && defined.every(d => d === 'reject')) {
    const rejectCount = defined.length;
    return {
      decision: 'reject',
      needsMerge: rejectCount > 1,
      route: rejectCount > 1 ? 'local_reject_merge' : 'direct',
    };
  }
  if (!hasUndefined && !hasReject && !hasDispute && hasApprove && hasSkip) {
    return { decision: 'unclear', needsMerge: false, route: 'arbitrate' };
  }
  if (hasReject || hasDispute || hasUndefined) {
    return { decision: 'unclear', needsMerge: false, route: 'arbitrate' };
  }
  return { decision: 'unclear', needsMerge: false, route: 'direct' };
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
        isNoOp: false,
      };
    }
  });
}

export interface BatchReviewerResult extends BaseRunnerResult {
  taskCount: number;
}

class ReviewerRunner extends BaseRunner {
  public async runTask(
    task: Task,
    projectPath: string,
    coordinatorGuidance?: string,
    coordinatorDecision?: string,
    reviewerConfig?: ReviewerConfig,
    runnerId?: string
  ): Promise<ReviewerResult> {
    const config = loadConfig(projectPath);
    const effectiveReviewerConfig = reviewerConfig || config.ai?.reviewer;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`REVIEWER: ${task.title}`);
    console.log(`Task ID: ${task.id}`);
    console.log(`Rejection count: ${task.rejection_count}/15`);
    console.log(`Provider: ${effectiveReviewerConfig?.provider ?? 'not configured'}`);
    console.log(`Model: ${effectiveReviewerConfig?.model ?? 'not configured'}`);
    console.log(`${'='.repeat(60)}\n`);

    let sectionTasks: SectionTask[] = [];
    let rejectionHistory: ReturnType<typeof getTaskRejections> = [];
    let submissionNotes: string | null = null;
    let resumeSessionId: string | null = null;
    let submissionCommitHash: string | null = null;
    let submissionCommitHashes: string[] = [];
    let unresolvedSubmissionCommits: string[] = [];

    try {
      withDatabase(projectPath, (db) => {
        if (task.section_id) {
          const allSectionTasks = listTasks(db, { sectionId: task.section_id });
          sectionTasks = allSectionTasks.map(t => ({
            id: t.id,
            title: t.title,
            status: t.status,
          }));
        }

        rejectionHistory = getTaskRejections(db, task.id);
        if (rejectionHistory.length > 0) {
          console.log(`Found ${rejectionHistory.length} previous rejection(s) for this task`);
        }

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

        if (effectiveReviewerConfig?.provider && effectiveReviewerConfig.provider !== 'claude' && effectiveReviewerConfig?.model) {
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not fetch reviewer context: ${message}`);
    }

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
      reviewerCustomInstructions: effectiveReviewerConfig?.customInstructions,
    };

    let prompt: string;
    if (resumeSessionId) {
      prompt = generateResumingReviewerDeltaPrompt(context);
    } else {
      prompt = generateReviewerPrompt(context);
    }

    const promptFile = this.writePromptToTempFile(prompt, 'reviewer');

    try {
      let baseResult: BaseRunnerResult;
      let sessionNotFound = false;
      const providerName = effectiveReviewerConfig?.provider ?? 'unknown';
      const modelName = effectiveReviewerConfig?.model ?? 'unknown';

      try {
        baseResult = await this.invokeProvider(
          promptFile,
          'reviewer',
          providerName,
          modelName,
          600_000,
          task.id,
          projectPath,
          resumeSessionId ?? undefined,
          runnerId
        );
      } catch (err: any) {
        if (err instanceof SessionNotFoundError) {
          console.warn(`Session not found for resume (${(resumeSessionId as string | null)?.substring(0, 8)}) — invalidating session and retrying fresh`);
          sessionNotFound = true;
          baseResult = { success: false, exitCode: 1, stdout: '', stderr: '', duration: 0, timedOut: false };
        } else {
          throw err;
        }
      }

      if (resumeSessionId && sessionNotFound) {
        let guardedPrompt = '';
        const { getTokenLimitForModel } = await import('../providers/registry.js');
        const maxContextWindow = await getTokenLimitForModel(providerName, modelName);
        const safeLimit = maxContextWindow - 8000;

        try {
          const baseContext = { ...context, rejectionHistory: [] };
          const basePrompt = generateReviewerPrompt(baseContext);
          
          const historyResult = HistoryManager.reconstructHistoryWithTokenGuard(
            projectPath,
            task.id,
            resumeSessionId,
            basePrompt,
            modelName,
            safeLimit
          );
          
          guardedPrompt = historyResult.finalPrompt;
          
          withDatabase(projectPath, (db) => {
             invalidateSession(db, resumeSessionId!);
          });
        } catch (e: any) {
           if (e.message.includes('Context Too Large')) throw e;
           guardedPrompt = generateReviewerPrompt(context);
           if (countTokens(guardedPrompt, modelName) > safeLimit) {
              throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit. Task cannot be processed.`);
           }
        }

        const freshPromptFile = this.writePromptToTempFile(guardedPrompt, 'reviewer');
        try {
          baseResult = await this.invokeProvider(
            freshPromptFile,
            'reviewer',
            providerName,
            modelName,
            600_000,
            task.id,
            projectPath,
            undefined,
            runnerId
          );
        } finally {
          this.cleanupTempFile(freshPromptFile);
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`REVIEWER COMPLETED`);
      console.log(`Exit code: ${baseResult.exitCode}`);
      console.log(`Duration: ${(baseResult.duration / 1000).toFixed(1)}s`);
      console.log(`${'='.repeat(60)}\n`);

      const parsedDecision = parseReviewerDecisionSignal(baseResult.stdout);
      const decision = parsedDecision.decision === 'unclear' ? undefined : parsedDecision.decision;

      return {
        ...baseResult,
        decision,
        notes: decision === 'reject' ? 'See reviewer output for details' : undefined,
        provider: providerName,
        model: modelName,
        isNoOp: Boolean((submissionNotes as string | null)?.startsWith('[NO_OP_SUBMISSION]')),
      };
    } finally {
      this.cleanupTempFile(promptFile);
    }
  }

  public async runBatch(
    tasks: Task[],
    sectionName: string,
    projectPath: string,
    reviewerConfig?: ReviewerConfig
  ): Promise<BatchReviewerResult> {
    const config = loadConfig(projectPath);
    const effectiveReviewerConfig = reviewerConfig || config.ai?.reviewer;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`BATCH REVIEWER: Section "${sectionName}"`);
    console.log(`Tasks: ${tasks.length}`);
    tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} (${t.id})`));
    console.log(`Provider: ${effectiveReviewerConfig?.provider ?? 'not configured'}`);
    console.log(`Model: ${effectiveReviewerConfig?.model ?? 'not configured'}`);
    console.log(`${'='.repeat(60)}\n`);

    let taskCommits: Array<{ taskId: string; commitHash: string }> = [];
    withDatabase(projectPath, (db) => {
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
    });

    const context: BatchReviewerPromptContext = {
      tasks,
      projectPath,
      sectionName,
      taskCommits,
      config,
      reviewerCustomInstructions: effectiveReviewerConfig?.customInstructions,
    };

    const prompt = generateBatchReviewerPrompt(context);
    const promptFile = this.writePromptToTempFile(prompt, 'reviewer');

    try {
      const timeoutMs = 20 * 60 * 1000 + tasks.length * 3 * 60 * 1000;
      const baseResult = await this.invokeProvider(
        promptFile,
        'reviewer',
        effectiveReviewerConfig?.provider ?? 'unknown',
        effectiveReviewerConfig?.model ?? 'unknown',
        timeoutMs,
        undefined,
        projectPath
      );

      console.log(`\n${'='.repeat(60)}`);
      console.log(`BATCH REVIEWER COMPLETED`);
      console.log(`Duration: ${(baseResult.duration / 1000).toFixed(1)}s`);
      console.log(`${'='.repeat(60)}\n`);

      return { ...baseResult, taskCount: tasks.length };
    } finally {
      this.cleanupTempFile(promptFile);
    }
  }
}

export async function invokeReviewer(
  task: Task,
  projectPath: string,
  coordinatorGuidance?: string,
  coordinatorDecision?: string,
  reviewerConfig?: ReviewerConfig,
  runnerId?: string
): Promise<ReviewerResult> {
  const runner = new ReviewerRunner();
  return runner.runTask(task, projectPath, coordinatorGuidance, coordinatorDecision, reviewerConfig, runnerId);
}

export async function invokeReviewerBatch(
  tasks: Task[],
  sectionName: string,
  projectPath: string,
  reviewerConfig?: ReviewerConfig
): Promise<BatchReviewerResult> {
  const runner = new ReviewerRunner();
  return runner.runBatch(tasks, sectionName, projectPath, reviewerConfig);
}
