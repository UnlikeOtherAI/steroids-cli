import { randomUUID } from 'node:crypto';
import { updateTaskStatus } from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import {
  getSubmissionDurableRef,
  readDurableSubmissionRef,
  writeDurableSubmissionRef,
  deleteDurableSubmissionRef,
} from '../git/submission-durability.js';

export function submitForReviewWithDurableRef(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  actor: string,
  projectPath: string,
  commitSha: string,
  notes: string
): { ok: true } | { ok: false; error: string } {
  const latestSubmission = db
    .prepare(
      `SELECT metadata
       FROM audit
       WHERE task_id = ?
       AND to_status = 'review'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(taskId) as { metadata: string | null } | undefined;
  const previousDurable = readDurableSubmissionRef(projectPath, taskId);
  let previousSequence = 0;
  if (latestSubmission?.metadata) {
    try {
      const parsed = JSON.parse(latestSubmission.metadata) as { submission_sequence?: number };
      previousSequence = parsed.submission_sequence ?? 0;
    } catch {
      previousSequence = 0;
    }
  }
  const nextSequence = previousSequence + 1;
  const invocationToken = randomUUID();
  const durableRef = getSubmissionDurableRef(taskId);

  const refWrite = writeDurableSubmissionRef(
    projectPath,
    taskId,
    commitSha,
    previousDurable?.sha ?? null
  );
  if (!refWrite.ok) {
    return { ok: false, error: refWrite.error };
  }

  const writeTransition = db.transaction(() => {
    updateTaskStatus(db, taskId, 'review', actor, notes, commitSha);
    const metadata = JSON.stringify({
      submission_sequence: nextSequence,
      durable_ref: durableRef,
      durable_ref_sha: commitSha,
      invocation_token: invocationToken,
    });
    db.prepare(
      `UPDATE audit
       SET metadata = ?
       WHERE id = (
         SELECT id FROM audit
         WHERE task_id = ?
           AND to_status = 'review'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )`
    ).run(metadata, taskId);
  });

  try {
    writeTransition();
    return { ok: true };
  } catch (error) {
    if (previousDurable?.sha) {
      void writeDurableSubmissionRef(projectPath, taskId, previousDurable.sha, commitSha);
    } else {
      deleteDurableSubmissionRef(projectPath, taskId);
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
