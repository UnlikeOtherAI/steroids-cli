/**
 * Reviewer invocation
 * Spawns Codex CLI with reviewer prompt
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import {
  generateReviewerPrompt,
  type ReviewerPromptContext,
} from '../prompts/reviewer.js';
import { getGitDiff, getModifiedFiles } from '../git/status.js';

export interface ReviewerResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}

const REVIEWER_MODEL = 'codex';

/**
 * Write prompt to temp file
 */
function writePromptToTempFile(prompt: string): string {
  const tempPath = join(tmpdir(), `steroids-reviewer-${Date.now()}.txt`);
  writeFileSync(tempPath, prompt, 'utf-8');
  return tempPath;
}

/**
 * Invoke Codex CLI with prompt
 */
async function invokeCodexCli(
  promptFile: string,
  timeoutMs: number = 600_000 // 10 minutes default for reviewer
): Promise<ReviewerResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Codex CLI invocation
    // Command must be a single string for shell substitution to work
    const command = `codex --prompt "$(cat ${promptFile})"`;
    const child = spawn(command, {
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
 * Invoke reviewer for a task
 */
export async function invokeReviewer(
  task: Task,
  projectPath: string
): Promise<ReviewerResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`REVIEWER: ${task.title}`);
  console.log(`Task ID: ${task.id}`);
  console.log(`Rejection count: ${task.rejection_count}/15`);
  console.log(`${'='.repeat(60)}\n`);

  // Get diff of changes for review
  const gitDiff = getGitDiff(projectPath, 'HEAD~1');
  const modifiedFiles = getModifiedFiles(projectPath);

  const context: ReviewerPromptContext = {
    task,
    projectPath,
    reviewerModel: REVIEWER_MODEL,
    gitDiff,
    modifiedFiles,
  };

  const prompt = generateReviewerPrompt(context);

  // Write prompt to temp file
  const promptFile = writePromptToTempFile(prompt);

  try {
    const result = await invokeCodexCli(promptFile);

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
