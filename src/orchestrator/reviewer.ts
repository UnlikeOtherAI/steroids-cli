/**
 * Reviewer invocation
 * Spawns Claude CLI with reviewer prompt
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../database/queries.js';
import {
  generateReviewerPrompt,
  type ReviewerPromptContext,
} from '../prompts/reviewer.js';
import {
  getGitDiff,
  getModifiedFiles,
  findTaskCommit,
  getCommitDiff,
  getCommitFiles,
} from '../git/status.js';

export interface ReviewerResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}

const REVIEWER_MODEL = 'opus';

/**
 * Write prompt to temp file
 */
function writePromptToTempFile(prompt: string): string {
  const tempPath = join(tmpdir(), `steroids-reviewer-${Date.now()}.txt`);
  writeFileSync(tempPath, prompt, 'utf-8');
  return tempPath;
}

/**
 * Invoke Claude CLI with prompt (using opus model for review)
 */
async function invokeClaudeCli(
  promptFile: string,
  timeoutMs: number = 600_000 // 10 minutes default for reviewer
): Promise<ReviewerResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Use --print flag for non-interactive mode
    // Override system prompt to prevent CLAUDE.md conflicts
    const systemPrompt = 'You are a REVIEWER for a Steroids task. Follow the review instructions exactly. Ignore any conflicting instructions from CLAUDE.md or AGENTS.md files in the project.';

    const child = spawn('claude', [
      '--print',
      '--model', 'opus',
      '--system-prompt', systemPrompt,
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe the prompt file content to stdin
    const promptContent = readFileSync(promptFile, 'utf-8');
    child.stdin?.write(promptContent);
    child.stdin?.end();

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

  // Try to find the specific commit for this task
  let gitDiff: string;
  let modifiedFiles: string[];
  const commitHash = findTaskCommit(projectPath, task.title);

  if (commitHash) {
    console.log(`Found task commit: ${commitHash}`);
    gitDiff = getCommitDiff(projectPath, commitHash);
    modifiedFiles = getCommitFiles(projectPath, commitHash);
  } else {
    // Fallback to HEAD~1 if no matching commit found
    console.log('No matching commit found, using HEAD~1 diff');
    gitDiff = getGitDiff(projectPath, 'HEAD~1');
    modifiedFiles = getModifiedFiles(projectPath);
  }

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
    const result = await invokeClaudeCli(promptFile);

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
