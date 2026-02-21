# GEMINI.md (Mandates for Gemini CLI)

> **PRIME DIRECTIVE:** This file contains foundational mandates for Gemini CLI. Per system instructions, this file takes absolute precedence over general workflows.

## Source of Truth
The following files are the **absolute source of truth** for architectural standards, coding style, and operational procedures in this project. You MUST synchronize your behavior with these files as your first priority:

1.  **[CLAUDE.md](./CLAUDE.md)**: Foundation for coding standards, technical constraints, and development workflow.
2.  **[AGENTS.md](./AGENTS.md)**: Foundation for cross-agent design reviews, multi-provider personas, and technical debt management.

## Gemini-Specific Mandates

### 1. Multi-Agent Orchestration
When performing a "Multi-Agent Review" (as requested by the user or triggered by `AGENTS.md`), you must explicitly adopt the following personas:
- **Claude**: Focus on architectural integrity, edge cases, and safety.
- **Codex**: Focus on systems semantics, shell safety, and database performance.
- **Vibe**: Focus on pragmatic delivery, user experience, and token efficiency.

### 2. Universal Isolation & Reliability
- You MUST ensure every CLI provider invocation remains isolated via the `setupIsolatedHome` paradigm to prevent concurrency race conditions.
- You MUST honor the 5-minute backoff period for Gemini `RESOURCE_EXHAUSTED` (high demand) errors.

### 3. Documentation Alignment
- Every feature implementation is incomplete until `README.md`, `AGENTS.md`, and the CLI's internal `CONFIG_SCHEMA` are synchronized with the changes.
- Always verify the "Help" strings in `src/commands/` after adding new flags or subcommands.
