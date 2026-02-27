-- UP
-- Add workspace pool fields to tasks table
ALTER TABLE tasks ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_conflict_count ON tasks(conflict_count) WHERE conflict_count > 0;

-- DOWN
-- SQLite doesn't support DROP COLUMN in older versions
-- ALTER TABLE tasks DROP COLUMN conflict_count;
-- ALTER TABLE tasks DROP COLUMN blocked_reason;
