/**
 * Workstream sealing before cherry-pick merge
 */

import { getWorkstreamCommitList, runGitCommand } from './merge-git.js';
import { assertMergeLockEpoch } from './merge-lock.js';
import { openDatabase } from '../database/connection.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import { ParallelMergeError } from './merge-errors.js';

interface MergeWorkstreamSpec {
  id: string;
  branchName: string;
}

function resolveGitSha(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (/fatal:|error:/i.test(trimmed)) return null;
  return trimmed.split('\n').at(-1)?.trim() ?? null;
}

export function sealWorkstreamsForMerge(
  mergeDb: ReturnType<typeof openDatabase>['db'],
  sessionId: string,
  runnerId: string,
  lockEpoch: number,
  mergePath: string,
  remote: string,
  mainBranch: string,
  workstreams: MergeWorkstreamSpec[]
): void {
  const { db, close } = openGlobalDatabase();
  try {
    const sealedEntries: Array<{
      streamId: string;
      sealedBaseSha: string;
      sealedHeadSha: string;
      commits: string[];
      completionOrder: number;
    }> = [];

    assertMergeLockEpoch(mergeDb, sessionId, runnerId, lockEpoch);

    for (let index = 0; index < workstreams.length; index += 1) {
      assertMergeLockEpoch(mergeDb, sessionId, runnerId, lockEpoch);
      const stream = workstreams[index];
      const commits = getWorkstreamCommitList(mergePath, remote, stream.branchName, mainBranch);
      const sealedHeadSha = resolveGitSha(
        runGitCommand(mergePath, ['rev-parse', `${remote}/${stream.branchName}`], { allowFailure: true })
      );
      const sealedBaseSha = resolveGitSha(
        runGitCommand(mergePath, ['merge-base', `${remote}/${mainBranch}`, `${remote}/${stream.branchName}`], { allowFailure: true })
      );

      if (!sealedHeadSha || !sealedBaseSha) {
        throw new ParallelMergeError(
          `Could not resolve sealed merge SHAs for ${remote}/${stream.branchName}`,
          'REMOTE_BRANCH_MISSING'
        );
      }

      sealedEntries.push({
        streamId: stream.id,
        sealedBaseSha,
        sealedHeadSha,
        commits,
        completionOrder: index + 1,
      });
    }

    const applySealedUpdates = db.transaction(() => {
      for (const entry of sealedEntries) {
        const update = db.prepare(
          `UPDATE workstreams
           SET sealed_base_sha = ?,
               sealed_head_sha = ?,
               sealed_commit_shas = ?,
               completion_order = COALESCE(completion_order, ?),
               completed_at = COALESCE(completed_at, datetime('now')),
               status = 'completed'
           WHERE session_id = ?
             AND id = ?
             AND status IN ('running', 'completed')`
        ).run(
          entry.sealedBaseSha,
          entry.sealedHeadSha,
          JSON.stringify(entry.commits),
          entry.completionOrder,
          sessionId,
          entry.streamId
        );

        if (update.changes !== 1) {
          throw new ParallelMergeError(
            `Workstream lease check failed while sealing ${entry.streamId}`,
            'LEASE_FENCE_FAILED'
          );
        }
      }
    });

    applySealedUpdates();
  } finally {
    close();
  }
}
