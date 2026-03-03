import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import {
  createTask,
  getSubmissionCommitShas,
  updateTaskStatus,
} from '../src/database/queries.js';

describe('getSubmissionCommitShas', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('limits commit history to the latest pending->in_progress lifecycle', () => {
    const task = createTask(db, 'Submission lifecycle test');

    // First lifecycle submissions (should be ignored after reset).
    updateTaskStatus(db, task.id, 'in_progress', 'orchestrator');
    updateTaskStatus(db, task.id, 'review', 'orchestrator', undefined, 'old-1');
    updateTaskStatus(db, task.id, 'in_progress', 'model:orchestrator');
    updateTaskStatus(db, task.id, 'review', 'orchestrator', undefined, 'old-2');

    // Manual reset back to pending starts a new lifecycle.
    updateTaskStatus(db, task.id, 'pending', 'human:cli', 'reset');

    updateTaskStatus(db, task.id, 'in_progress', 'orchestrator');
    updateTaskStatus(db, task.id, 'review', 'orchestrator', undefined, 'new-1');
    updateTaskStatus(db, task.id, 'in_progress', 'model:orchestrator');
    updateTaskStatus(db, task.id, 'review', 'orchestrator', undefined, 'new-2');

    expect(getSubmissionCommitShas(db, task.id)).toEqual(['new-2', 'new-1']);
  });

  it('falls back to all review submissions when no boundary transition exists', () => {
    const task = createTask(db, 'No pending boundary', { status: 'review' });

    updateTaskStatus(db, task.id, 'review', 'orchestrator', undefined, 'sha-1');
    updateTaskStatus(db, task.id, 'in_progress', 'model:orchestrator');
    updateTaskStatus(db, task.id, 'review', 'orchestrator', undefined, 'sha-2');

    expect(getSubmissionCommitShas(db, task.id)).toEqual(['sha-2', 'sha-1']);
  });
});
