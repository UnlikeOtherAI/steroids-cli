/**
 * Batch mode processing for the orchestrator loop.
 * Handles processing multiple pending tasks at once within a section.
 */

import Database from 'better-sqlite3';
import { getTask, getSection, incrementTaskFailureCount, updateTaskStatus } from '../database/queries.js';
import { selectTaskBatch, markTaskInProgress } from '../orchestrator/task-selector.js';
import { invokeCoderBatch } from '../orchestrator/coder.js';
import { loadConfig } from '../config/loader.js';
import { invokeReviewerBatch } from '../orchestrator/reviewer.js';
import { logActivity } from './activity-log.js';
import { execFileSync } from 'node:child_process';
import { handleCreditExhaustion, checkBatchCreditExhaustion } from './credit-pause.js';
import { pushToRemote } from '../git/push.js';
import type { LoopOptions } from './orchestrator-loop.js';

interface BatchContext {
  db: Database.Database;
  projectPath: string;
  branchName: string;
  options: LoopOptions;
  once: boolean;
  refreshLease: () => boolean;
  ensureSteroids: () => void;
}

export type BatchResult = 'continue' | 'break' | 'not_applicable';

export async function runBatchIteration(ctx: BatchContext, maxBatchSize: number): Promise<BatchResult> {
  const { db, projectPath, branchName, options } = ctx;

  const batch = selectTaskBatch(db, maxBatchSize);
  if (!batch || batch.tasks.length === 0) {
    return 'not_applicable';
  }

  console.log(`[BATCH MODE] Section "${batch.sectionName}" - ${batch.tasks.length} tasks`);

  if (!ctx.refreshLease()) {
    console.log('Lease ownership lost during batch processing; stopping loop.');
    return 'break';
  }
  for (const task of batch.tasks) {
    markTaskInProgress(db, task.id);
    options.onTaskStart?.(task.id, 'batch');
  }

  // Invoke batch coder
  ctx.ensureSteroids();
  console.log('\n>>> Invoking BATCH CODER...\n');
  const batchCoderResult = await invokeCoderBatch(batch.tasks, batch.sectionName, projectPath);

  const coderCreditAlert = await checkBatchCreditExhaustion(batchCoderResult, 'coder', projectPath);
  if (coderCreditAlert) {
    const pauseResult = await handleCreditExhaustion({
      ...coderCreditAlert,
      projectPath,
      runnerId: options.runnerId ?? 'daemon',
      db,
      shouldStop: options.shouldStop ?? (() => false),
      onHeartbeat: options.onHeartbeat,
      onceMode: options.once ?? false,
    });
    return pauseResult.resolved ? 'continue' : 'break';
  }

  if (batchCoderResult.timedOut || !batchCoderResult.success) {
    const coderConfig = loadConfig(projectPath).ai?.coder;
    handleBatchProviderFailure(db, batch.tasks, 'coder',
      coderConfig?.provider ?? 'unknown', coderConfig?.model ?? 'unknown',
      batchCoderResult.exitCode ?? 1, (batchCoderResult.stderr || batchCoderResult.stdout || '').trim());

    const batchHasWork = batch.tasks.some((task) => {
      const current = getTask(db, task.id);
      return !!current && current.status === 'pending';
    });
    return batchHasWork ? 'continue' : 'break';
  }

  // Check which tasks are now in review status
  const tasksInReview = batch.tasks
    .map(t => getTask(db, t.id))
    .filter((t): t is NonNullable<typeof t> => t !== null && t.status === 'review');

  if (tasksInReview.length > 0) {
    console.log(`\n[BATCH MODE] ${tasksInReview.length} tasks ready for batch review\n`);

    ctx.ensureSteroids();
    console.log('\n>>> Invoking BATCH REVIEWER...\n');
    const batchReviewerResult = await invokeReviewerBatch(tasksInReview, batch.sectionName, projectPath);

    const reviewerCreditAlert = await checkBatchCreditExhaustion(batchReviewerResult, 'reviewer', projectPath);
    if (reviewerCreditAlert) {
      const pauseResult = await handleCreditExhaustion({
        ...reviewerCreditAlert,
        projectPath,
        runnerId: options.runnerId ?? 'daemon',
        db,
        shouldStop: options.shouldStop ?? (() => false),
        onHeartbeat: options.onHeartbeat,
        onceMode: options.once ?? false,
      });
      return pauseResult.resolved ? 'continue' : 'break';
    }

    if (batchReviewerResult.timedOut || !batchReviewerResult.success) {
      const reviewerConfig = loadConfig(projectPath).ai?.reviewer;
      handleBatchProviderFailure(db, tasksInReview, 'reviewer',
        reviewerConfig?.provider ?? 'unknown', reviewerConfig?.model ?? 'unknown',
        batchReviewerResult.exitCode ?? 1, (batchReviewerResult.stderr || batchReviewerResult.stdout || '').trim());

      const batchHasWork = tasksInReview.some((task) => {
        const current = getTask(db, task.id);
        return !!current && current.status === 'pending';
      });
      return batchHasWork ? 'continue' : 'break';
    }

    // Log activity for each reviewed task
    logBatchResults(db, tasksInReview, projectPath, options.runnerId);

    // Push changes after batch review if any tasks were approved
    const approvedTasks = tasksInReview.filter(t => {
      const updated = getTask(db, t.id);
      return updated?.status === 'completed';
    });

    if (approvedTasks.length > 0) {
      if (!ctx.refreshLease()) {
        console.log('Lease ownership lost before batch push; skipping remaining work in this runner.');
        return 'break';
      }
      const pushResult = pushToRemote(projectPath, 'origin', branchName);
      if (pushResult.success) {
        console.log('Pushing batch changes to git...');
        console.log(`Pushed ${approvedTasks.length} approved task(s)`);
      } else {
        console.warn('Failed to push batch changes:', pushResult.error);
      }
    }
  }

  for (const task of batch.tasks) {
    options.onTaskComplete?.(task.id);
  }

  if (ctx.once) {
    console.log('\n[--once] Stopping after one batch');
    return 'break';
  }

  return 'continue';
}

function logBatchResults(
  db: Database.Database,
  tasks: Array<{ id: string; title: string; section_id: string | null }>,
  projectPath: string,
  runnerId: string | undefined
): void {
  if (!runnerId) return;

  for (const task of tasks) {
    const updatedTask = getTask(db, task.id);
    if (!updatedTask) continue;

    const terminalStatuses = ['completed', 'failed', 'disputed', 'skipped'] as const;
    if (!terminalStatuses.includes(updatedTask.status as typeof terminalStatuses[number])) continue;

    const section = task.section_id ? getSection(db, task.section_id) : null;
    let commitMessage: string | null = null;
    if (updatedTask.status === 'completed') {
      try {
        commitMessage = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: projectPath, encoding: 'utf-8' }).trim();
      } catch { /* ignore */ }
    }

    logActivity(projectPath, runnerId, task.id, task.title, section?.name ?? null,
      updatedTask.status as 'completed' | 'failed' | 'disputed' | 'skipped', commitMessage);
  }
}

function handleBatchProviderFailure(
  db: Database.Database,
  tasks: Array<{ id: string }>,
  role: 'coder' | 'reviewer',
  provider: string,
  model: string,
  exitCode: number,
  output: string
): void {
  for (const task of tasks) {
    const failureCount = incrementTaskFailureCount(db, task.id);
    const sanitizedOutput = output || 'provider invocation failed with no output.';
    const message = `Task ${task.id}: provider ${provider}/${model} exited with non-zero status ${exitCode} during ${role} phase: ${sanitizedOutput}`;

    if (failureCount >= 3) {
      updateTaskStatus(db, task.id, 'failed', 'orchestrator', `${message} (provider invocation failed ${failureCount} time(s). Task failed.)`);
      console.log(`\n✗ Task failed (${message})`);
    } else {
      updateTaskStatus(db, task.id, 'pending', 'orchestrator', `${message} (attempt ${failureCount}/3, retrying)`);
    }
  }
}
