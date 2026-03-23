/**
 * Coder invocation
 * Uses AI provider system for flexible LLM support
 */

import type { Task } from '../database/queries.js';
import { getSection, getTaskRejections, findResumableSession, invalidateSession, listTasks } from '../database/queries.js';
import { listTaskFeedback } from '../database/feedback-queries.js';
import { withDatabase } from '../database/connection.js';
import {
  generateCoderPrompt,
  generateResumingCoderPrompt,
  generateResumingCoderDeltaPrompt,
  generateBatchCoderPrompt,
  type CoderPromptContext,
} from '../prompts/coder.js';
import { getGitStatus, getGitDiff } from '../git/status.js';
import { loadConfig, type ReviewerConfig } from '../config/loader.js';
import { SessionNotFoundError } from '../providers/interface.js';
import { countTokens } from '../utils/tokens.js';
import { HistoryManager } from './history-manager.js';
import { BaseRunner, type BaseRunnerResult } from './base-runner.js';

export interface CoderResult extends BaseRunnerResult {}

export interface BatchCoderResult extends BaseRunnerResult {
  taskCount: number;
}

export function resolveEffectiveCoderConfig(task: Pick<Task, 'section_id'>, projectPath: string): ReviewerConfig | undefined {
  const projectCoderConfig = loadConfig(projectPath).ai?.coder;
  if (!task.section_id) {
    return projectCoderConfig;
  }

  let sectionProvider: ReviewerConfig['provider'] | null | undefined;
  let sectionModel: string | null | undefined;

  try {
    withDatabase(projectPath, (db) => {
      const section = getSection(db, task.section_id!);
      sectionProvider = section?.coder_provider as ReviewerConfig['provider'] | null | undefined;
      sectionModel = section?.coder_model;
    });
  } catch (error) {
    console.warn(`Could not load section coder overrides for task ${'id' in task ? task.id : 'unknown'}:`, error);
  }

  return {
    ...projectCoderConfig,
    provider: sectionProvider ?? projectCoderConfig?.provider,
    model: sectionModel ?? projectCoderConfig?.model,
  };
}

class CoderRunner extends BaseRunner {
  public async runTask(
    task: Task,
    projectPath: string,
    action: 'start' | 'resume',
    coordinatorGuidance?: string,
    runnerId?: string
  ): Promise<CoderResult> {
    const coderConfig = resolveEffectiveCoderConfig(task, projectPath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`CODER: ${task.title}`);
    console.log(`Action: ${action}`);
    console.log(`Task ID: ${task.id}`);
    console.log(`Provider: ${coderConfig?.provider ?? 'not configured'}`);
    console.log(`Model: ${coderConfig?.model ?? 'not configured'}`);
    if (coordinatorGuidance) {
      console.log(`Coordinator guidance: included (${coordinatorGuidance.length} chars)`);
    }
    console.log(`${'='.repeat(60)}\n`);

    let rejectionHistory: ReturnType<typeof getTaskRejections> = [];
    let resumeSessionId: string | null = null;
    let sectionTasks: { id: string; title: string; status: string }[] | undefined;
    let userFeedbackItems: string[] = [];

    try {
      withDatabase(projectPath, (db) => {
        rejectionHistory = getTaskRejections(db, task.id);

        if (task.section_id) {
          const allSectionTasks = listTasks(db, { sectionId: task.section_id });
          sectionTasks = allSectionTasks.map(t => ({ id: t.id, title: t.title, status: t.status }));
        }
        if (rejectionHistory.length > 0) {
          console.log(`Found ${rejectionHistory.length} previous rejection(s) - coder will see full history`);
        }

        const feedbackRows = listTaskFeedback(db, task.id);
        if (feedbackRows.length > 0) {
          userFeedbackItems = feedbackRows.map(f => f.feedback);
          console.log(`Found ${feedbackRows.length} user feedback item(s) for coder`);
        }

        if (coderConfig?.provider && coderConfig.provider !== 'claude' && coderConfig?.model) {
          resumeSessionId = findResumableSession(
            db,
            task.id,
            'coder',
            coderConfig.provider,
            coderConfig.model
          );
          if (resumeSessionId) {
            console.log(`Found resumable session: ${resumeSessionId.substring(0, 8)}... (resuming with delta prompt)`);
          }
        }
      });
    } catch (error) {
      console.warn('Could not fetch rejection history or session info:', error);
    }

    const context: CoderPromptContext = {
      task,
      projectPath,
      previousStatus: task.status,
      rejectionHistory,
      coordinatorGuidance,
      sectionTasks,
      userFeedbackItems: userFeedbackItems.length > 0 ? userFeedbackItems : undefined,
    };

    let prompt: string;

    if (resumeSessionId) {
      prompt = generateResumingCoderDeltaPrompt(context);
    } else if (action === 'resume') {
      context.gitStatus = getGitStatus(projectPath);
      context.gitDiff = getGitDiff(projectPath);
      prompt = generateResumingCoderPrompt(context);
    } else {
      prompt = generateCoderPrompt(context);
    }

    const promptFile = this.writePromptToTempFile(prompt, 'prompt');

    try {
      let result: CoderResult;
      let sessionNotFound = false;
      try {
        result = await this.invokeProvider(
          promptFile,
          'coder',
          coderConfig?.provider ?? 'unknown',
          coderConfig?.model ?? 'unknown',
          900_000,
          task.id,
          projectPath,
          resumeSessionId ?? undefined,
          runnerId
        );
      } catch (err: any) {
        if (err instanceof SessionNotFoundError) {
          console.warn(`Session not found for resume (${(resumeSessionId as string | null)?.substring(0, 8)}) — invalidating session and retrying fresh`);
          sessionNotFound = true;
          result = { success: false, exitCode: 1, stdout: '', stderr: '', duration: 0, timedOut: false };
        } else {
          throw err;
        }
      }

      if (resumeSessionId && sessionNotFound) {
        const providerName = coderConfig?.provider ?? 'unknown';
        const modelName = coderConfig?.model ?? 'unknown';
        let guardedPrompt = '';
        
        const { getTokenLimitForModel } = await import('../providers/registry.js');
        const maxContextWindow = await getTokenLimitForModel(providerName, modelName);
        const safeLimit = maxContextWindow - 8000;

        try {
          const baseContext = { ...context, rejectionHistory: [] };
          const basePrompt = generateCoderPrompt(baseContext);
          
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
           guardedPrompt = generateCoderPrompt(context);
           if (countTokens(guardedPrompt, modelName) > safeLimit) {
              throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit. Task cannot be processed.`);
           }
        }

        const freshPromptFile = this.writePromptToTempFile(guardedPrompt, 'prompt');
        try {
          result = await this.invokeProvider(
            freshPromptFile,
            'coder',
            providerName,
            modelName,
            900_000,
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
      console.log(`CODER COMPLETED`);
      console.log(`Exit code: ${result.exitCode}`);
      console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
      console.log(`${'='.repeat(60)}\n`);

      return result;
    } finally {
      this.cleanupTempFile(promptFile);
    }
  }

  public async runBatch(
    tasks: Task[],
    sectionName: string,
    projectPath: string
  ): Promise<BatchCoderResult> {
    const config = loadConfig(projectPath);
    const coderConfig = config.ai?.coder;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`BATCH CODER: Section "${sectionName}"`);
    console.log(`Tasks: ${tasks.length}`);
    tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} (${t.id})`));
    console.log(`Provider: ${coderConfig?.provider ?? 'not configured'}`);
    console.log(`Model: ${coderConfig?.model ?? 'not configured'}`);
    console.log(`${'='.repeat(60)}\n`);

    const prompt = generateBatchCoderPrompt({ tasks, projectPath, sectionName });
    const promptFile = this.writePromptToTempFile(prompt, 'prompt');

    try {
      const timeoutMs = 30 * 60 * 1000 + tasks.length * 5 * 60 * 1000;
      const result = await this.invokeProvider(
        promptFile,
        'coder',
        coderConfig?.provider ?? 'unknown',
        coderConfig?.model ?? 'unknown',
        timeoutMs,
        undefined,
        projectPath
      );

      console.log(`\n${'='.repeat(60)}`);
      console.log(`BATCH CODER COMPLETED`);
      console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
      console.log(`${'='.repeat(60)}\n`);

      return { ...result, taskCount: tasks.length };
    } finally {
      this.cleanupTempFile(promptFile);
    }
  }
}

export async function invokeCoder(
  task: Task,
  projectPath: string,
  action: 'start' | 'resume',
  coordinatorGuidance?: string,
  runnerId?: string
): Promise<CoderResult> {
  const runner = new CoderRunner();
  return runner.runTask(task, projectPath, action, coordinatorGuidance, runnerId);
}

export async function invokeCoderBatch(
  tasks: Task[],
  sectionName: string,
  projectPath: string
): Promise<BatchCoderResult> {
  const runner = new CoderRunner();
  return runner.runBatch(tasks, sectionName, projectPath);
}
