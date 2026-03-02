-- Migration: Add task_feedback table for human feedback persistence

-- UP
CREATE TABLE IF NOT EXISTS task_feedback (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    feedback TEXT NOT NULL CHECK(length(feedback) <= 8000),
    source TEXT NOT NULL DEFAULT 'user',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_feedback_task ON task_feedback(task_id);
CREATE INDEX IF NOT EXISTS idx_task_feedback_task_created ON task_feedback(task_id, created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_task_feedback_task_created;
DROP INDEX IF EXISTS idx_task_feedback_task;
DROP TABLE IF EXISTS task_feedback;
