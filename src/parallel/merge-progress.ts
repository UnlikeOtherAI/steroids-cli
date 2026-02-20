/**
 * Merge progress persistence for crash recovery.
 */

import type Database from 'better-sqlite3';

export interface MergeProgressRow {
  id: number;
  session_id: string;
  workstream_id: string;
  position: number;
  commit_sha: string;
  applied_commit_sha: string | null;
  status: 'applied' | 'conflict' | 'skipped';
  conflict_task_id: string | null;
  created_at: string;
  applied_at: string | null;
}

function getNowISOString(): string {
  return new Date().toISOString();
}

export function listMergeProgress(db: Database.Database, sessionId: string): MergeProgressRow[] {
  return db
    .prepare(
      `SELECT id, session_id, workstream_id, position, commit_sha, applied_commit_sha, status, conflict_task_id, created_at, applied_at
       FROM merge_progress
       WHERE session_id = ?
       ORDER BY workstream_id, position ASC`
    )
    .all(sessionId) as MergeProgressRow[];
}

export function clearProgressEntry(
  db: Database.Database,
  sessionId: string,
  workstreamId: string,
  position: number
): void {
  db.prepare(
    'DELETE FROM merge_progress WHERE session_id = ? AND workstream_id = ? AND position = ?'
  ).run(sessionId, workstreamId, position);
}

export function upsertProgressEntry(
  db: Database.Database,
  sessionId: string,
  workstreamId: string,
  position: number,
  commitSha: string,
  status: MergeProgressRow['status'],
  conflictTaskId: string | null = null,
  appliedCommitSha: string | null = null
): void {
  const payloadApplied = status === 'applied' ? getNowISOString() : null;
  const payloadAppliedCommit = status === 'applied' ? appliedCommitSha : null;

  clearProgressEntry(db, sessionId, workstreamId, position);
  db.prepare(
    `INSERT INTO merge_progress
      (session_id, workstream_id, position, commit_sha, applied_commit_sha, status, conflict_task_id, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    workstreamId,
    position,
    commitSha,
    payloadAppliedCommit,
    status,
    conflictTaskId,
    payloadApplied
  );
}

export function getMergeProgressForWorkstream(
  rows: MergeProgressRow[],
  workstreamId: string
): MergeProgressRow[] {
  return rows
    .filter((row) => row.workstream_id === workstreamId)
    .sort((left, right) => left.position - right.position);
}
