-- Add per-section coder provider/model overrides and PR metadata fields

-- UP
ALTER TABLE sections ADD COLUMN coder_provider TEXT;
ALTER TABLE sections ADD COLUMN coder_model TEXT;
ALTER TABLE sections ADD COLUMN pr_labels TEXT;
ALTER TABLE sections ADD COLUMN pr_draft INTEGER NOT NULL DEFAULT 0;

-- DOWN
-- SQLite does not support DROP COLUMN in older versions; rollback requires table rebuild.
SELECT 1;
