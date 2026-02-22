/**
 * Per-workstream commit processing
 */

import {
  getCommitShortSha,
  getWorkstreamCommitList,
  hasCherryPickInProgress,
  runGitCommand,
} from './merge-git.js';
import {
  clearProgressEntry,
  getMergeProgressForWorkstream,
  upsertProgressEntry,
  MergeProgressRow,
} from './merge-progress.js';
import { runConflictResolutionCycle } from './merge-conflict.js';
import { isAppliedCommitIntegrated } from './merge-commit-checks.js';
import { refreshMergeLock } from './merge-lock.js';
import { openDatabase } from '../database/connection.js';

interface MergeWorkstreamSpec {
  id: string;
  branchName: string;
}

export async function processWorkstream(
  db: ReturnType<typeof openDatabase>['db'],
  projectPath: string,
  sessionId: string,
  workstream: MergeWorkstreamSpec,
  mainBranch: string,
  remote: string,
  progressRows: MergeProgressRow[],
  heartbeat: { sessionId: string; runnerId: string; timeoutMinutes: number; lockEpoch: number }
): Promise<{ applied: number; skipped: number; conflicts: number }> {
  const summary = { applied: 0, skipped: 0, conflicts: 0 };
  const commits = getWorkstreamCommitList(projectPath, remote, workstream.branchName, mainBranch);

  if (commits.length === 0) {
    return summary;
  }

  const workstreamProgress = getMergeProgressForWorkstream(progressRows, workstream.id);
  const workstreamLookup = new Map<number, MergeProgressRow>();
  for (const row of workstreamProgress) {
    workstreamLookup.set(row.position, row);
  }

  for (let position = 0; position < commits.length; position += 1) {
    const commitSha = commits[position];
    const shortSha = getCommitShortSha(commitSha);
    const prior = workstreamLookup.get(position);

    if (prior?.status === 'applied' && prior.commit_sha === commitSha) {
      if (isAppliedCommitIntegrated(projectPath, prior.applied_commit_sha)) {
        summary.applied += 1;
        continue;
      }

      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    if (prior?.status === 'skipped' && prior.commit_sha === commitSha) {
      summary.skipped += 1;
      continue;
    }

    if (prior?.status === 'conflict' && prior.commit_sha === commitSha) {
      if (hasCherryPickInProgress(projectPath)) {
        const outcome = await runConflictResolutionCycle({
          db,
          projectPath,
          sessionId,
          workstreamId: workstream.id,
          runnerId: heartbeat.runnerId,
          mergeLockHeartbeat: {
            lockEpoch: heartbeat.lockEpoch,
            timeoutMinutes: heartbeat.timeoutMinutes,
          },
          branchName: workstream.branchName,
          position,
          commitSha,
          existingTaskId: prior.conflict_task_id ?? undefined,
        });

        if (outcome === 'skipped') summary.skipped += 1;
        else summary.applied += 1;
        summary.conflicts += 1;
        continue;
      }

      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    if (prior && prior.commit_sha !== commitSha) {
      clearProgressEntry(db, sessionId, workstream.id, position);
    }

    try {
      runGitCommand(projectPath, ['cherry-pick', commitSha]);
      const appliedCommitSha = runGitCommand(projectPath, ['rev-parse', 'HEAD']).trim();
      upsertProgressEntry(
        db,
        sessionId,
        workstream.id,
        position,
        commitSha,
        'applied',
        null,
        appliedCommitSha
      );
      summary.applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CONFLICT|merge conflict|could not apply|needs merge/i.test(message)) {
        throw error;
      }

      const outcome = await runConflictResolutionCycle({
        db,
        projectPath,
        sessionId,
        workstreamId: workstream.id,
        runnerId: heartbeat.runnerId,
        mergeLockHeartbeat: {
          lockEpoch: heartbeat.lockEpoch,
          timeoutMinutes: heartbeat.timeoutMinutes,
        },
        branchName: workstream.branchName,
        position,
        commitSha,
      });

      if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.applied += 1;
      }

      summary.conflicts += 1;
    }

    refreshMergeLock(
      db,
      heartbeat.sessionId,
      heartbeat.runnerId,
      heartbeat.timeoutMinutes,
      heartbeat.lockEpoch
    );
  }

  return summary;
}
