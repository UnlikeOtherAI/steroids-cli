-- Migration: Add file anchor columns to tasks table
-- Allows tasks to reference a specific file and line in the codebase

-- UP

ALTER TABLE tasks ADD COLUMN file_path TEXT;
ALTER TABLE tasks ADD COLUMN file_line INTEGER;
ALTER TABLE tasks ADD COLUMN file_commit_sha TEXT;
ALTER TABLE tasks ADD COLUMN file_content_hash TEXT;

-- DOWN

ALTER TABLE tasks DROP COLUMN file_path;
ALTER TABLE tasks DROP COLUMN file_line;
ALTER TABLE tasks DROP COLUMN file_commit_sha;
ALTER TABLE tasks DROP COLUMN file_content_hash;
