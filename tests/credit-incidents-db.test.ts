/**
 * Direct DB unit tests for credit exhaustion incident query functions.
 *
 * Tests: insert, deduplication, listing, project-path filtering, resolution updates.
 */

import Database from 'better-sqlite3';
import {
  recordCreditIncident,
  getActiveCreditIncidents,
  resolveCreditIncident,
  type CreditExhaustionDetails,
} from '../src/database/queries.js';

function createProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE incidents (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      runner_id TEXT,
      failure_mode TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_incidents_unresolved ON incidents(resolved_at) WHERE resolved_at IS NULL;
  `);
  return db;
}

function createGlobalDb(runners: Array<{ id: string; project_path: string }>): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL
    );
  `);
  const stmt = db.prepare('INSERT INTO runners (id, project_path) VALUES (?, ?)');
  for (const r of runners) {
    stmt.run(r.id, r.project_path);
  }
  return db;
}

const baseDetails: CreditExhaustionDetails = {
  provider: 'claude',
  model: 'claude-sonnet-4',
  role: 'coder',
  message: 'Insufficient credits',
};

describe('Credit Exhaustion Incident DB Queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createProjectDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── Insert ──────────────────────────────────────────────────────────

  describe('recordCreditIncident', () => {
    it('inserts a new incident and returns its id', () => {
      const id = recordCreditIncident(db, baseDetails, 'runner-1', 'task-1');
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as any;
      expect(row).toBeTruthy();
      expect(row.failure_mode).toBe('credit_exhaustion');
      expect(row.runner_id).toBe('runner-1');
      expect(row.task_id).toBe('task-1');
      expect(row.resolved_at).toBeNull();

      const details = JSON.parse(row.details);
      expect(details.provider).toBe('claude');
      expect(details.model).toBe('claude-sonnet-4');
      expect(details.role).toBe('coder');
      expect(details.message).toBe('Insufficient credits');
    });

    it('works with nullable runnerId and taskId', () => {
      const id = recordCreditIncident(db, baseDetails);
      const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as any;
      expect(row.runner_id).toBeNull();
      expect(row.task_id).toBeNull();
    });
  });

  // ── Deduplication ───────────────────────────────────────────────────

  describe('deduplication', () => {
    it('returns existing id when unresolved incident matches runner+role+provider+model', () => {
      const id1 = recordCreditIncident(db, baseDetails, 'runner-1');
      const id2 = recordCreditIncident(db, baseDetails, 'runner-1');
      expect(id2).toBe(id1);

      const count = (db.prepare('SELECT COUNT(*) as c FROM incidents').get() as any).c;
      expect(count).toBe(1);
    });

    it('allows duplicate when runner differs', () => {
      const id1 = recordCreditIncident(db, baseDetails, 'runner-1');
      const id2 = recordCreditIncident(db, baseDetails, 'runner-2');
      expect(id2).not.toBe(id1);
    });

    it('allows duplicate when provider differs', () => {
      const id1 = recordCreditIncident(db, baseDetails, 'runner-1');
      const id2 = recordCreditIncident(db, { ...baseDetails, provider: 'openai' }, 'runner-1');
      expect(id2).not.toBe(id1);
    });

    it('allows duplicate when model differs', () => {
      const id1 = recordCreditIncident(db, baseDetails, 'runner-1');
      const id2 = recordCreditIncident(db, { ...baseDetails, model: 'gpt-4' }, 'runner-1');
      expect(id2).not.toBe(id1);
    });

    it('allows duplicate when role differs', () => {
      const id1 = recordCreditIncident(db, baseDetails, 'runner-1');
      const id2 = recordCreditIncident(db, { ...baseDetails, role: 'reviewer' }, 'runner-1');
      expect(id2).not.toBe(id1);
    });

    it('allows new insert after previous incident is resolved', () => {
      const id1 = recordCreditIncident(db, baseDetails, 'runner-1');
      resolveCreditIncident(db, id1, 'config_changed');

      const id2 = recordCreditIncident(db, baseDetails, 'runner-1');
      expect(id2).not.toBe(id1);

      const count = (db.prepare('SELECT COUNT(*) as c FROM incidents').get() as any).c;
      expect(count).toBe(2);
    });
  });

  // ── Listing ─────────────────────────────────────────────────────────

  describe('getActiveCreditIncidents', () => {
    it('returns all unresolved credit_exhaustion incidents', () => {
      recordCreditIncident(db, baseDetails, 'runner-1');
      recordCreditIncident(db, { ...baseDetails, role: 'reviewer' }, 'runner-2');

      const active = getActiveCreditIncidents(db);
      expect(active).toHaveLength(2);
      expect(active[0].provider).toBe('claude');
      expect(active[0].model).toBe('claude-sonnet-4');
    });

    it('excludes resolved incidents', () => {
      const id = recordCreditIncident(db, baseDetails, 'runner-1');
      resolveCreditIncident(db, id, 'dismissed');

      const active = getActiveCreditIncidents(db);
      expect(active).toHaveLength(0);
    });

    it('returns empty when no incidents exist', () => {
      const active = getActiveCreditIncidents(db);
      expect(active).toHaveLength(0);
    });
  });

  // ── Project-path filtering ──────────────────────────────────────────

  describe('getActiveCreditIncidents with project path filtering', () => {
    it('filters incidents by project path via runners table', () => {
      const globalDb = createGlobalDb([
        { id: 'runner-a', project_path: '/project/alpha' },
        { id: 'runner-b', project_path: '/project/beta' },
      ]);

      recordCreditIncident(db, baseDetails, 'runner-a');
      recordCreditIncident(db, { ...baseDetails, role: 'reviewer' }, 'runner-b');

      const alphaIncidents = getActiveCreditIncidents(db, '/project/alpha', globalDb);
      expect(alphaIncidents).toHaveLength(1);
      expect(alphaIncidents[0].role).toBe('coder');

      const betaIncidents = getActiveCreditIncidents(db, '/project/beta', globalDb);
      expect(betaIncidents).toHaveLength(1);
      expect(betaIncidents[0].role).toBe('reviewer');

      globalDb.close();
    });

    it('returns empty when no runners match the project path', () => {
      const globalDb = createGlobalDb([
        { id: 'runner-a', project_path: '/project/alpha' },
      ]);

      recordCreditIncident(db, baseDetails, 'runner-a');

      const result = getActiveCreditIncidents(db, '/project/nonexistent', globalDb);
      expect(result).toHaveLength(0);

      globalDb.close();
    });

    it('falls back to unfiltered when globalDb is omitted', () => {
      recordCreditIncident(db, baseDetails, 'runner-a');
      recordCreditIncident(db, { ...baseDetails, role: 'reviewer' }, 'runner-b');

      const result = getActiveCreditIncidents(db, '/project/alpha');
      expect(result).toHaveLength(2);
    });
  });

  // ── Resolution updates ──────────────────────────────────────────────

  describe('resolveCreditIncident', () => {
    it('sets resolved_at and resolution on the incident', () => {
      const id = recordCreditIncident(db, baseDetails, 'runner-1');

      resolveCreditIncident(db, id, 'config_changed');

      const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as any;
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolution).toBe('config_changed');
    });

    it('accepts all valid resolution values', () => {
      const resolutions = ['config_changed', 'dismissed', 'manual', 'retry'] as const;
      for (const resolution of resolutions) {
        const id = recordCreditIncident(
          db,
          { ...baseDetails, model: `model-${resolution}` },
          `runner-${resolution}`,
        );
        resolveCreditIncident(db, id, resolution);

        const row = db.prepare('SELECT resolution FROM incidents WHERE id = ?').get(id) as any;
        expect(row.resolution).toBe(resolution);
      }
    });

    it('resolved incident no longer appears in active list', () => {
      const id = recordCreditIncident(db, baseDetails, 'runner-1');
      expect(getActiveCreditIncidents(db)).toHaveLength(1);

      resolveCreditIncident(db, id, 'retry');
      expect(getActiveCreditIncidents(db)).toHaveLength(0);
    });
  });
});
