import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { SessionNotFoundError } from '../providers/interface.js';

export interface BaseRunnerResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}

export abstract class BaseRunner {
  protected writePromptToTempFile(prompt: string, prefix: string): string {
    const tempPath = join(tmpdir(), `steroids-${prefix}-${Date.now()}.txt`);
    writeFileSync(tempPath, prompt, 'utf-8');
    return tempPath;
  }

  protected async invokeProvider(
    promptFile: string,
    role: 'coder' | 'reviewer' | 'orchestrator',
    providerName: string,
    modelName: string,
    timeoutMs: number,
    taskId?: string,
    projectPath?: string,
    resumeSessionId?: string,
    runnerId?: string
  ): Promise<BaseRunnerResult> {
    const registry = await getProviderRegistry();
    const provider = registry.get(providerName);

    if (!(await provider.isAvailable())) {
      throw new Error(
        `Provider '${providerName}' is not available. Ensure the CLI is installed and in PATH.`
      );
    }

    const promptContent = readFileSync(promptFile, 'utf-8');

    const result = await logInvocation(
      promptContent,
      (ctx) =>
        provider.invoke(promptContent, {
          model: modelName,
          timeout: timeoutMs,
          cwd: projectPath ?? process.cwd(),
          promptFile,
          role: role as 'coder' | 'reviewer',
          streamOutput: true,
          onActivity: ctx?.onActivity,
          resumeSessionId,
        }),
      {
        role: role as 'coder' | 'reviewer' | 'orchestrator',
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

  protected cleanupTempFile(promptFile: string) {
    if (existsSync(promptFile)) {
      unlinkSync(promptFile);
    }
  }
}