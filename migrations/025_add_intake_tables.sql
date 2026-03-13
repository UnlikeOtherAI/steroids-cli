-- Migration: Add normalized intake report storage and per-source poll state

-- UP
CREATE TABLE IF NOT EXISTS intake_reports (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    report_url TEXT NOT NULL,
    created_at_remote TEXT NOT NULL,
    updated_at_remote TEXT NOT NULL,
    resolved_at_remote TEXT,
    tags_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_reports_source_external
ON intake_reports(source, external_id);
CREATE INDEX IF NOT EXISTS idx_intake_reports_source_status
ON intake_reports(source, status);
CREATE INDEX IF NOT EXISTS idx_intake_reports_source_severity
ON intake_reports(source, severity);
CREATE INDEX IF NOT EXISTS idx_intake_reports_linked_task
ON intake_reports(linked_task_id) WHERE linked_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS intake_poll_state (
    source TEXT PRIMARY KEY,
    cursor TEXT,
    last_polled_at TEXT,
    last_success_at TEXT,
    last_error_at TEXT,
    last_error_message TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DOWN
DROP TABLE IF EXISTS intake_poll_state;
DROP INDEX IF EXISTS idx_intake_reports_linked_task;
DROP INDEX IF EXISTS idx_intake_reports_source_severity;
DROP INDEX IF EXISTS idx_intake_reports_source_status;
DROP INDEX IF EXISTS idx_intake_reports_source_external;
DROP TABLE IF EXISTS intake_reports;
