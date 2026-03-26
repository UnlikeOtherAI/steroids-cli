/**
 * Reviewer invocation
 * Uses AI provider system for flexible LLM support
 */

import type { Task } from '../database/queries.js';
import {
  listTasks,
  getTaskRejections,
  findResumableSession,
  invalidateSession,
} from '../database/queries.js';
import { listTaskFeedback } from '../database/feedback-queries.js';
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
import {
  getReviewerConfigs,
  isMultiReviewEnabled,
  resolveDecision,
  type FinalDecision,
  type MultiReviewRoute,
} from './reviewer-policy.js';
import { loadSubmissionContext } from './submission-context.js';

export interface ReviewerResult extends BaseRunnerResult {
  decision?: 'approve' | 'reject' | 'dispute' | 'skip';
  notes?: string;
  provider?: string;
  model?: string;
  /** True when coder submitted with [NO_OP_SUBMISSION] marker (no new commits, pre-existing work). */
  isNoOp?: boolean;
}

export { getReviewerConfigs, isMultiReviewEnabled, resolveDecision };
export type { FinalDecision, MultiReviewRoute };

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
    let userFeedbackItems: string[] = [];
    let isNoOp = false;

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

        const feedbackRows = listTaskFeedback(db, task.id);
        if (feedbackRows.length > 0) {
          userFeedbackItems = feedbackRows.map(f => f.feedback);
          console.log(`Found ${feedbackRows.length} user feedback item(s) for reviewer`);
        }

        const submissionContext = loadSubmissionContext(db, projectPath, task.id);
        submissionNotes = submissionContext.latestReviewNotes;
        isNoOp = submissionContext.isNoOp;
        if (submissionNotes) {
          console.log(`Coder included notes with submission`);
        }
        
        const submissionHistory = resolveSubmissionCommitHistoryWithRecovery(
          projectPath,
          submissionContext.approvalCandidateShas
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
      userFeedbackItems: userFeedbackItems.length > 0 ? userFeedbackItems : undefined,
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
        isNoOp,
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
    let batchFeedbackItems: string[] = [];
    withDatabase(projectPath, (db) => {
      const unresolved: string[] = [];

      taskCommits = tasks.map(task => {
        const submissionContext = loadSubmissionContext(db, projectPath, task.id);
        const submissionResolution = resolveSubmissionCommitWithRecovery(
          projectPath,
          submissionContext.approvalCandidateShas
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

      for (const t of tasks) {
        const rows = listTaskFeedback(db, t.id);
        for (const r of rows) {
          batchFeedbackItems.push(`[${t.title}] ${r.feedback}`);
        }
      }
      if (batchFeedbackItems.length > 0) {
        console.log(`Found ${batchFeedbackItems.length} user feedback item(s) across batch review tasks`);
      }
    });

    const context: BatchReviewerPromptContext = {
      tasks,
      projectPath,
      sectionName,
      taskCommits,
      config,
      reviewerCustomInstructions: effectiveReviewerConfig?.customInstructions,
      userFeedbackItems: batchFeedbackItems.length > 0 ? batchFeedbackItems : undefined,
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
