import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask } from '../src/database/queries.js';
import { applyApprovedOutcome } from '../src/orchestrator/reviewer-approval-outcome.js';

describe('applyApprovedOutcome', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec(`
      ALTER TABLE tasks ADD COLUMN merge_phase TEXT;
      ALTER TABLE tasks ADD COLUMN approved_sha TEXT;
      ALTER TABLE tasks ADD COLUMN rebase_attempts INTEGER DEFAULT 0;
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('persists immutable replay metadata when queueing merge-approved tasks', async () => {
    const section = createSection(db, 'Feature');
    const task = createTask(db, 'Task 1', { sectionId: section.id, status: 'review' });

    await applyApprovedOutcome(
      db,
      task,
      { kind: 'queue_merge', approvedSha: 'approved-sha' },
      {
        actor: 'orchestrator',
        notes: 'Queued for merge',
        config: { git: { branch: 'main' } },
        projectPath: '/project',
        replayInput: { version: 1 },
      },
    );

    const row = db
      .prepare('SELECT status, merge_phase, approved_sha FROM tasks WHERE id = ?')
      .get(task.id) as { status: string; merge_phase: string | null; approved_sha: string | null };
    expect(row.status).toBe('merge_pending');
    expect(row.merge_phase).toBe('queued');
    expect(row.approved_sha).toBe('approved-sha');

    const audit = db
      .prepare(
        `SELECT metadata
         FROM audit
         WHERE task_id = ?
           AND to_status = 'merge_pending'
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(task.id) as { metadata: string | null };
    expect(JSON.parse(audit.metadata ?? '{}')).toEqual({
      approved_sha: 'approved-sha',
      approval_effects_replay: { version: 1 },
    });
  });
});
