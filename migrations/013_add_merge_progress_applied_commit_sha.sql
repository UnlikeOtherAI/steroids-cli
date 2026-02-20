-- Add applied commit SHA tracking for merge progress provenance

-- UP
ALTER TABLE merge_progress ADD COLUMN applied_commit_sha TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_progress_unique_position
ON merge_progress(session_id, workstream_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_progress_unique_commit
ON merge_progress(session_id, workstream_id, commit_sha);

-- DOWN
DROP INDEX IF EXISTS idx_merge_progress_unique_commit;
DROP INDEX IF EXISTS idx_merge_progress_unique_position;
-- SQLite does not support DROP COLUMN; column will remain but is harmless.
