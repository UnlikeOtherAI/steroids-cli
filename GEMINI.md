# GEMINI.md (Mandates for Gemini CLI)

> **PRIME DIRECTIVE:** This file contains foundational mandates for Gemini CLI. Per system instructions, this file takes absolute precedence over general workflows.

## Source of Truth
The following files are the **absolute source of truth** for architectural standards, coding style, and operational procedures in this project. You MUST synchronize your behavior with these files as your first priority:

1.  **[CLAUDE.md](./CLAUDE.md)**: Foundation for coding standards, technical constraints, and development workflow.
2.  **[AGENTS.md](./AGENTS.md)**: Foundation for cross-agent design reviews, multi-provider personas, and technical debt management.

## Gemini-Specific Mandates

### 1. Universal Isolation & Reliability
- You MUST ensure every CLI provider invocation remains isolated via the `setupIsolatedHome` paradigm to prevent concurrency race conditions.
- You MUST honor the 5-minute backoff period for Gemini `RESOURCE_EXHAUSTED` (high demand) errors.

### 1.1 Root-Cause First (CRITICAL)
- Do **NOT** patch issues by piling on fallback logic before understanding the underlying defect.
- For failures, first produce a root-cause analysis with concrete evidence (logs, code path, state assumptions).
- Fix the deterministic root cause first; use fallback only as temporary containment with a planned removal task.
- Reject solutions that rely primarily on retries/fallback chains instead of repairing broken session/state invariants.

### 2. Documentation Alignment
- Every feature implementation is incomplete until `README.md`, `AGENTS.md`, and the CLI's internal `CONFIG_SCHEMA` are synchronized with the changes.
- Always verify the "Help" strings in `src/commands/` after adding new flags or subcommands.
### 3. Interactive Commands
- **NEVER** run commands in interactive mode. If you need to launch a command line utility (like codex, vibe, or any other agent), ALWAYS use non-interactive mode (e.g. passing flags like `--yes`, `exec`, `-p`, etc.).
- **CRITICAL**: Every time you call `npx tsx` or any `npx` command, you MUST append the `-y` or `--yes` flag (e.g., `npx -y tsx script.js`) to automatically accept package installations. Otherwise, the process will hang indefinitely waiting for user input.

### 4. Architectural & Code Quality Practices
- **File Limits:** No file should be more than 500 lines of code. If a file is getting too large, break it down into modular, logical components.
- **Pattern Reuse:** Do not introduce new architectural models or external patterns to solve a problem if an existing, proven pattern is already used elsewhere in the codebase. You may only introduce new patterns if the problem is completely novel.
- **Testing Mandate:** Everything you do must be tested. Any new logic or bug fix must include corresponding unit or integration tests, and the test suite must pass completely.

### 5. Workflow & Backups
- **Continuous Commits:** After each isolated task or logical chunk of work is finished and tested, you must commit the changes.
- **Pushing for Backup:** Immediately push the committed changes to the remote repository to ensure there is a safe backup of your progress before starting the next chunk of work.
