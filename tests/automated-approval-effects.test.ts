// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { addAuditEntry, createSection, createTask, getTask } from '../src/database/queries.js';

const mockTriggerTaskCompleted = jest.fn().mockResolvedValue([]);
const mockTriggerSectionCompleted = jest.fn().mockResolvedValue([]);
const mockTriggerProjectCompleted = jest.fn().mockResolvedValue([]);
const mockCheckSectionCompletionAndPR = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../src/hooks/integration.js', () => ({
  triggerTaskCompleted: mockTriggerTaskCompleted,
  triggerSectionCompleted: mockTriggerSectionCompleted,
  triggerProjectCompleted: mockTriggerProjectCompleted,
}));

jest.unstable_mockModule('../src/git/section-pr.js', () => ({
  checkSectionCompletionAndPR: mockCheckSectionCompletionAndPR,
}));

const {
  completeTaskWithApprovalEffects,
  markApprovalEffectsPending,
  reconcilePendingApprovalEffects,
} = await import('../src/orchestrator/automated-approval-effects.js');

describe('automated approval effects', () => {
  let db: Database.Database;
  let projectPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec(`
      ALTER TABLE tasks ADD COLUMN merge_phase TEXT;
      ALTER TABLE tasks ADD COLUMN approved_sha TEXT;
      ALTER TABLE tasks ADD COLUMN rebase_attempts INTEGER DEFAULT 0;
    `);
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-approval-effects-'));
  });

  afterEach(() => {
    db.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('completes tasks through durable pending/applied markers and shared hooks', async () => {
    const section = createSection(db, 'Feature');
    const task = createTask(db, 'Task 1', { sectionId: section.id, status: 'review' });

    await completeTaskWithApprovalEffects(db, task, {
      actor: 'model:test-reviewer',
      notes: 'approved',
      commitSha: 'merge-sha',
      replayInput: { version: 1 },
      config: { git: { branch: 'main' } },
      projectPath,
    });

    const updated = getTask(db, task.id);
    expect(updated?.status).toBe('completed');

    const markers = db
      .prepare(
        `SELECT category
         FROM audit
         WHERE task_id = ?
           AND category IS NOT NULL
         ORDER BY id ASC`
      )
      .all(task.id) as Array<{ category: string }>;

    expect(markers.map((row) => row.category)).toEqual(
      expect.arrayContaining([
        'approval_effects_pending',
        'approval_effect_step_applied',
        'approval_effects_applied',
      ]),
    );
    expect(mockTriggerTaskCompleted).toHaveBeenCalledTimes(1);
    expect(mockTriggerSectionCompleted).toHaveBeenCalledTimes(1);
    expect(mockTriggerProjectCompleted).toHaveBeenCalledTimes(1);
    expect(mockCheckSectionCompletionAndPR).toHaveBeenCalledTimes(1);
  });

  it('replays pending approval effects without re-running already-applied hook steps', async () => {
    const section = createSection(db, 'Feature');
    const task = createTask(db, 'Task 1', { sectionId: section.id, status: 'completed' });

    markApprovalEffectsPending(db, task.id, 'orchestrator', { version: 1 });
    addAuditEntry(db, task.id, 'completed', 'completed', 'orchestrator', {
      actorType: 'orchestrator',
      category: 'approval_effect_step_applied',
      notes: '[approval_effects] Applied step: task_completed_hook',
      metadata: { step: 'task_completed_hook' },
    });

    const replayed = await reconcilePendingApprovalEffects(db, {
      config: { git: { branch: 'main' } },
      projectPath,
    });

    expect(replayed).toBe(1);
    expect(mockTriggerTaskCompleted).not.toHaveBeenCalled();
    expect(mockTriggerSectionCompleted).toHaveBeenCalledTimes(1);
    expect(mockTriggerProjectCompleted).toHaveBeenCalledTimes(1);

    const applied = db
      .prepare(
        `SELECT 1
         FROM audit
         WHERE task_id = ?
           AND category = 'approval_effects_applied'`
      )
      .get(task.id);
    expect(applied).toBeTruthy();
  });
});
