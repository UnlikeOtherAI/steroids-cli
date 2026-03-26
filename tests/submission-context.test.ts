import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { createTask } from '../src/database/queries.js';
import { loadSubmissionContext } from '../src/orchestrator/submission-context.js';

describe('loadSubmissionContext', () => {
  let db: Database.Database;
  let projectPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-submission-context-'));
  });

  afterEach(() => {
    db.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('scopes notes and no-op state to the latest active task lifecycle', () => {
    const task = createTask(db, 'Task 1', { status: 'review' });

    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, created_at)
       VALUES (?, 'pending', 'in_progress', 'orchestrator', 'attempt 1', '2026-03-26T10:00:00Z')`
    ).run(task.id);
    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, commit_sha, created_at)
       VALUES (?, 'in_progress', 'review', 'orchestrator', ?, 'old-sha', '2026-03-26T10:01:00Z')`
    ).run(task.id, '[NO_OP_SUBMISSION] old lifecycle');

    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, created_at)
       VALUES (?, 'pending', 'in_progress', 'orchestrator', 'attempt 2', '2026-03-26T11:00:00Z')`
    ).run(task.id);
    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, commit_sha, created_at)
       VALUES (?, 'in_progress', 'review', 'orchestrator', ?, 'new-sha', '2026-03-26T11:01:00Z')`
    ).run(task.id, 'fresh submission');

    const context = loadSubmissionContext(db, projectPath, task.id);

    expect(context.latestReviewNotes).toBe('fresh submission');
    expect(context.isNoOp).toBe(false);
    expect(context.approvalCandidateShas).toEqual(['new-sha']);
    expect(context.latestExpectedSha).toBe('new-sha');
  });

  it('breaks same-timestamp review ties by audit id', () => {
    const task = createTask(db, 'Task 1', { status: 'review' });

    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, created_at)
       VALUES (?, 'pending', 'in_progress', 'orchestrator', 'attempt', '2026-03-26T10:00:00Z')`
    ).run(task.id);
    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, commit_sha, created_at)
       VALUES (?, 'in_progress', 'review', 'orchestrator', 'first', 'first-sha', '2026-03-26T10:01:00Z')`
    ).run(task.id);
    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, notes, commit_sha, created_at)
       VALUES (?, 'in_progress', 'review', 'orchestrator', 'second', 'second-sha', '2026-03-26T10:01:00Z')`
    ).run(task.id);

    const context = loadSubmissionContext(db, projectPath, task.id);

    expect(context.latestReviewNotes).toBe('second');
    expect(context.latestReviewCommitSha).toBe('second-sha');
    expect(context.approvalCandidateShas[0]).toBe('second-sha');
  });
});
