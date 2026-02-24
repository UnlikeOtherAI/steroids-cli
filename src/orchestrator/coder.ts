/**
 * Coder invocation
 * Uses AI provider system for flexible LLM support
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import { getTaskRejections, findResumableSession, invalidateSession } from '../database/queries.js';
import { openDatabase } from '../database/connection.js';
import {
  generateCoderPrompt,
  generateResumingCoderPrompt,
  generateResumingCoderDeltaPrompt,
  generateBatchCoderPrompt,
  type CoderPromptContext,
  type BatchCoderPromptContext,
} from '../prompts/coder.js';
import { getGitStatus, getGitDiff } from '../git/status.js';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { SessionNotFoundError } from '../providers/interface.js';
import { countTokens, pruneResponseOutputs } from '../utils/tokens.js';

export interface CoderResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}

export interface BatchCoderResult {
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
  const tempPath = join(tmpdir(), `steroids-prompt-${Date.now()}.txt`);
  writeFileSync(tempPath, prompt, 'utf-8');
  return tempPath;
}

/**
 * Invoke AI provider with prompt
 * Uses configuration to determine which provider to use
 */
async function invokeProvider(
  promptFile: string,
  timeoutMs: number = 900_000, // 15 minutes default
  taskId?: string,
  projectPath?: string,
  resumeSessionId?: string,
  runnerId?: string
): Promise<CoderResult> {
  // Load configuration to get coder provider settings
  // Project config overrides global config
  const config = loadConfig(projectPath);
  const coderConfig = config.ai?.coder;

  const providerName = coderConfig?.provider;
  const modelName = coderConfig?.model;

  if (!providerName || !modelName) {
    throw new Error(
      'Coder AI provider not configured. Run "steroids config ai coder" to configure.'
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
  const promptContent = require('fs').readFileSync(promptFile, 'utf-8');

  const result = await logInvocation(
    promptContent,
    (ctx) =>
      provider.invoke(promptContent, {
        model: modelName,
        timeout: timeoutMs,
        cwd: projectPath ?? process.cwd(),
        promptFile,
        role: 'coder',
        streamOutput: true,
        onActivity: ctx?.onActivity,
        resumeSessionId,
      }),
    {
      role: 'coder',
      provider: providerName,
      model: modelName,
      taskId,
      projectPath,
      resumedFromSessionId: resumeSessionId ?? undefined,
      invocationMode: resumeSessionId ? 'resume' : 'fresh',
      runnerId,
    }
  );

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration: result.duration,
    timedOut: result.timedOut,
  };
}

/**
 * Invoke coder for a task
 * @param coordinatorGuidance Optional guidance from coordinator after repeated rejections
 */
export async function invokeCoder(
  task: Task,
  projectPath: string,
  action: 'start' | 'resume',
  coordinatorGuidance?: string,
  runnerId?: string
): Promise<CoderResult> {
  // Load config to show provider/model being used
  const config = loadConfig(projectPath);
  const coderConfig = config.ai?.coder;

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

  // Fetch rejection history so coder can see past attempts
  let rejectionHistory: ReturnType<typeof getTaskRejections> = [];
  let resumeSessionId: string | null = null;
  try {
    const { db, close } = openDatabase(projectPath);
    rejectionHistory = getTaskRejections(db, task.id);
    if (rejectionHistory.length > 0) {
      console.log(`Found ${rejectionHistory.length} previous rejection(s) - coder will see full history`);
    }

    // Check for resumable session (same provider/model/role)
    const coderConfig = config.ai?.coder;
    if (coderConfig?.provider && coderConfig?.model) {
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

    close();
  } catch (error) {
    console.warn('Could not fetch rejection history or session info:', error);
  }

  const context: CoderPromptContext = {
    task,
    projectPath,
    previousStatus: task.status,
    rejectionHistory,
    coordinatorGuidance,
  };

  let prompt: string;

  if (resumeSessionId) {
    // Session reuse: send delta prompt only
    prompt = generateResumingCoderDeltaPrompt(context);
  } else if (action === 'resume') {
    // No session reuse, but work was partially done: send full resuming prompt
    context.gitStatus = getGitStatus(projectPath);
    context.gitDiff = getGitDiff(projectPath);
    prompt = generateResumingCoderPrompt(context);
  } else {
    // New task: send full coder prompt
    prompt = generateCoderPrompt(context);
  }

  // Write prompt to temp file
  const promptFile = writePromptToTempFile(prompt);

  try {
    let result: CoderResult;
    let sessionNotFound = false;
    try {
      result = await invokeProvider(promptFile, 900_000, task.id, projectPath, resumeSessionId ?? undefined, runnerId);
    } catch (err: any) {
      if (err instanceof SessionNotFoundError) {
        console.warn(`Session not found for resume (${resumeSessionId?.substring(0, 8)}) — invalidating session and retrying fresh`);
        sessionNotFound = true;
        result = { success: false, exitCode: 1, stdout: '', stderr: '', duration: 0, timedOut: false };
      } else {
        throw err;
      }
    }

    // If session resume failed because session was not found, retry fresh with Token Guard
    if (resumeSessionId && sessionNotFound) {
      const providerName = coderConfig?.provider ?? 'unknown';
      const modelName = coderConfig?.model ?? 'unknown';
      let guardedPrompt = '';
      
      const { getTokenLimitForModel } = await import('../providers/registry.js');
      const { getTaskInvocationsBySession } = await import('../database/queries.js');

      const maxContextWindow = await getTokenLimitForModel(providerName, modelName);
      const reservedHeadroom = 8000;
      const safeLimit = maxContextWindow - reservedHeadroom;

      try {
        const { db, close } = openDatabase(projectPath);

        // Base system prompt and task specification
        const baseContext = { ...context, rejectionHistory: [] };
        const basePrompt = generateCoderPrompt(baseContext);
        const systemPromptSize = countTokens(basePrompt, modelName);
        
        if (systemPromptSize > safeLimit) {
          close();
          throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit (${systemPromptSize} > ${safeLimit} tokens). Task cannot be processed.`);
        }

        const invocations = getTaskInvocationsBySession(db, task.id, resumeSessionId);
        
        // Reconstruct history
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
         // fallback to normal fresh if DB fails
         guardedPrompt = generateCoderPrompt(context);
         if (countTokens(guardedPrompt, modelName) > safeLimit) {
            throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit. Task cannot be processed.`);
         }
      }

      // Generate guarded fresh prompt and retry
      const freshPromptFile = writePromptToTempFile(guardedPrompt);
      try {
        result = await invokeProvider(freshPromptFile, 900_000, task.id, projectPath, undefined, runnerId);
      } finally {
        if (existsSync(freshPromptFile)) unlinkSync(freshPromptFile);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`CODER COMPLETED`);
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
 * Invoke coder for a batch of tasks
 */
export async function invokeCoderBatch(
  tasks: Task[],
  sectionName: string,
  projectPath: string
): Promise<BatchCoderResult> {
  // Load config to show provider/model being used
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
  const promptFile = writePromptToTempFile(prompt);

  try {
    // Longer timeout for batch: base 30 minutes + 5 minutes per task
    const timeoutMs = 30 * 60 * 1000 + tasks.length * 5 * 60 * 1000;
    const result = await invokeProvider(promptFile, timeoutMs, undefined, projectPath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`BATCH CODER COMPLETED`);
    console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
    console.log(`${'='.repeat(60)}\n`);

    return { ...result, taskCount: tasks.length };
  } finally {
    if (existsSync(promptFile)) {
      unlinkSync(promptFile);
    }
  }
}
