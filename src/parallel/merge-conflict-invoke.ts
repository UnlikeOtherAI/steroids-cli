import { loadConfig } from '../config/loader.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { getProviderRegistry } from '../providers/registry.js';
import { ParallelMergeError } from './merge-errors.js';

export async function invokeMergeConflictModel(
  role: 'coder' | 'reviewer',
  projectPath: string,
  taskId: string | undefined,
  prompt: string
): Promise<string> {
  const config = loadConfig(projectPath);
  const modelConfig = role === 'coder' ? config.ai?.coder : config.ai?.reviewer;

  if (!modelConfig?.provider || !modelConfig?.model) {
    throw new ParallelMergeError(
      `Missing AI ${role} configuration. Configure via config.ai.${role}.`,
      'AI_CONFIG_MISSING'
    );
  }

  const providerName = modelConfig.provider;
  const model = modelConfig.model;

  const registry = getProviderRegistry();
  const provider = registry.get(providerName);
  const result = await logInvocation(
    prompt,
    (ctx) =>
      provider.invoke(prompt, {
        model,
        timeout: 60 * 60 * 1000,
        cwd: projectPath,
        role,
        streamOutput: false,
        onActivity: ctx?.onActivity,
      }),
    {
      role,
      provider: providerName,
      model,
      taskId,
      projectPath,
    }
  );

  if (!result.success) {
    const details = result.stderr || result.stdout || 'model returned non-zero exit code';
    throw new ParallelMergeError(
      `${role.toUpperCase()} invocation failed during merge conflict handling: ${details}`,
      'AI_INVOCATION_FAILED'
    );
  }

  if (result.timedOut) {
    throw new ParallelMergeError(`${role} invocation timed out`, 'AI_INVOKE_TIMEOUT');
  }

  return result.stdout;
}
