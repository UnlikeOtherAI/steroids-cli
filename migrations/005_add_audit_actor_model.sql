-- Migration: Add actor_type and model columns to audit table
-- This allows better tracking of who/what made changes

-- UP
ALTER TABLE audit ADD COLUMN actor_type TEXT DEFAULT 'human';
ALTER TABLE audit ADD COLUMN model TEXT;

-- DOWN
-- SQLite doesn't support DROP COLUMN in older versions
-- For rollback, would need to recreate table without these columns
