-- Migration: Add last_activity_at to task_invocations
-- Allows health checks to distinguish between "long running" and "stopped responding"

-- UP
ALTER TABLE task_invocations ADD COLUMN last_activity_at_ms INTEGER;

-- DOWN
-- SQLite doesn't support DROP COLUMN
