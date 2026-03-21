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

export const GLOBAL_SCHEMA_VERSION = '21';
