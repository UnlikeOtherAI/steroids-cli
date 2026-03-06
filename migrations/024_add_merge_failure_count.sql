-- Migration: Add merge_failure_count to tasks for dedicated merge failure tracking

-- UP
ALTER TABLE tasks ADD COLUMN merge_failure_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tasks_merge_failures ON tasks(merge_failure_count) WHERE merge_failure_count > 0;

-- DOWN
DROP INDEX IF EXISTS idx_tasks_merge_failures;
-- SQLite cannot drop columns; column will remain but be unused after rollback
