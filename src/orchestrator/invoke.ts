/**
 * Orchestrator invocation functions
 * Calls the orchestrator LLM to analyze output and make decisions
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { buildPostCoderPrompt } from './post-coder.js';
import { buildPostReviewerPrompt } from './post-reviewer.js';
import type { CoderContext, ReviewerContext } from './types.js';

/**
 * Invoke post-coder orchestrator to analyze coder output
 */
export async function invokeCoderOrchestrator(
  context: CoderContext,
  projectPath: string = process.cwd()
): Promise<string> {
  const prompt = buildPostCoderPrompt(context);
  return await invokeOrchestrator(prompt, 'orchestrator', projectPath, context.task.id);
}

/**
 * Invoke post-reviewer orchestrator to analyze reviewer output
 */
export async function invokeReviewerOrchestrator(
  context: ReviewerContext,
  projectPath: string = process.cwd()
): Promise<string> {
  const prompt = buildPostReviewerPrompt(context);
  return await invokeOrchestrator(prompt, 'orchestrator', projectPath, context.task.id);
}

/**
 * Generic orchestrator invocation
 */
async function invokeOrchestrator(
  prompt: string,
  role: 'orchestrator',
  projectPath: string,
  taskId: string
): Promise<string> {
  // Load configuration to get orchestrator provider settings
  const config = loadConfig(projectPath);
  const orchestratorConfig = config.ai?.orchestrator;

  const providerName = orchestratorConfig?.provider;
  const modelName = orchestratorConfig?.model;

  if (!providerName || !modelName) {
    throw new Error(
      'Orchestrator AI provider not configured. Run "steroids config ai orchestrator" to configure.'
    );
  }

  // Get the provider from registry
  const registry = getProviderRegistry();
  const provider = registry.get(providerName);

  // Check if provider is available
  if (!(await provider.isAvailable())) {
    throw new Error(
      `Provider '${providerName}' is not available. ` +
      `Ensure the CLI is installed and in PATH.`
    );
  }

  // Write prompt to temp file
  const promptFile = join(tmpdir(), `steroids-orchestrator-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  try {
    const result = await logInvocation(
      prompt,
      (ctx) =>
        provider.invoke(prompt, {
          model: modelName,
          timeout: 30_000,
          cwd: projectPath,
          promptFile,
          role,
          streamOutput: false, // Don't stream orchestrator output
          onActivity: ctx?.onActivity,
        }),
      {
        role,
        provider: providerName,
        model: modelName,
        taskId,
        projectPath,
      }
    );

    return result.stdout;
  } finally {
    // Cleanup temp file
    try {
      unlinkSync(promptFile);
    } catch {}
  }
}
