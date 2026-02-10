-- Migration: Add incidents table and failure tracking for stuck-task recovery
-- Supports automatic recovery actions (reset orphaned tasks, escalate after repeats)

-- UP
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  runner_id TEXT,
  failure_mode TEXT NOT NULL, -- orphaned_task | hanging_invocation | zombie_runner | dead_runner
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT, -- auto_restart | skipped | escalated | none
  details TEXT, -- JSON string with relevant diagnostics
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_incidents_task ON incidents(task_id);
CREATE INDEX IF NOT EXISTS idx_incidents_detected ON incidents(detected_at);
CREATE INDEX IF NOT EXISTS idx_incidents_unresolved ON incidents(resolved_at) WHERE resolved_at IS NULL;

-- Add failure tracking to tasks (forward-only; SQLite can't drop columns)
ALTER TABLE tasks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_failure_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_failures ON tasks(failure_count) WHERE failure_count > 0;

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN directly
-- Forward-only migration for tasks table changes
DROP INDEX IF EXISTS idx_tasks_failures;
DROP INDEX IF EXISTS idx_incidents_unresolved;
DROP INDEX IF EXISTS idx_incidents_detected;
DROP INDEX IF EXISTS idx_incidents_task;
DROP TABLE IF EXISTS incidents;

