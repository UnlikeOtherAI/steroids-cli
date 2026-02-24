-- UP
-- Migration 018: Add explicit columns to audit table to replace string-parsing

ALTER TABLE audit ADD COLUMN category TEXT;
ALTER TABLE audit ADD COLUMN error_code TEXT;
ALTER TABLE audit ADD COLUMN metadata TEXT;

-- DOWN
-- Migration 018 rollback

ALTER TABLE audit DROP COLUMN category;
ALTER TABLE audit DROP COLUMN error_code;
ALTER TABLE audit DROP COLUMN metadata;
