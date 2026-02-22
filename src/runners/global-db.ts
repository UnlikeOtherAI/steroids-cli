/**
 * Global database for runner state
 * Located at ~/.steroids/steroids.db (user home, not project)
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STEROIDS_DIR = '.steroids';
const DB_NAME = 'steroids.db';

export interface GlobalDatabaseConnection {
  db: Database.Database;
  close: () => void;
}

export type ParallelSessionStatus =
  | 'running'
  | 'merging'
  | 'cleanup_pending'
  | 'cleanup_draining'
  | 'blocked_conflict'
  | 'blocked_recovery'
  | 'blocked_validation'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface ParallelSessionRunner {
  id: string;
  pid: number | null;
}

export interface ValidationEscalationRecord {
  id: string;
  session_id: string;
  project_path: string;
  workspace_path: string;
  validation_command: string;
  error_message: string;
  stdout_snippet: string | null;
  stderr_snippet: string | null;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

/**
 * Schema for global database (runners and locks)
 */
const GLOBAL_SCHEMA_SQL = `
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
const GLOBAL_SCHEMA_V2_SQL = `
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
const GLOBAL_SCHEMA_V3_SQL = `
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
const GLOBAL_SCHEMA_V4_SQL = `
-- Add section_id column to runners for section focus feature
ALTER TABLE runners ADD COLUMN section_id TEXT;
`;

/**
 * Schema upgrade from version 4 to version 5: Add activity_log table
 */
const GLOBAL_SCHEMA_V5_SQL = `
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
const GLOBAL_SCHEMA_V6_SQL = `
-- Add commit_message column to activity_log for storing coder's final message
ALTER TABLE activity_log ADD COLUMN commit_message TEXT;
`;

/**
 * Schema upgrade from version 6 to version 7: Add commit_sha to activity_log
 */
const GLOBAL_SCHEMA_V7_SQL = `
-- Add commit_sha column to activity_log for GitHub links
ALTER TABLE activity_log ADD COLUMN commit_sha TEXT;
`;

/**
 * Schema upgrade from version 7 to version 8: Add parallel session tracking
 */
const GLOBAL_SCHEMA_V8_SQL = `
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
const GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL = `
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
const GLOBAL_SCHEMA_V10_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_session_status
ON workstreams(session_id, status);
`;

/**
 * Schema upgrade from version 10 to version 11: add sealed merge input fields.
 */
const GLOBAL_SCHEMA_V11_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_completion_order
ON workstreams(session_id, completion_order);
`;

/**
 * Schema upgrade from version 11 to version 12: add reconciliation/backoff fields.
 */
const GLOBAL_SCHEMA_V12_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_next_retry_at
ON workstreams(next_retry_at);
`;

/**
 * Schema upgrade from version 13 to version 14: add conflict attempt tracking.
 */
const GLOBAL_SCHEMA_V14_SQL = `
CREATE INDEX IF NOT EXISTS idx_workstreams_conflict_attempts
ON workstreams(conflict_attempts);
`;

/**
 * Schema upgrade from version 14 to version 15: add validation escalation tracking.
 */
const GLOBAL_SCHEMA_V15_SQL = `
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
const GLOBAL_SCHEMA_V16_SQL = `
  CREATE TABLE IF NOT EXISTS provider_backoffs (
    provider TEXT PRIMARY KEY,
    backoff_until_ms INTEGER NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    updated_at INTEGER NOT NULL
  );
`;

const GLOBAL_SCHEMA_VERSION = '16';

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function applyGlobalSchemaV9(db: Database.Database): void {
  if (!hasColumn(db, 'parallel_sessions', 'project_repo_id')) {
    db.exec('ALTER TABLE parallel_sessions ADD COLUMN project_repo_id TEXT');
  }

  db.exec(
    "UPDATE parallel_sessions SET project_repo_id = project_path WHERE project_repo_id IS NULL"
  );
  db.exec(GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL);
}

function applyGlobalSchemaV10(db: Database.Database): void {
  if (!hasColumn(db, 'workstreams', 'claim_generation')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0');
  }

  if (!hasColumn(db, 'workstreams', 'lease_expires_at')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN lease_expires_at TEXT');
  }

  db.exec(
    "UPDATE workstreams SET lease_expires_at = datetime('now', '+120 seconds') " +
    "WHERE lease_expires_at IS NULL AND status = 'running'"
  );
  db.exec(GLOBAL_SCHEMA_V10_SQL);
}

function applyGlobalSchemaV11(db: Database.Database): void {
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

function applyGlobalSchemaV12(db: Database.Database): void {
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

function applyGlobalSchemaV13(db: Database.Database): void {
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

function applyGlobalSchemaV14(db: Database.Database): void {
  if (!hasColumn(db, 'workstreams', 'conflict_attempts')) {
    db.exec('ALTER TABLE workstreams ADD COLUMN conflict_attempts INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(GLOBAL_SCHEMA_V14_SQL);
}

function applyGlobalSchemaV15(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V15_SQL);
}

function applyGlobalSchemaV16(db: Database.Database): void {
  db.exec(GLOBAL_SCHEMA_V16_SQL);
}

/**
 * Get the path to the global steroids directory.
 * Respects STEROIDS_HOME env var for test isolation (Jest's ESM VM context
 * doesn't propagate process.env.HOME changes to CJS os.homedir()).
 */
export function getGlobalSteroidsDir(): string {
  const home = process.env.STEROIDS_HOME || homedir();
  return join(home, STEROIDS_DIR);
}

/**
 * Get the path to the global database
 */
export function getGlobalDbPath(): string {
  return join(getGlobalSteroidsDir(), DB_NAME);
}

/**
 * Check if global database exists
 */
export function isGlobalDbInitialized(): boolean {
  return existsSync(getGlobalDbPath());
}

/**
 * Initialize and open the global database
 * Creates it if it doesn't exist
 */
export function openGlobalDatabase(): GlobalDatabaseConnection {
  const dbPath = getGlobalDbPath();
  const steroidsDir = getGlobalSteroidsDir();

  // Create ~/.steroids directory if it doesn't exist
  if (!existsSync(steroidsDir)) {
    mkdirSync(steroidsDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Configure SQLite for optimal performance and safety
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Create base schema (IF NOT EXISTS makes this idempotent)
  db.exec(GLOBAL_SCHEMA_SQL);

  // Get current version
  const versionRow = db
    .prepare('SELECT value FROM _global_schema WHERE key = ?')
    .get('version') as { value: string } | undefined;

  const currentVersion = versionRow?.value;

  if (!currentVersion) {
    // Fresh database - apply all schemas and set to latest version
    db.exec(GLOBAL_SCHEMA_V2_SQL);
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'version',
      GLOBAL_SCHEMA_VERSION
    );
    db.prepare('INSERT INTO _global_schema (key, value) VALUES (?, ?)').run(
      'created_at',
      new Date().toISOString()
    );
  } else if (currentVersion === '1') {
    // Upgrade from version 1 to latest
    db.exec(GLOBAL_SCHEMA_V2_SQL);
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '2') {
    // Upgrade from version 2 to latest
    db.exec(GLOBAL_SCHEMA_V3_SQL);
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '3') {
    // Upgrade from version 3 to latest
    db.exec(GLOBAL_SCHEMA_V4_SQL);
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '4') {
    // Upgrade from version 4 to latest
    db.exec(GLOBAL_SCHEMA_V5_SQL);
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '5') {
    // Upgrade from version 5 to latest
    db.exec(GLOBAL_SCHEMA_V6_SQL);
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '6') {
    // Upgrade from version 6 to version 7
    db.exec(GLOBAL_SCHEMA_V7_SQL);
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '7') {
    // Upgrade from version 7 to version 8
    db.exec(GLOBAL_SCHEMA_V8_SQL);
    applyGlobalSchemaV9(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '8') {
    // Upgrade from version 8 to version 9
    applyGlobalSchemaV9(db);
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '9') {
    // Upgrade from version 9 to version 10
    applyGlobalSchemaV10(db);
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '10') {
    // Upgrade from version 10 to version 11
    applyGlobalSchemaV11(db);
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '11') {
    // Upgrade from version 11 to version 12
    applyGlobalSchemaV12(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  } else if (currentVersion === '15') {
    applyGlobalSchemaV16(db);
    db.prepare('UPDATE _global_schema SET value = ? WHERE key = ?').run(
      GLOBAL_SCHEMA_VERSION,
      'version'
    );
  }
  // Future upgrades would be handled here with additional conditions
  applyGlobalSchemaV9(db);
  applyGlobalSchemaV10(db);
  applyGlobalSchemaV11(db);
  applyGlobalSchemaV12(db);
  applyGlobalSchemaV13(db);
  applyGlobalSchemaV14(db);
  applyGlobalSchemaV15(db);
  applyGlobalSchemaV16(db);
  db.prepare(
    `INSERT INTO _global_schema (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('version', GLOBAL_SCHEMA_VERSION);

  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Get global schema version
 */
export function getGlobalSchemaVersion(db: Database.Database): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM _global_schema WHERE key = ?')
      .get('version') as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function updateParallelSessionStatus(
  sessionId: string,
  status: ParallelSessionStatus,
  markCompletedAt = false
): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `UPDATE parallel_sessions
       SET status = ?,
           completed_at = CASE
             WHEN ? = 1 THEN datetime('now')
             ELSE completed_at
           END
       WHERE id = ?`
    ).run(status, markCompletedAt ? 1 : 0, sessionId);
  } finally {
    close();
  }
}

export function revokeWorkstreamLeasesForSession(sessionId: string): number {
  const { db, close } = openGlobalDatabase();
  try {
    const result = db.prepare(
      `UPDATE workstreams
       SET runner_id = NULL,
           lease_expires_at = datetime('now')
       WHERE session_id = ?`
    ).run(sessionId);
    return result.changes;
  } finally {
    close();
  }
}

export function listParallelSessionRunners(sessionId: string): ParallelSessionRunner[] {
  const { db, close } = openGlobalDatabase();
  try {
    return db
      .prepare('SELECT id, pid FROM runners WHERE parallel_session_id = ?')
      .all(sessionId) as ParallelSessionRunner[];
  } finally {
    close();
  }
}

export function removeParallelSessionRunner(runnerId: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('DELETE FROM runners WHERE id = ?').run(runnerId);
  } finally {
    close();
  }
}

export function recordValidationEscalation(input: {
  sessionId: string;
  projectPath: string;
  workspacePath: string;
  validationCommand: string;
  errorMessage: string;
  stdoutSnippet?: string | null;
  stderrSnippet?: string | null;
}): ValidationEscalationRecord {
  const { db, close } = openGlobalDatabase();
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO validation_escalations (
         id, session_id, project_path, workspace_path, validation_command,
         error_message, stdout_snippet, stderr_snippet, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    ).run(
      id,
      input.sessionId,
      input.projectPath,
      input.workspacePath,
      input.validationCommand,
      input.errorMessage,
      input.stdoutSnippet ?? null,
      input.stderrSnippet ?? null
    );

    const row = db
      .prepare(
        `SELECT id, session_id, project_path, workspace_path, validation_command,
                error_message, stdout_snippet, stderr_snippet, status, created_at, resolved_at
         FROM validation_escalations
         WHERE id = ?`
      )
      .get(id) as ValidationEscalationRecord | undefined;

    if (!row) {
      throw new Error(`Failed to read validation escalation record for id ${id}`);
    }

    return row;
  } finally {
    close();
  }
}

export function resolveValidationEscalationsForSession(sessionId: string): number {
  const { db, close } = openGlobalDatabase();
  try {
    const result = db.prepare(
      `UPDATE validation_escalations
       SET status = 'resolved',
           resolved_at = datetime('now')
       WHERE session_id = ?
         AND status = 'open'`
    ).run(sessionId);

    return result.changes;
  } finally {
    close();
  }
}

/**
 * Record a provider rate limit backoff in the global DB.
 * Uses MAX so existing longer backoffs are never shortened.
 */
export function recordProviderBackoff(provider: string, backoffUntilMs: number, reason?: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(`
      INSERT INTO provider_backoffs (provider, backoff_until_ms, retry_count, reason, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        backoff_until_ms = MAX(backoff_until_ms, excluded.backoff_until_ms),
        retry_count = retry_count + 1,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(provider, backoffUntilMs, reason ?? null, Date.now());
  } finally {
    close();
  }
}

/**
 * Get how many ms until the provider's global backoff expires (0 if not backed off).
 */
export function getProviderBackoffRemainingMs(provider: string): number {
  const { db, close } = openGlobalDatabase();
  try {
    const row = db
      .prepare('SELECT backoff_until_ms FROM provider_backoffs WHERE provider = ?')
      .get(provider) as { backoff_until_ms: number } | undefined;
    if (!row) return 0;
    return Math.max(0, row.backoff_until_ms - Date.now());
  } finally {
    close();
  }
}

/**
 * Clear a provider's backoff record (called after a successful invocation).
 */
export function clearProviderBackoff(provider: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('DELETE FROM provider_backoffs WHERE provider = ?').run(provider);
  } finally {
    close();
  }
}
