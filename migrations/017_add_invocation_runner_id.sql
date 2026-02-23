-- Migration: Add runner_id to task_invocations
-- Required for accurate workstream tracking during task reset

-- UP
ALTER TABLE task_invocations ADD COLUMN runner_id TEXT;

-- DOWN
-- SQLite does not support DROP COLUMN cleanly without table recreation, so down is a no-op
