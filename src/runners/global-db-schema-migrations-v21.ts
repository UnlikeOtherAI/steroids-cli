/**
 * Global DB migration SQL for schema version 21: Monitor feature tables.
 * Kept separate to enforce file-size limits in global-db-schema.ts.
 */

export const GLOBAL_SCHEMA_V21_SQL = `
CREATE TABLE IF NOT EXISTS monitor_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  investigator_agents TEXT NOT NULL DEFAULT '[]',
  response_preset TEXT NOT NULL DEFAULT 'investigate_and_stop',
  custom_prompt TEXT,
  escalation_rules TEXT NOT NULL DEFAULT '{"min_severity":"critical"}',
  investigation_timeout_seconds INTEGER NOT NULL DEFAULT 900,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO monitor_config (id, updated_at) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'clean',
  scan_results TEXT,
  escalation_reason TEXT,
  investigation_needed INTEGER DEFAULT 0,
  investigator_agent TEXT,
  investigator_actions TEXT,
  investigator_report TEXT,
  action_results TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitor_runs_started ON monitor_runs(started_at DESC);
`;

export const GLOBAL_SCHEMA_V22_SQL = `
ALTER TABLE monitor_config RENAME COLUMN investigator_agents TO first_responder_agents;
ALTER TABLE monitor_config RENAME COLUMN investigation_timeout_seconds TO first_responder_timeout_seconds;
ALTER TABLE monitor_runs RENAME COLUMN investigation_needed TO first_responder_needed;
ALTER TABLE monitor_runs RENAME COLUMN investigator_agent TO first_responder_agent;
ALTER TABLE monitor_runs RENAME COLUMN investigator_actions TO first_responder_actions;
ALTER TABLE monitor_runs RENAME COLUMN investigator_report TO first_responder_report;

CREATE TABLE IF NOT EXISTS monitor_remediation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  anomaly_fingerprint TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'attempted'
);
CREATE INDEX IF NOT EXISTS idx_monitor_remediation_project ON monitor_remediation_attempts(project_path, anomaly_fingerprint);
`;

export const GLOBAL_SCHEMA_V23_SQL = `
UPDATE monitor_config SET escalation_rules = '{"min_severity":"warning"}' WHERE escalation_rules = '{"min_severity":"critical"}';
`;

export const GLOBAL_SCHEMA_V24_SQL = `
CREATE TABLE IF NOT EXISTS monitor_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL,
  project_path TEXT,
  anomaly_fingerprint TEXT,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_monitor_alerts_unacked ON monitor_alerts(acknowledged, created_at DESC);

CREATE TABLE IF NOT EXISTS monitor_suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(project_path, anomaly_type)
);
CREATE INDEX IF NOT EXISTS idx_monitor_suppressions_lookup ON monitor_suppressions(project_path, anomaly_type);
`;

export const GLOBAL_SCHEMA_VERSION = '24';
