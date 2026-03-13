import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask } from '../src/database/queries.js';
import {
  getIntakePollState,
  getIntakeReport,
  linkIntakeReportToTask,
  listIntakeReports,
  upsertIntakePollState,
  upsertIntakeReport,
} from '../src/database/intake-queries.js';
import type { IntakeReport } from '../src/intake/types.js';

function createSampleReport(overrides: Partial<IntakeReport> = {}): IntakeReport {
  return {
    source: 'github',
    externalId: '42',
    url: 'https://github.com/acme/widgets/issues/42',
    fingerprint: 'github:acme/widgets#42',
    title: 'Checkout fails on empty cart',
    summary: 'Stack trace attached',
    severity: 'high',
    status: 'open',
    createdAt: '2026-03-10T10:00:00Z',
    updatedAt: '2026-03-10T11:00:00Z',
    tags: ['bug', 'checkout'],
    payload: { body: 'Stack trace attached' },
    ...overrides,
  };
}

describe('intake database queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a new intake report and reads it back', () => {
    const stored = upsertIntakeReport(db, createSampleReport());

    expect(stored.source).toBe('github');
    expect(stored.externalId).toBe('42');
    expect(stored.tags).toEqual(['bug', 'checkout']);
    expect(stored.linkedTaskId).toBeNull();

    const fetched = getIntakeReport(db, 'github', '42');
    expect(fetched?.id).toBe(stored.id);
    expect(fetched?.payload).toEqual({ body: 'Stack trace attached' });
  });

  it('deduplicates by source and external id while preserving first_seen_at and explicit links', () => {
    const section = createSection(db, 'Intake');
    const task = createTask(db, 'Fix checkout', { sectionId: section.id });

    const first = upsertIntakeReport(db, createSampleReport(), { linkedTaskId: task.id });
    const second = upsertIntakeReport(
      db,
      createSampleReport({
        title: 'Checkout fails intermittently',
        status: 'triaged',
        updatedAt: '2026-03-10T12:00:00Z',
      })
    );

    expect(second.id).toBe(first.id);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.linkedTaskId).toBe(task.id);
    expect(second.title).toBe('Checkout fails intermittently');
    expect(second.status).toBe('triaged');
    expect(listIntakeReports(db)).toHaveLength(1);
  });

  it('supports deterministic filters for source, severity, status, and linked task presence', () => {
    const section = createSection(db, 'Intake');
    const task = createTask(db, 'Investigate issue', { sectionId: section.id });

    upsertIntakeReport(
      db,
      createSampleReport({
        externalId: '100',
        fingerprint: 'github:acme/widgets#100',
        severity: 'medium',
        updatedAt: '2026-03-10T11:00:00Z',
      })
    );
    upsertIntakeReport(
      db,
      createSampleReport({
        externalId: '101',
        fingerprint: 'github:acme/widgets#101',
        severity: 'critical',
        status: 'triaged',
        updatedAt: '2026-03-10T13:00:00Z',
      }),
      { linkedTaskId: task.id }
    );
    upsertIntakeReport(
      db,
      createSampleReport({
        source: 'github',
        externalId: '102',
        fingerprint: 'github:acme/widgets#102',
        severity: 'critical',
        status: 'open',
        updatedAt: '2026-03-10T13:00:00Z',
      })
    );

    expect(listIntakeReports(db, { severity: 'critical' }).map((row) => row.externalId)).toEqual(['101', '102']);
    expect(listIntakeReports(db, { status: 'triaged' }).map((row) => row.externalId)).toEqual(['101']);
    expect(listIntakeReports(db, { hasLinkedTask: true }).map((row) => row.externalId)).toEqual(['101']);
    expect(listIntakeReports(db, { hasLinkedTask: false }).map((row) => row.externalId)).toEqual(['102', '100']);
    expect(listIntakeReports(db, { linkedTaskId: task.id }).map((row) => row.externalId)).toEqual(['101']);
    expect(listIntakeReports(db, { limit: 2 }).map((row) => row.externalId)).toEqual(['101', '102']);
  });

  it('updates linked task ids and clears them when the parent task is deleted', () => {
    const taskId = 'intake-linked-task';
    db.prepare(
      `INSERT INTO tasks (id, title, status, section_id, source_file, file_path, file_line, file_commit_sha, file_content_hash, start_commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(taskId, 'Link task', 'pending', null, null, null, null, null, null, null);

    upsertIntakeReport(db, createSampleReport());
    expect(linkIntakeReportToTask(db, 'github', '42', taskId)).toBe(true);
    expect(getIntakeReport(db, 'github', '42')?.linkedTaskId).toBe(taskId);

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    expect(getIntakeReport(db, 'github', '42')?.linkedTaskId).toBeNull();
  });

  it('stores poll state and preserves the last successful cursor on failure-only updates', () => {
    const first = upsertIntakePollState(db, {
      source: 'github',
      cursor: 'cursor-1',
      lastPolledAt: '2026-03-10T11:00:00Z',
      lastSuccessAt: '2026-03-10T11:00:00Z',
    });

    expect(first.cursor).toBe('cursor-1');

    const second = upsertIntakePollState(db, {
      source: 'github',
      lastPolledAt: '2026-03-10T12:00:00Z',
      lastErrorAt: '2026-03-10T12:00:00Z',
      lastErrorMessage: 'rate limited',
    });

    expect(second.cursor).toBe('cursor-1');
    expect(second.lastSuccessAt).toBe('2026-03-10T11:00:00Z');
    expect(second.lastErrorMessage).toBe('rate limited');
    expect(getIntakePollState(db, 'github')?.cursor).toBe('cursor-1');
  });

  it('returns null for missing poll state and rejects invalid list limits', () => {
    expect(getIntakePollState(db, 'github')).toBeNull();
    expect(() => listIntakeReports(db, { limit: 0 })).toThrow('Intake report limit must be a positive integer, got: 0');
  });
});
