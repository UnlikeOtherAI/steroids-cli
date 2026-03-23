-- UP
ALTER TABLE tasks ADD COLUMN merge_phase TEXT;
ALTER TABLE tasks ADD COLUMN approved_sha TEXT;
ALTER TABLE tasks ADD COLUMN rebase_attempts INTEGER DEFAULT 0;

-- DOWN
-- SQLite does not support DROP COLUMN; these columns are nullable/defaulted
-- and harmless if left in place after rollback.
