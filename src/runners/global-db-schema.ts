/**
 * Global database schema and migrations
 * Handles all SQL DDL and schema upgrade logic
 */

import Database from 'better-sqlite3';
import {
  GLOBAL_SCHEMA_V17_SQL,
  GLOBAL_SCHEMA_V18_SQL,
  GLOBAL_SCHEMA_V19_SQL,
  GLOBAL_SCHEMA_V20_SQL,
} from './global-db-schema-migrations-v17-v20.js';
import {
  GLOBAL_SCHEMA_V21_SQL,
  GLOBAL_SCHEMA_V22_SQL,
  GLOBAL_SCHEMA_V23_SQL,
  GLOBAL_SCHEMA_VERSION,
} from './global-db-schema-migrations-v21.js';

export {
  GLOBAL_SCHEMA_V17_SQL,
  GLOBAL_SCHEMA_V18_SQL,
  GLOBAL_SCHEMA_V19_SQL,
  GLOBAL_SCHEMA_V20_SQL,
} from './global-db-schema-migrations-v17-v20.js';
export {
  GLOBAL_SCHEMA_V21_SQL,
  GLOBAL_SCHEMA_V22_SQL,
  GLOBAL_SCHEMA_V23_SQL,
  GLOBAL_SCHEMA_VERSION,
} from './global-db-schema-migrations-v21.js';

/**
 * Schema for global database (runners and locks)
 */
export const GLOBAL_SCHEMA_SQL = `
-- Runners table for tracking runner state
CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    pid INTEGER,
    project_path TEXT,
    current_task_id TEXT,
    started_at TEXT,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Runner lock for singleton enforcement
-- Only one row allowed (id = 1)
CREATE TABLE IF NOT EXISTS runner_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schema metadata
CREATE TABLE IF NOT EXISTS _global_schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/**
 * Schema upgrade from version 1 to version 2: Add projects table
 */
export const GLOBAL_SCHEMA_V2_SQL = `
-- Projects table for tracking registered projects
CREATE TABLE IF NOT EXISTS projects (
    path TEXT PRIMARY KEY,
    name TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
);
`;

/**
 * Schema upgrade from version 2 to version 3: Add stats columns to projects table
 */
export const GLOBAL_SCHEMA_V3_SQL = `
-- Add task stats columns (for API/WebUI display without accessing project DBs)
ALTER TABLE projects ADD COLUMN pending_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN in_progress_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN review_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN completed_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN stats_updated_at TEXT;
`;

/**
 * Schema upgrade from version 3 to version 4: Add section_id to runners table
 */
export const GLOBAL_SCHEMA_V4_SQL = `
-- Add section_id column to runners for section focus feature
ALTER TABLE runners ADD COLUMN section_id TEXT;
`;

/**
 * Schema upgrade from version 4 to version 5: Add activity_log table
 */
export const GLOBAL_SCHEMA_V5_SQL = `
-- Activity log for tracking task completions across all projects
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_title TEXT NOT NULL,
    section_name TEXT,
    final_status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_project ON activity_log(project_path);
`;

/**
 * Schema upgrade from version 5 to version 6: Add commit_message to activity_log
 */
export const GLOBAL_SCHEMA_V6_SQL = `
-- Add commit_message column to activity_log for storing coder's final message
ALTER TABLE activity_log ADD COLUMN commit_message TEXT;
`;

/**
 * Schema upgrade from version 6 to version 7: Add commit_sha to activity_log
 */
export const GLOBAL_SCHEMA_V7_SQL = `
-- Add commit_sha column to activity_log for GitHub links
ALTER TABLE activity_log ADD COLUMN commit_sha TEXT;
`;

/**
 * Schema upgrade from version 7 to version 8: Add parallel session tracking
 */
export const GLOBAL_SCHEMA_V8_SQL = `
-- Parallel run sessions for independent workstreams
CREATE TABLE IF NOT EXISTS parallel_sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'running',
        'merging',
        'cleanup_pending',
        'cleanup_draining',
        'blocked_conflict',
        'blocked_recovery',
        'blocked_validation',
        'completed',
        'failed',
        'aborted'
      )
    ),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

-- Workstreams within a parallel session
CREATE TABLE IF NOT EXISTS workstreams (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES parallel_sessions(id),
    branch_name TEXT NOT NULL,
    section_ids TEXT NOT NULL,
    clone_path TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    runner_id TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Associate runners with a parallel session
ALTER TABLE runners ADD COLUMN parallel_session_id TEXT;
`;

/**
 * Schema upgrade from version 8 to version 9: add project_repo_id and active-session guards.
 */
export const GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL = `
CREATE INDEX IF NOT EXISTS idx_parallel_sessions_project_repo_id
ON parallel_sessions(project_repo_id);

CREATE TRIGGER IF NOT EXISTS trg_parallel_sessions_active_insert
BEFORE INSERT ON parallel_sessions
WHEN NEW.project_repo_id IS NOT NULL
  AND NEW.status NOT IN ('completed', 'failed', 'aborted')
BEGIN
  SELECT RAISE(ABORT, 'active parallel session already exists for project repo')
  WHERE EXISTS (
    SELECT 1
    FROM parallel_sessions
    WHERE project_repo_id = NEW.project_repo_id
      AND status NOT IN ('completed', 'failed', 'aborted')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_parallel_sessions_active_update
BEFORE UPDATE OF project_repo_id, status ON parallel_sessions
WHEN NEW.project_repo_id IS NOT NULL
  AND NEW.status NOT IN ('completed', 'failed', 'aborted')
BEGIN
  SELECT RAISE(ABORT, 'active parallel session already exists for project repo')
  WHERE EXISTS (
    SELECT 1
    FROM parallel_sessions
    WHERE project_repo_id = NEW.project_repo_id
      AND status NOT IN ('completed', 'failed', 'aborted')
      AND id != NEW.id
  );
END;
`;

/**
 * Schema upgrade from version 9 to version 10: add workstream lease fields.
 */
export const GLOBAL_SCHEMA_V10_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_session_status
ON workstreams(session_id, status);
`;

/**
 * Schema upgrade from version 10 to version 11: add sealed merge input fields.
 */
export const GLOBAL_SCHEMA_V11_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_completion_order
ON workstreams(session_id, completion_order);
`;

/**
 * Schema upgrade from version 11 to version 12: add reconciliation/backoff fields.
 */
export const GLOBAL_SCHEMA_V12_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_next_retry_at
ON workstreams(next_retry_at);
`;

/**
 * Schema upgrade from version 13 to version 14: add conflict attempt tracking.
 */
export const GLOBAL_SCHEMA_V14_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_conflict_attempts
ON workstreams(conflict_attempts);
`;

/**
 * Schema upgrade from version 14 to version 15: add validation escalation tracking.
 */
export const GLOBAL_SCHEMA_V15_SQL = `
CREATE TABLE IF NOT EXISTS validation_escalations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES parallel_sessions(id),
    project_path TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    validation_command TEXT NOT NULL,
    error_message TEXT NOT NULL,
    stdout_snippet TEXT,
    stderr_snippet TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_validation_escalations_session
ON validation_escalations(session_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_escalations_project
ON validation_escalations(project_path, status, created_at DESC);
`;

/**
 * Schema upgrade from version 15 to version 16: add provider backoff coordination.
 */
export const GLOBAL_SCHEMA_V16_SQL = `
  CREATE TABLE IF NOT EXISTS provider_backoffs (
    provider TEXT PRIMARY KEY,
    backoff_until_ms INTEGER NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    updated_at INTEGER NOT NULL
  );
`;

export function applyGlobalSchemaV19(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V19_SQL);
}

export function applyGlobalSchemaV20(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V20_SQL);
}

export function applyGlobalSchemaV21(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V21_SQL);
}

export function applyGlobalSchemaV23(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V23_SQL);
}

export function applyGlobalSchemaV22(db: Database.Database): void {
  // Only run column renames if old columns still exist (idempotent)
  if (hasColumn(db, 'monitor_config', 'investigator_agents')) {
    db.exec('ALTER TABLE monitor_config RENAME COLUMN investigator_agents TO first_responder_agents;');
    db.exec('ALTER TABLE monitor_config RENAME COLUMN investigation_timeout_seconds TO first_responder_timeout_seconds;');
  }
  if (hasColumn(db, 'monitor_runs', 'investigation_needed')) {
    db.exec('ALTER TABLE monitor_runs RENAME COLUMN investigation_needed TO first_responder_needed;');
    db.exec('ALTER TABLE monitor_runs RENAME COLUMN investigator_agent TO first_responder_agent;');
    db.exec('ALTER TABLE monitor_runs RENAME COLUMN investigator_actions TO first_responder_actions;');
    db.exec('ALTER TABLE monitor_runs RENAME COLUMN investigator_report TO first_responder_report;');
  }
  // Always create the remediation_attempts table (IF NOT EXISTS is safe)
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_remediation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      anomaly_fingerprint TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'attempted'
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_remediation_project ON monitor_remediation_attempts(project_path, anomaly_fingerprint);
  `);
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function supportsBlockedParallelSessionStatuses(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'parallel_sessions'")
    .get() as { sql?: string } | undefined;

  const sql = row?.sql ?? '';
  return (
    sql.includes('blocked_conflict') &&
    sql.includes('blocked_recovery') &&
    sql.includes('blocked_validation') &&
    sql.includes('aborted')
  );
}

export function applyGlobalSchemaV9(db: Database.Database): void {
  if (!hasColumn(db, 'parallel_sessions', 'project_repo_id')) {
    db.exec('ALTER TABLE parallel_sessions ADD COLUMN project_repo_id TEXT');
  }

  db.exec(
    "UPDATE parallel_sessions SET project_repo_id = project_path WHERE project_repo_id IS NULL"
  );
  db.exec(GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL);
}

export function applyGlobalSchemaV10(db: Database.Database): void {
  if (!hasColumn(db, 'workstreams', 'claim_generation')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0');
  }

  const leaseColumnMissing = !hasColumn(db, 'workstreams', 'lease_expires_at');
  if (leaseColumnMissing) {
    db.exec('ALTER TABLE workstreams ADD COLUMN lease_expires_at TEXT');
    // Backfill only during the one-time schema upgrade that introduces lease_expires_at.
    // Do NOT run this on every startup, or wakeup reconciliation cannot observe
    // intentionally NULL/expired leases for stale workstreams.
    db.exec(
      "UPDATE workstreams SET lease_expires_at = datetime('now', '+120 seconds') " +
      "WHERE lease_expires_at IS NULL AND status = 'running'"
    );
  }
  db.exec(GLOBAL_SCHEMA_V10_SQL);
}

export function applyGlobalSchemaV11(db: Database.Database): void {
  if (!hasColumn(db, 'workstreams', 'sealed_base_sha')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN sealed_base_sha TEXT');
  }

  if (!hasColumn(db, 'workstreams', 'sealed_head_sha')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN sealed_head_sha TEXT');
  }

  if (!hasColumn(db, 'workstreams', 'sealed_commit_shas')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN sealed_commit_shas TEXT');
  }

  if (!hasColumn(db, 'workstreams', 'completion_order')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN completion_order INTEGER');
  }

  db.exec(GLOBAL_SCHEMA_V11_SQL);
}

export function applyGlobalSchemaV12(db: Database.Database): void {
  if (!hasColumn(db, 'workstreams', 'recovery_attempts')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0');
  }

  if (!hasColumn(db, 'workstreams', 'next_retry_at')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN next_retry_at TEXT');
  }

  if (!hasColumn(db, 'workstreams', 'last_reconcile_action')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN last_reconcile_action TEXT');
  }

  if (!hasColumn(db, 'workstreams', 'last_reconciled_at')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN last_reconciled_at TEXT');
  }

  db.exec(GLOBAL_SCHEMA_V12_SQL);
}

export function applyGlobalSchemaV13(db: Database.Database): void {
  if (supportsBlockedParallelSessionStatuses(db)) {
    db.exec(GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL);
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TABLE IF EXISTS parallel_sessions_new');
      db.exec(`
        CREATE TABLE IF NOT EXISTS parallel_sessions_new (
            id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            project_repo_id TEXT,
            status TEXT NOT NULL CHECK (
              status IN (
                'running',
                'merging',
                'cleanup_pending',
                'cleanup_draining',
                'blocked_conflict',
                'blocked_recovery',
                'blocked_validation',
                'completed',
                'failed',
                'aborted'
              )
            ),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT
        );
      `);

      db.exec(`
        INSERT INTO parallel_sessions_new (id, project_path, project_repo_id, status, created_at, completed_at)
        SELECT
          id,
          project_path,
          project_repo_id,
          CASE
            WHEN status IN (
              'running',
              'merging',
              'cleanup_pending',
              'cleanup_draining',
              'blocked_conflict',
              'blocked_recovery',
              'blocked_validation',
              'completed',
              'failed',
              'aborted'
            ) THEN status
            ELSE 'running'
          END,
          created_at,
          completed_at
        FROM parallel_sessions;
      `);

      db.exec('DROP TABLE parallel_sessions');
      db.exec('ALTER TABLE parallel_sessions_new RENAME TO parallel_sessions');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.exec(GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL);
}

export function applyGlobalSchemaV14(db: Database.Database): void {
  if (!hasColumn(db, 'workstreams', 'conflict_attempts')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN conflict_attempts INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(GLOBAL_SCHEMA_V14_SQL);
}

export function applyGlobalSchemaV15(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V15_SQL);
}

export function applyGlobalSchemaV16(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V16_SQL);
}

export function applyGlobalSchemaV17(db: Database.Database): void {
  if (!hasColumn(db, 'projects', 'hibernating_until')) {
    db.exec(GLOBAL_SCHEMA_V17_SQL);
  }
}

export function applyGlobalSchemaV18(db: Database.Database): void {
  if (!hasColumn(db, 'provider_backoffs', 'reason_type')) {
    try { db.exec(GLOBAL_SCHEMA_V18_SQL); } catch (e) {
      // Ignore DROP COLUMN errors if sqlite version is too old
      console.warn('V18 schema partial application (sqlite may not support DROP COLUMN). Adding reason_type only.');
      db.exec('ALTER TABLE provider_backoffs ADD COLUMN reason_type TEXT;');
    }
  }
}
