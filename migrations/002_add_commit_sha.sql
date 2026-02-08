-- Migration: Add commit_sha to audit table
-- Tracks which commit was involved in each status change

-- UP
ALTER TABLE audit ADD COLUMN commit_sha TEXT;

-- Create index for commit lookups
CREATE INDEX IF NOT EXISTS idx_audit_commit ON audit(commit_sha);

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN directly
-- Would need to recreate table without the column
