-- UP
-- Migration 019: Add start_commit_sha to tasks table to support End-State Squashing

ALTER TABLE tasks ADD COLUMN start_commit_sha TEXT;

-- DOWN
-- Migration 019 rollback

ALTER TABLE tasks DROP COLUMN start_commit_sha;
