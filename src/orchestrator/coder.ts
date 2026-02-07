/**
 * Coder invocation
 * Spawns Claude CLI with coder prompt
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import {
  generateCoderPrompt,
  generateResumingCoderPrompt,
  type CoderPromptContext,
} from '../prompts/coder.js';
import { getGitStatus, getGitDiff } from '../git/status.js';

export interface CoderResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
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
 * Invoke Claude CLI with prompt
 */
async function invokeClaudeCli(
  promptFile: string,
  timeoutMs: number = 900_000 // 15 minutes default
): Promise<CoderResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Use -p flag for print mode with prompt from file
    const child = spawn('claude', ['-p', `$(cat ${promptFile})`, '--model', 'claude-sonnet-4'], {
      shell: true,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Print output in real-time
      process.stdout.write(text);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      resolve({
        success: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
        duration,
        timedOut,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      resolve({
        success: false,
        exitCode: 1,
        stdout,
        stderr: error.message,
        duration,
        timedOut: false,
      });
    });
  });
}

/**
 * Invoke coder for a task
 */
export async function invokeCoder(
  task: Task,
  projectPath: string,
  action: 'start' | 'resume'
): Promise<CoderResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CODER: ${task.title}`);
  console.log(`Action: ${action}`);
  console.log(`Task ID: ${task.id}`);
  console.log(`${'='.repeat(60)}\n`);

  const context: CoderPromptContext = {
    task,
    projectPath,
    previousStatus: task.status,
  };

  let prompt: string;

  if (action === 'resume') {
    // Get git status for resuming prompt
    context.gitStatus = getGitStatus(projectPath);
    context.gitDiff = getGitDiff(projectPath);
    prompt = generateResumingCoderPrompt(context);
  } else {
    prompt = generateCoderPrompt(context);
  }

  // Write prompt to temp file
  const promptFile = writePromptToTempFile(prompt);

  try {
    const result = await invokeClaudeCli(promptFile);

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
