import { pruneResponseOutputs, countTokens } from '../utils/tokens.js';
import { getTaskInvocationsBySession } from '../database/queries.js';
import { withDatabase } from '../database/connection.js';

export class HistoryManager {
  /**
   * Fetch invocations with explicit retry logic for SQLITE_BUSY
   */
  public static fetchInvocationsWithRetry(
    projectPath: string, 
    taskId: string, 
    resumeSessionId: string,
    maxRetries = 3
  ) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return withDatabase(projectPath, (db) => 
          getTaskInvocationsBySession(db, taskId, resumeSessionId)
        );
      } catch (error: any) {
        if (error.code === 'SQLITE_BUSY' && attempt < maxRetries - 1) {
          attempt++;
          // Basic exponential backoff: 50ms, 100ms, ...
          const delay = Math.pow(2, attempt) * 25;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Reconstruct session history and apply Token Guard pruning to fit within context limits.
   * Throws an error if the base prompt alone exceeds the safe limit.
   */
  public static reconstructHistoryWithTokenGuard(
    projectPath: string,
    taskId: string,
    resumeSessionId: string,
    basePrompt: string,
    modelName: string,
    safeLimit: number
  ): { finalPrompt: string; finalHistoryText: string } {
    const systemPromptSize = countTokens(basePrompt, modelName);
    
    if (systemPromptSize > safeLimit) {
      throw new Error(`Context Too Large: System Prompt and Task Spec alone exceed safe context limit (${systemPromptSize} > ${safeLimit} tokens). Task cannot be processed.`);
    }

    const invocations = HistoryManager.fetchInvocationsWithRetry(projectPath, taskId, resumeSessionId);
    
    const buildHistory = (invs: typeof invocations, pruneOlder: boolean) => {
      let hist = '';
      for (let i = 0; i < invs.length; i++) {
        const inv = invs[i];
        // Skip the base prompt of the session (always first in DB for this session)
        const isOriginalFirst = inv.id === invocations[0].id;
        
        if (inv.prompt && !isOriginalFirst) {
           hist += `

--- USER CONTINUATION ---
${inv.prompt}`;
        }
        if (inv.response) {
           const isOlder = i < invs.length - 1;
           const responseText = (pruneOlder && isOlder) ? pruneResponseOutputs(inv.response) : inv.response;
           hist += `

--- ASSISTANT RESPONSE ---
${responseText}`;
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

    return { 
      finalPrompt: basePrompt + finalHistoryText,
      finalHistoryText
    };
  }
}
