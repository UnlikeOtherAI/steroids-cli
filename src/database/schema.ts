/**
 * Database schema definitions for Steroids CLI
 * Creates all required tables with proper constraints
 */

export const SCHEMA_VERSION = '0.1.0';

export const SCHEMA_SQL = `
-- Schema metadata (version tracking)
CREATE TABLE IF NOT EXISTS _schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Applied migrations log
CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sections (task groups)
CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    priority INTEGER DEFAULT 50,
    skipped INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sections_priority ON sections(priority);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    section_id TEXT REFERENCES sections(id),
    source_file TEXT,
    file_path TEXT,
    file_line INTEGER,
    file_commit_sha TEXT,
    file_content_hash TEXT,
    rejection_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section_id);
CREATE INDEX IF NOT EXISTS idx_tasks_failures ON tasks(failure_count) WHERE failure_count > 0;

-- Audit trail (immutable log of status changes)
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_type TEXT DEFAULT 'human',
    model TEXT,
    notes TEXT,
    commit_sha TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_task ON audit(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_commit ON audit(commit_sha);

-- Disputes
CREATE TABLE IF NOT EXISTS disputes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT NOT NULL,
    coder_position TEXT,
    reviewer_position TEXT,
    resolution TEXT,
    resolution_notes TEXT,
    created_by TEXT NOT NULL,
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_disputes_task ON disputes(task_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- Task locks (for orchestrator coordination)
CREATE TABLE IF NOT EXISTS task_locks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_locks_expires ON task_locks(expires_at);

-- Section locks (for orchestrator coordination)
CREATE TABLE IF NOT EXISTS section_locks (
    section_id TEXT PRIMARY KEY REFERENCES sections(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_section_locks_expires ON section_locks(expires_at);

-- Section dependencies (ordering constraints between sections)
CREATE TABLE IF NOT EXISTS section_dependencies (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL REFERENCES sections(id),
    depends_on_section_id TEXT NOT NULL REFERENCES sections(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(section_id, depends_on_section_id)
);

CREATE INDEX IF NOT EXISTS idx_section_dependencies_section ON section_dependencies(section_id);
CREATE INDEX IF NOT EXISTS idx_section_dependencies_depends_on ON section_dependencies(depends_on_section_id);

-- Task invocations (LLM calls per task)
CREATE TABLE IF NOT EXISTS task_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT,
    error TEXT,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    status TEXT DEFAULT 'completed' CHECK(status IN ('running', 'completed', 'failed', 'timeout')),
    exit_code INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 0,
    timed_out INTEGER NOT NULL DEFAULT 0,
    rejection_number INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_invocations_task ON task_invocations(task_id);
CREATE INDEX IF NOT EXISTS idx_task_invocations_role ON task_invocations(role);
CREATE INDEX IF NOT EXISTS idx_task_invocations_created ON task_invocations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_invocations_task_status ON task_invocations(task_id, status, started_at_ms DESC);

-- Incidents (stuck-task detection/recovery)
CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    runner_id TEXT,
    failure_mode TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_incidents_task ON incidents(task_id);
CREATE INDEX IF NOT EXISTS idx_incidents_detected ON incidents(detected_at);
CREATE INDEX IF NOT EXISTS idx_incidents_unresolved ON incidents(resolved_at) WHERE resolved_at IS NULL;

-- Merge locks (global lock during project merges)
CREATE TABLE IF NOT EXISTS merge_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merge_locks_expires ON merge_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_merge_locks_heartbeat ON merge_locks(heartbeat_at);

-- Merge progress tracking for crash recovery during cherry-pick
CREATE TABLE IF NOT EXISTS merge_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'conflict', 'skipped')),
    conflict_task_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_merge_progress_session ON merge_progress(session_id, position);
CREATE INDEX IF NOT EXISTS idx_merge_progress_status ON merge_progress(status, applied_at);
`;

export const INITIAL_SCHEMA_DATA = `
INSERT OR REPLACE INTO _schema (key, value) VALUES ('version', '${SCHEMA_VERSION}');
INSERT OR REPLACE INTO _schema (key, value) VALUES ('created_at', datetime('now'));

-- Mark all migrations as applied since new databases have the full schema
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (1, '001_initial_schema', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (2, '002_add_commit_sha', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (3, '003_add_section_priority', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (4, '004_add_section_dependencies', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (5, '005_add_audit_actor_model', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (6, '006_add_task_invocations', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (7, '007_add_file_anchor', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (8, '008_add_section_skipped', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (9, '009_add_incidents_and_failure_tracking', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (10, '010_add_lifecycle_timestamps', 'builtin');
INSERT OR IGNORE INTO _migrations (id, name, checksum) VALUES (11, '011_add_merge_locks_and_progress', 'builtin');
`;
