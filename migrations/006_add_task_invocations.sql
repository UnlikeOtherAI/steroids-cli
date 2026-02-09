-- Migration: Add task_invocations table for per-task LLM logging
-- Stores coder and reviewer prompts/responses for debugging death spirals

-- UP

-- Task invocations (LLM calls per task)
CREATE TABLE IF NOT EXISTS task_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL,  -- 'coder' or 'reviewer'
    provider TEXT NOT NULL,  -- 'claude', 'codex', 'gemini', 'openai'
    model TEXT NOT NULL,  -- model identifier
    prompt TEXT NOT NULL,  -- full prompt sent to LLM
    response TEXT,  -- LLM response (stdout)
    error TEXT,  -- stderr if any
    exit_code INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 0,  -- 0 = failed, 1 = success
    timed_out INTEGER NOT NULL DEFAULT 0,  -- 0 = no, 1 = yes
    rejection_number INTEGER,  -- which rejection attempt this was (for coders)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for fast lookups by task
CREATE INDEX IF NOT EXISTS idx_task_invocations_task ON task_invocations(task_id);
CREATE INDEX IF NOT EXISTS idx_task_invocations_role ON task_invocations(role);
CREATE INDEX IF NOT EXISTS idx_task_invocations_created ON task_invocations(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_task_invocations_created;
DROP INDEX IF EXISTS idx_task_invocations_role;
DROP INDEX IF EXISTS idx_task_invocations_task;
DROP TABLE IF EXISTS task_invocations;
