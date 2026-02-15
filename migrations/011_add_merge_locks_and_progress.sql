-- Migration: Add merge locks and progress tables for parallel merge workflows

-- UP

CREATE TABLE IF NOT EXISTS merge_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merge_locks_expires ON merge_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_merge_locks_heartbeat ON merge_locks(heartbeat_at);

CREATE TABLE IF NOT EXISTS merge_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'conflict', 'skipped')),
  conflict_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_merge_progress_session ON merge_progress(session_id, position);
CREATE INDEX IF NOT EXISTS idx_merge_progress_status ON merge_progress(status, applied_at);

-- DOWN
-- Merge lock/progress tables are used for crash recovery during merge.
DROP INDEX IF EXISTS idx_merge_progress_status;
DROP INDEX IF EXISTS idx_merge_progress_session;
DROP TABLE IF EXISTS merge_progress;
DROP INDEX IF EXISTS idx_merge_locks_heartbeat;
DROP INDEX IF EXISTS idx_merge_locks_expires;
DROP TABLE IF EXISTS merge_locks;
