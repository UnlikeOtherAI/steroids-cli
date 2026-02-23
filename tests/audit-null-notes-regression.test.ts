import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { addAuditEntry, approveTask, createTask, getTask } from '../src/database/queries.js';

describe('audit null notes regression', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('accepts null options in addAuditEntry legacy path', () => {
    const task = createTask(db, 'null options regression task', { status: 'in_progress' });

    expect(() => {
      addAuditEntry(
        db,
        task.id,
        'in_progress',
        'review',
        'orchestrator',
        null as unknown as string
      );
    }).not.toThrow();

    const latest = db.prepare(
      `SELECT to_status, actor, actor_type, notes
       FROM audit
       WHERE task_id = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(task.id) as { to_status: string; actor: string; actor_type: string; notes: string | null };

    expect(latest.to_status).toBe('review');
    expect(latest.actor).toBe('orchestrator');
    expect(latest.actor_type).toBe('human');
    expect(latest.notes).toBeNull();
  });

  it('does not crash approveTask when reviewer notes are null', () => {
    const task = createTask(db, 'approve null notes task', { status: 'review' });

    expect(() => {
      approveTask(
        db,
        task.id,
        'orchestrator',
        null as unknown as string,
        '34b632dc9412a651bab5504923529fe5776a3796'
      );
    }).not.toThrow();

    const updated = getTask(db, task.id);
    expect(updated?.status).toBe('completed');

    const latest = db.prepare(
      `SELECT to_status, actor, notes, commit_sha
       FROM audit
       WHERE task_id = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(task.id) as { to_status: string; actor: string; notes: string | null; commit_sha: string | null };

    expect(latest.to_status).toBe('completed');
    expect(latest.actor).toBe('model:orchestrator');
    expect(latest.notes).toBeNull();
    expect(latest.commit_sha).toBe('34b632dc9412a651bab5504923529fe5776a3796');
  });
});
