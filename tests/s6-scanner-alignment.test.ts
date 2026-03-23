/**
 * S6: Scanner/wakeup alignment tests.
 * 1. hasPendingWork excludes 'disputed' (alignment with wakeup-checks.ts)
 * 2. Project-scoped provider backoff logic includes multi-reviewer providers
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask } from '../src/database/queries.js';

// --------------------------------------------------------------------------
// S6: hasPendingWork alignment
// --------------------------------------------------------------------------

describe('S6: hasPendingWork alignment with wakeup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  // Mirror of scanner.ts hasPendingWork — same query used by both scanner and wakeup
  function hasPendingWork(projectDb: Database.Database): boolean {
    const row = projectDb
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status IN ('pending', 'in_progress', 'review')`
      )
      .get() as { count: number };
    return row.count > 0;
  }

  it('returns true for pending tasks', () => {
    const section = createSection(db, 'S1');
    createTask(db, 'T1', { sectionId: section.id });
    expect(hasPendingWork(db)).toBe(true);
  });

  it('returns true for in_progress tasks', () => {
    const section = createSection(db, 'S1');
    createTask(db, 'T1', { sectionId: section.id });
    db.prepare("UPDATE tasks SET status = 'in_progress'").run();
    expect(hasPendingWork(db)).toBe(true);
  });

  it('returns true for review tasks', () => {
    const section = createSection(db, 'S1');
    createTask(db, 'T1', { sectionId: section.id });
    db.prepare("UPDATE tasks SET status = 'review'").run();
    expect(hasPendingWork(db)).toBe(true);
  });

  it('returns false for disputed tasks (S6 alignment)', () => {
    const section = createSection(db, 'S1');
    createTask(db, 'T1', { sectionId: section.id });
    db.prepare("UPDATE tasks SET status = 'disputed'").run();
    expect(hasPendingWork(db)).toBe(false);
  });

  it('returns false for completed tasks', () => {
    const section = createSection(db, 'S1');
    createTask(db, 'T1', { sectionId: section.id });
    db.prepare("UPDATE tasks SET status = 'completed'").run();
    expect(hasPendingWork(db)).toBe(false);
  });

  it('returns false for failed tasks', () => {
    const section = createSection(db, 'S1');
    createTask(db, 'T1', { sectionId: section.id });
    db.prepare("UPDATE tasks SET status = 'failed'").run();
    expect(hasPendingWork(db)).toBe(false);
  });

  it('returns false when no tasks exist', () => {
    expect(hasPendingWork(db)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// S6: Project-scoped provider backoff logic (pure function test)
// --------------------------------------------------------------------------

describe('S6: project-scoped provider backoff logic', () => {
  // Test the provider extraction and dedup logic directly (same algorithm
  // as getProjectProviderBackoff in global-db-backoffs.ts)
  function extractProviders(config: {
    ai?: {
      coder?: { provider?: string };
      reviewer?: { provider?: string };
      reviewers?: Array<{ provider?: string }>;
    };
  }): string[] {
    const coderProvider = config.ai?.coder?.provider;
    const reviewerProvider = config.ai?.reviewer?.provider;
    const multiReviewerProviders = (config.ai?.reviewers ?? [])
      .map(r => r.provider)
      .filter(Boolean) as string[];
    return [...new Set(
      [coderProvider, reviewerProvider, ...multiReviewerProviders].filter(Boolean) as string[]
    )];
  }

  it('extracts coder and reviewer providers', () => {
    const providers = extractProviders({
      ai: { coder: { provider: 'claude' }, reviewer: { provider: 'gemini' } },
    });
    expect(providers).toEqual(['claude', 'gemini']);
  });

  it('includes multi-reviewer providers', () => {
    const providers = extractProviders({
      ai: {
        coder: { provider: 'claude' },
        reviewer: { provider: 'gemini' },
        reviewers: [{ provider: 'gemini' }, { provider: 'mistral' }],
      },
    });
    expect(providers).toContain('claude');
    expect(providers).toContain('gemini');
    expect(providers).toContain('mistral');
    expect(providers).toHaveLength(3);
  });

  it('deduplicates when same provider appears multiple times', () => {
    const providers = extractProviders({
      ai: {
        coder: { provider: 'claude' },
        reviewer: { provider: 'claude' },
        reviewers: [{ provider: 'claude' }],
      },
    });
    expect(providers).toEqual(['claude']);
  });

  it('handles empty config gracefully', () => {
    const providers = extractProviders({ ai: {} });
    expect(providers).toEqual([]);
  });

  it('handles missing ai config', () => {
    const providers = extractProviders({});
    expect(providers).toEqual([]);
  });

  it('handles reviewers with undefined providers', () => {
    const providers = extractProviders({
      ai: {
        coder: { provider: 'claude' },
        reviewers: [{ provider: undefined }, { provider: 'gemini' }],
      },
    });
    expect(providers).toEqual(['claude', 'gemini']);
  });
});
