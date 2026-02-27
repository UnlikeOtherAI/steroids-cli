/**
 * Coder phase decision helpers
 * Extracted from loop-phases-coder.ts to keep that file under 500 lines.
 */

import { execSync } from 'node:child_process';
import {
  getTask,
  getTaskRejections,
  getLatestSubmissionNotes,
  getLatestMustImplementGuidance,
  listTasks,
  addAuditEntry,
  updateTaskStatus,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import {
  invokeCoordinator,
  type CoordinatorContext,
  type CoordinatorResult,
} from '../orchestrator/coordinator.js';
import {
  getCurrentCommitSha,
  getModifiedFiles,
  isCommitReachable,
} from '../git/status.js';
import { pushToRemote } from '../git/push.js';
import {
  LeaseFenceContext,
  refreshParallelWorkstreamLease,
  resolveCoderSubmittedCommitSha,
  summarizeErrorMessage,
} from './loop-phases-helpers.js';

// ─── Coordinator invocation ───────────────────────────────────────────────────

export async function invokeCoordinatorIfNeeded(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  projectPath: string,
  effectiveProjectPath: string,
  coordinatorCache?: Map<string, CoordinatorResult>,
  coordinatorThresholds?: number[],
  jsonMode = false
): Promise<string | undefined> {
  let coordinatorGuidance: string | undefined;
  const thresholds = coordinatorThresholds || [2, 5, 9];
  const persistedMustImplement = getLatestMustImplementGuidance(db, task!.id);
  const activeMustImplement =
    persistedMustImplement &&
    task!.status === 'in_progress' &&
    task!.rejection_count >= persistedMustImplement.rejection_count_watermark
      ? persistedMustImplement
      : null;

  // Run coordinator at rejection thresholds (same as before)
  const shouldInvokeCoordinator = thresholds.includes(task!.rejection_count);
  const cachedResult = coordinatorCache?.get(task!.id);

  if (activeMustImplement) {
    coordinatorGuidance = activeMustImplement.guidance;
    coordinatorCache?.set(task!.id, {
      success: true,
      decision: 'guide_coder',
      guidance: activeMustImplement.guidance,
    });
    if (!jsonMode) {
      console.log(`\nActive MUST_IMPLEMENT override detected (rc=${activeMustImplement.rejection_count_watermark})`);
    }
  }

  if (shouldInvokeCoordinator) {
    if (
      activeMustImplement &&
      task!.rejection_count === activeMustImplement.rejection_count_watermark
    ) {
      if (!jsonMode) {
        console.log('\nSkipping coordinator reinvocation in same rejection cycle due to active MUST_IMPLEMENT override');
      }
    } else {
      if (!jsonMode) {
        console.log(`\n>>> Task has ${task!.rejection_count} rejections (threshold hit) - invoking COORDINATOR...\n`);
      }

      try {
        const rejectionHistory = getTaskRejections(db, task!.id);
        const coordExtra: CoordinatorContext = {};

        if (task!.section_id) {
          const allSectionTasks = listTasks(db, { sectionId: task!.section_id });
          coordExtra.sectionTasks = allSectionTasks.map(t => ({
            id: t.id, title: t.title, status: t.status,
          }));
        }

        coordExtra.submissionNotes = getLatestSubmissionNotes(db, task!.id);

        const modified = getModifiedFiles(effectiveProjectPath);
        if (modified.length > 0) {
          coordExtra.gitDiffSummary = modified.join('\n');
        }

        if (cachedResult) {
          coordExtra.previousGuidance = cachedResult.guidance;
        }
        if (activeMustImplement) {
          coordExtra.lockedMustImplementGuidance = activeMustImplement.guidance;
          coordExtra.lockedMustImplementWatermark = activeMustImplement.rejection_count_watermark;
        }

        const coordResult = await invokeCoordinator(task!, rejectionHistory, projectPath, coordExtra);
        if (coordResult) {
          const mustKeepOverride =
            activeMustImplement &&
            task!.rejection_count > activeMustImplement.rejection_count_watermark;
          const normalizedGuidance =
            mustKeepOverride && !coordResult.guidance.includes('MUST_IMPLEMENT:')
              ? `${activeMustImplement!.guidance}\n\nAdditional coordinator guidance:\n${coordResult.guidance}`
              : coordResult.guidance;

          coordinatorGuidance = normalizedGuidance;
          coordinatorCache?.set(task!.id, {
            ...coordResult,
            guidance: normalizedGuidance,
          });

          addAuditEntry(db, task!.id, task!.status, task!.status, 'coordinator', {
            actorType: 'orchestrator',
            notes: `[${coordResult.decision}] ${normalizedGuidance}`,
          });

          // Persist coordinator guidance so it survives process restarts.
          // Fresh coder sessions can't rely on the in-memory coordinatorCache,
          // so we write a must_implement entry that getLatestMustImplementGuidance
          // can retrieve. Only persist for guide_coder — override_reviewer and
          // narrow_scope are handled elsewhere.
          if (coordResult.decision === 'guide_coder') {
            addAuditEntry(db, task!.id, task!.status, task!.status, 'coordinator', {
              actorType: 'orchestrator',
              notes: normalizedGuidance,
              category: 'must_implement',
              metadata: { rejection_count: task!.rejection_count },
            });
          }

          if (!jsonMode) {
            console.log(`\nCoordinator decision: ${coordResult.decision}`);
            console.log('Coordinator guidance stored for both coder and reviewer.');
          }
        }
      } catch (error) {
        if (!jsonMode) {
          console.warn('Coordinator invocation failed, continuing without guidance:', error);
        }
      }
    }
  } else if (cachedResult && !activeMustImplement) {
    coordinatorGuidance = cachedResult.guidance;
    if (!jsonMode && task!.rejection_count >= 2) {
      console.log(`\nReusing cached coordinator guidance (decision: ${cachedResult.decision})`);
    }
  }

  return coordinatorGuidance;
}

// ─── Decision execution ───────────────────────────────────────────────────────

export interface CoderExecutionContext {
  coderStdout: string;
  has_uncommitted: boolean;
  requiresExplicitSubmissionCommit: boolean;
  effectiveProjectPath: string;
  projectPath: string;
  branchName: string;
  leaseFence?: LeaseFenceContext;
  jsonMode: boolean;
}

export interface CoderDecision {
  action: 'submit' | 'stage_commit_submit' | 'retry' | 'error';
  reasoning: string;
  confidence?: string;
  commit_message?: string;
}

export async function executeCoderDecision(
  db: ReturnType<typeof openDatabase>['db'],
  task: ReturnType<typeof getTask>,
  decision: CoderDecision,
  ctx: CoderExecutionContext
): Promise<void> {
  const {
    coderStdout, has_uncommitted, requiresExplicitSubmissionCommit,
    effectiveProjectPath, projectPath, branchName, leaseFence, jsonMode,
  } = ctx;

  switch (decision.action) {
    case 'submit':
      {
        const submissionCommitSha = resolveCoderSubmittedCommitSha(effectiveProjectPath, coderStdout, {
          requireExplicitToken: requiresExplicitSubmissionCommit,
        });
        if (!submissionCommitSha && requiresExplicitSubmissionCommit) {
          addAuditEntry(db, task!.id, task!.status, task!.status, 'orchestrator', {
            actorType: 'orchestrator',
            notes: '[retry] Awaiting explicit SUBMISSION_COMMIT token for commit recovery',
          });
          if (!jsonMode) {
            console.log('\n⟳ Waiting for explicit SUBMISSION_COMMIT token from coder');
          }
          break;
        }
        if (!submissionCommitSha || !isCommitReachable(effectiveProjectPath, submissionCommitSha)) {
          updateTaskStatus(
            db,
            task!.id,
            'failed',
            'orchestrator',
            'Task failed: cannot submit to review without a valid commit hash'
          );
          if (!jsonMode) {
            console.log('\n✗ Task failed (submission commit missing or not in workspace)');
          }
          break;
        }
        if (leaseFence?.parallelSessionId) {
          const pushResult = pushToRemote(projectPath, 'origin', branchName);
          if (!pushResult.success) {
            updateTaskStatus(
              db,
              task!.id,
              'failed',
              'orchestrator',
              `Task failed: cannot publish submission commit ${submissionCommitSha} to ${branchName} before review`
            );
            if (!jsonMode) {
              console.log('\n✗ Task failed (unable to push submission commit to branch for review)');
            }
            break;
          }
        }
        updateTaskStatus(db, task!.id, 'review', 'orchestrator', decision.reasoning, submissionCommitSha);
      }
      if (!jsonMode) {
        console.log(`\n✓ Coder complete, submitted to review (confidence: ${decision.confidence})`);
      }
      break;

    case 'stage_commit_submit':
      if (!has_uncommitted) {
        const submissionCommitSha = resolveCoderSubmittedCommitSha(effectiveProjectPath, coderStdout, {
          requireExplicitToken: requiresExplicitSubmissionCommit,
        });
        if (!submissionCommitSha && requiresExplicitSubmissionCommit) {
          addAuditEntry(db, task!.id, task!.status, task!.status, 'orchestrator', {
            actorType: 'orchestrator',
            notes: '[retry] Awaiting explicit SUBMISSION_COMMIT token for commit recovery',
          });
          if (!jsonMode) {
            console.log('\n⟳ Waiting for explicit SUBMISSION_COMMIT token from coder');
          }
          break;
        }
        if (!submissionCommitSha || !isCommitReachable(effectiveProjectPath, submissionCommitSha)) {
          updateTaskStatus(
            db,
            task!.id,
            'failed',
            'orchestrator',
            'Task failed: cannot submit to review without a valid commit hash'
          );
          if (!jsonMode) {
            console.log('\n✗ Task failed (submission commit missing or not in workspace)');
          }
          break;
        }
        if (leaseFence?.parallelSessionId) {
          const pushResult = pushToRemote(projectPath, 'origin', branchName);
          if (!pushResult.success) {
            updateTaskStatus(
              db,
              task!.id,
              'failed',
              'orchestrator',
              `Task failed: cannot publish submission commit ${submissionCommitSha} to ${branchName} before review`
            );
            if (!jsonMode) {
              console.log('\n✗ Task failed (unable to push submission commit to branch for review)');
            }
            break;
          }
        }
        updateTaskStatus(
          db,
          task!.id,
          'review',
          'orchestrator',
          'Auto-commit skipped: no uncommitted changes',
          submissionCommitSha
        );
        if (!jsonMode) {
          console.log('\n✓ Auto-commit skipped (no uncommitted files) and submitted to review');
        }
        break;
      }

      if (!refreshParallelWorkstreamLease(projectPath, leaseFence)) {
        if (!jsonMode) {
          console.log('\n↺ Lease ownership lost before auto-commit; skipping task in this runner.');
        }
        return;
      }
      // Stage all changes
      try {
        execSync('git add -A', { cwd: effectiveProjectPath, stdio: 'pipe' });
        const message = decision.commit_message || 'feat: implement task specification';
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
          cwd: effectiveProjectPath,
          stdio: 'pipe'
        });
        const submissionCommitSha = getCurrentCommitSha(effectiveProjectPath) || undefined;
        if (!submissionCommitSha || !isCommitReachable(effectiveProjectPath, submissionCommitSha)) {
          updateTaskStatus(
            db,
            task!.id,
            'failed',
            'orchestrator',
            'Task failed: auto-committed but commit hash is not in current workspace'
          );
          if (!jsonMode) {
            console.log('\n✗ Task failed (auto-commit hash not in workspace)');
          }
          break;
        }
        if (leaseFence?.parallelSessionId) {
          const pushResult = pushToRemote(projectPath, 'origin', branchName);
          if (!pushResult.success) {
            updateTaskStatus(
              db,
              task!.id,
              'failed',
              'orchestrator',
              `Task failed: cannot publish submission commit ${submissionCommitSha} to ${branchName} before review`
            );
            if (!jsonMode) {
              console.log('\n✗ Task failed (unable to push submission commit to branch for review)');
            }
            break;
          }
        }
        updateTaskStatus(
          db,
          task!.id,
          'review',
          'orchestrator',
          `Auto-committed and submitted (${decision.reasoning})`,
          submissionCommitSha
        );
        if (!jsonMode) {
          console.log(`\n✓ Auto-committed and submitted to review (confidence: ${decision.confidence})`);
        }
      } catch (error) {
        const failureReason = summarizeErrorMessage(error);
        updateTaskStatus(
          db,
          task!.id,
          'failed',
          'orchestrator',
          `Task failed: auto-commit step failed before review (${failureReason})`
        );
        if (!jsonMode) {
          console.log('\n✗ Task failed (auto-commit step failed before review)');
        }
      }
      break;

    case 'retry':
      if (!jsonMode) {
        console.log(`\n⟳ Retrying coder (${decision.reasoning}, confidence: ${decision.confidence})`);
      }
      break;

    case 'error':
      updateTaskStatus(db, task!.id, 'failed', 'orchestrator',
        `Task failed: ${decision.reasoning}`);
      if (!jsonMode) {
        console.log(`\n✗ Task failed (${decision.reasoning})`);
        console.log('Human intervention required.');
      }
      break;
  }
}
