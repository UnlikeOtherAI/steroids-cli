-- Migration: Add session context and token usage to task_invocations
-- Supports session reuse across coder/reviewer cycles to save tokens/time

-- UP
ALTER TABLE task_invocations ADD COLUMN session_id TEXT;
ALTER TABLE task_invocations ADD COLUMN resumed_from_session_id TEXT;
ALTER TABLE task_invocations ADD COLUMN invocation_mode TEXT DEFAULT 'fresh'; -- 'fresh' | 'resume'
ALTER TABLE task_invocations ADD COLUMN token_usage_json TEXT; -- JSON blob of TokenUsage

-- Index for session lookups
CREATE INDEX IF NOT EXISTS idx_task_invocations_session ON task_invocations(session_id);

-- DOWN
-- SQLite does not support DROP COLUMN.
-- In a real prod DB, we'd recreate the table.
-- For now, this migration is simple and low-risk.
DROP INDEX IF EXISTS idx_task_invocations_session;
