/**
 * Global DB migration SQL for schema versions 17-20.
 * Kept separate to enforce file-size limits in global-db-schema.ts.
 */

export const GLOBAL_SCHEMA_V17_SQL = `
-- Add hibernation fields to projects table
-- Note: These columns are deprecated in V18 but kept here for schema history.
ALTER TABLE projects ADD COLUMN hibernating_until TEXT;
ALTER TABLE projects ADD COLUMN hibernation_tier INTEGER DEFAULT 0;
`;

export const GLOBAL_SCHEMA_V18_SQL = `
-- Drop project hibernation fields and add provider backoff reason_type
ALTER TABLE projects DROP COLUMN hibernating_until;
ALTER TABLE projects DROP COLUMN hibernation_tier;
ALTER TABLE provider_backoffs ADD COLUMN reason_type TEXT;
`;

export const GLOBAL_SCHEMA_V19_SQL = `
-- Workspace pool slots for deterministic git lifecycle
CREATE TABLE IF NOT EXISTS workspace_pool_slots (
  id             INTEGER PRIMARY KEY,
  project_id     TEXT NOT NULL,
  slot_index     INTEGER NOT NULL,
  slot_path      TEXT NOT NULL,
  remote_url     TEXT,
  runner_id      TEXT,
  task_id        TEXT,
  base_branch    TEXT,
  task_branch    TEXT,
  starting_sha   TEXT,
  status         TEXT NOT NULL DEFAULT 'idle',
  claimed_at     INTEGER,
  heartbeat_at   INTEGER,
  UNIQUE(project_id, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_workspace_pool_slots_project
ON workspace_pool_slots(project_id, status);

-- Workspace merge locks for serializing merge-to-base operations
CREATE TABLE IF NOT EXISTS workspace_merge_locks (
  id             INTEGER PRIMARY KEY,
  project_id     TEXT NOT NULL UNIQUE,
  runner_id      TEXT NOT NULL,
  slot_id        INTEGER NOT NULL,
  acquired_at    INTEGER NOT NULL,
  heartbeat_at   INTEGER NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES workspace_pool_slots(id)
);
`;

export const GLOBAL_SCHEMA_V20_SQL = `
CREATE TABLE IF NOT EXISTS hf_usage (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  provider TEXT,
  routing_policy TEXT,
  role TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated_cost_usd REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hf_paired_models (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  routing_policy TEXT DEFAULT 'fastest',
  supports_tools INTEGER DEFAULT 0,
  available INTEGER DEFAULT 1,
  added_at INTEGER NOT NULL,
  UNIQUE(model_id, runtime)
);

CREATE TABLE IF NOT EXISTS ollama_usage (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  role TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_duration_ns INTEGER,
  load_duration_ns INTEGER,
  prompt_eval_duration_ns INTEGER,
  eval_duration_ns INTEGER,
  tokens_per_second REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ollama_paired_models (
  id INTEGER PRIMARY KEY,
  model_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  supports_tools INTEGER DEFAULT 0,
  available INTEGER DEFAULT 1,
  added_at INTEGER NOT NULL,
  UNIQUE(model_name, runtime, endpoint)
);
`;
