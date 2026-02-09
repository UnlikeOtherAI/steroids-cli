-- Migration: Add file anchor columns to tasks table
-- Allows tasks to reference a specific file and line in the codebase

-- UP

ALTER TABLE tasks ADD COLUMN file_path TEXT;
ALTER TABLE tasks ADD COLUMN file_line INTEGER;
ALTER TABLE tasks ADD COLUMN file_commit_sha TEXT;
ALTER TABLE tasks ADD COLUMN file_content_hash TEXT;

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN in versions before 3.35.0
-- Would need to recreate table without the columns
-- For now, this migration is considered forward-only
