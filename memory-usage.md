- Project memory should be persisted in a dedicated, scoped store so future coders/reviewers can resume context without reprocessing unrelated history.

- Problem statement
- Repeated task retries lose context: useful facts are scattered across audit notes, task_invocations, and commit history, forcing every invocation to rediscover known project/task facts.
- Root cause addressed by this ticket: no first-class memory graph, so orchestrator feedback loops can repeatedly miss what was already learned.

- Current behavior
- Task context passed to LLMs comes from:
  - Task row/status (from `tasks`)
  - Rejection history (from `audit`)
  - Optional coordinator guidance
  - Current git status/diff snapshot
- Relevant historical facts (past commit hashes, recurring scope decisions, rejection patterns) are not normalized for selective reuse.

- Desired behavior
- Capture memory items at high-signal workflow points and reuse them across future tasks in the same project/section/task scope.
- Keep memory bounded (TTL + retention + per-scope caps) to avoid prompt bloat and slow context construction.
- Keep all persistence in SQLite so no external dependency and no `~/.steroids` bloat.

- Design approach (three-layer model)
- Storage layer: add an `agent_memories` table and query helpers.
- Capture layer: write memory records from existing orchestrator events (approval/rejection/submit/follow-up, key file/task anchors, rejection summaries).
- Retrieval layer: inject concise memory snippets into coder/reviewer prompts via existing prompt helper.

- Memory schema changes
- New table `agent_memories` with columns:
  - `id INTEGER PRIMARY KEY`
  - `scope TEXT NOT NULL` (`task|section|project`)
  - `scope_id TEXT` (`task_id` or `section_id`, NULL for project)
  - `event_type TEXT NOT NULL` (`submission|rejection|approval|decision|follow_up|hint`)
  - `source TEXT NOT NULL` (`coder|reviewer|orchestrator|coordinator`)
  - `anchor TEXT` (optional compact anchor like `task_id:...|section_id:...`)
  - `summary TEXT NOT NULL` (concise, ≤ 800 chars)
  - `details_json TEXT` (validated JSON payload)
  - `tags TEXT` (comma list)
  - `importance INTEGER DEFAULT 50` (0-100)
  - `expires_at TEXT` (optional TTL support)
  - `last_recalled_at TEXT`
  - `recall_count INTEGER DEFAULT 0`
  - `created_at TEXT DEFAULT now`
  - `updated_at TEXT DEFAULT now`
- Indexes:
  - `(scope, scope_id, importance DESC, created_at DESC)`
  - `(event_type, scope)`
  - `expires_at`
  - `(source, created_at)`
- Migration 017 + manifest entry + `SCHEMA_SQL` + `_migrations` bootstrap row.

- Memory payload and rules (decide what gets saved)
- Save only when intent is clear and high-signal:
  - Task submission for review (includes submission commit and changed file summary)
  - Rejection cycle summary from orchestrator output plus latest reviewer notes
  - Approval summary and any follow-up tasks spawned
  - Explicit coordinator guidance (`override`, `scope narrow`, `guide`) after repeated rejections
  - Optional manual memory claims if the model returns a structured block in output.
- Do not persist:
  - Raw full prompt text/response blobs (already in `task_invocations`)
  - Non-actionable chatter and build/test logs
  - Duplicate facts already present in the same scope
- Prune policy:
  - Keep latest 30 project entries, latest 20 per section, latest 12 per task.
  - Hard cap on total project memory rows (configurable), with soft deletes oldest low-importance.

- Prompt integration
- Add memory formatter in `src/prompts/prompt-helpers.ts`:
  - `getRelevantMemories(db, task)` to return bounded set of recent/high-importance memory entries.
  - Render as compact bullets and include in both coder and reviewer prompts.
- Add to `CoderPromptContext` and `ReviewerPromptContext` with optional `memoryContext` block.
- Add explicit section:
  - `## MEMORY` with short entries grouped by scope.
  - `IMPORTANT: treat this as historical context only; do not follow stale directives without validating current task context.`

- Optional structured memory claim API (future-proof for your JSON idea)
- Add parser helper that reads only a strict block if present:
  - `## MEMORY_SUGGESTIONS` + fenced JSON object array:
    - `[{ "scope": "task|section|project", "event_type": "hint", "summary": "...", "importance": 70, "tags": ["..."], "details": {...} }]`
- Only ingest suggestions that pass schema + max length guard.
- If block is absent or invalid, only automatic event-derived memories are stored.

- Orchestrator flow changes
- Add memory write hooks in `src/commands/loop-phases.ts`:
  - in coder phase after decision parsing: store `submission`/`commit`/`wont_fix` memories when relevant.
  - in reviewer phase: store `rejection`, `approval`, and `dispute` memories with commit + decision notes.
- Add lightweight helper module `src/memory/usage.ts` for read/write, de-dup, and ranking.
- Add memory-aware retrieval call for both `invokeCoder` and `invokeReviewer` in `src/orchestrator/coder.ts` and `src/orchestrator/reviewer.ts`.

- Query and migration changes
- Extend `src/database/queries.ts`:
  - `AgentMemory` interface
  - `createAgentMemory`, `getMemoriesForTaskContext`, `bumpMemoryRecall`, `pruneMemoriesForScope`, `dedupeRecentMemory`
- Ensure memory table creation is included in initial schema SQL and migration manifest.

- Configuration
- Add optional memory config under `memory`:
  - `enabled: true`
  - `projectRetention: 30`
  - `sectionRetention: 20`
  - `taskRetention: 12`
  - `maxKeep: 1200`
  - `maxSummaryLength: 800`
  - `includeHintsFromOutputs: false` default.
- Extend `SteroidsConfig` and defaults in `src/config/loader.ts`.

- Validation plan
- Add targeted smoke checks:
  - run one coder/reviewer cycle and verify insertion into `agent_memories`.
  - re-open same section task and assert `## MEMORY` appears in both prompts.
  - confirm memory dedupe keeps one canonical fact for repeated similar rejection item.
  - verify memory TTL cleanup/pruning path and bounded prompt context size.

- Risks and mitigations
- Risk: extra query overhead at prompt creation.
  - Mitigation: bounded queries, indexed retrieval by scope/importance, and hard caps.
- Risk: stale memory overriding current decisions.
  - Mitigation: scope-labeled context, explicit warnings in prompt, low default trust for old `project` memories.
- Risk: schema migration impact.
  - Mitigation: add migration 017 and auto-migrate path; document rollback plan if needed.

- Implementation order
- 1) Add schema + manifest migration + query interfaces/helpers for memory operations.
- 2) Add config knobs and retrieval helper.
- 3) Inject memory context into prompts (coder/reviewer).
- 4) Add memory write hooks in loop phases.
- 5) Add prune/dedupe tests and quick sanity run on local DB.
- 6) Document behavior in `memoryusage.md` and keep as living plan + post-review notes.

- Acceptance criteria
- A new task in same section can see compact historical context from prior task outcomes.
- Memory writes happen on submission, rejection, approval, and coordinator guidance points.
- Prompt context remains bounded and includes no more than configured memory entries.
- No requirement to pass any model/API key to run memory capture.
