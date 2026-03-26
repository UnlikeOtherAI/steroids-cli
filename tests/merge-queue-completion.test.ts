// @ts-nocheck
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';

const mockBuildApprovalEffectsReplayInput = jest.fn();
const mockCompleteTaskWithApprovalEffects = jest.fn().mockResolvedValue(undefined);
const mockLoadQueuedApprovalEffectsReplayInput = jest.fn();

jest.unstable_mockModule('../src/orchestrator/automated-approval-effects.js', () => ({
  buildApprovalEffectsReplayInput: mockBuildApprovalEffectsReplayInput,
  completeTaskWithApprovalEffects: mockCompleteTaskWithApprovalEffects,
  loadQueuedApprovalEffectsReplayInput: mockLoadQueuedApprovalEffectsReplayInput,
}));

const { completeMergePendingTask } = await import('../src/orchestrator/merge-queue-completion.js');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      auto_pr INTEGER DEFAULT 0,
      branch TEXT,
      pr_number INTEGER,
      pr_labels TEXT,
      pr_draft INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'merge_pending',
      section_id TEXT,
      source_file TEXT,
      rejection_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      merge_failure_count INTEGER DEFAULT 0,
      last_failure_at TEXT,
      merge_phase TEXT,
      approved_sha TEXT,
      rebase_attempts INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT DEFAULT 'human',
      model TEXT,
      category TEXT,
      error_code TEXT,
      metadata TEXT,
      notes TEXT,
      commit_sha TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('completeMergePendingTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadQueuedApprovalEffectsReplayInput.mockReturnValue({ version: 1 });
  });

  it('routes merge completion through the shared completion-effects helper with queued replay input', async () => {
    const db = createTestDb();

    await completeMergePendingTask(
      db,
      {
        id: 't1',
        title: 'Task 1',
        source_file: 'docs/spec.md',
        section_id: 'section-1',
      },
      {
        config: { git: { branch: 'main' } },
        projectPath: '/project',
        intakeProjectPath: '/project',
        mergedSha: 'merged-sha',
        notes: '[merge_queue] Merge completed successfully',
      },
    );

    expect(mockLoadQueuedApprovalEffectsReplayInput).toHaveBeenCalledWith(db, 't1');
    expect(mockBuildApprovalEffectsReplayInput).not.toHaveBeenCalled();
    expect(mockCompleteTaskWithApprovalEffects).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 't1', section_id: 'section-1' }),
      expect.objectContaining({
        actor: 'orchestrator',
        projectPath: '/project',
        intakeProjectPath: '/project',
        commitSha: 'merged-sha',
        replayInput: { version: 1 },
      }),
    );
  });
});
