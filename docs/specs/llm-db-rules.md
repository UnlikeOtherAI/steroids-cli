# Add Database Interaction Rules to `steroids llm` Output

## Goal

Add a prominent section to the `steroids llm` CLI output that warns AI agents and users to never interact with the steroids database directly.

## Rules to Add

Add a new section (e.g., `## DATABASE ACCESS RULES (CRITICAL)`) to the llm command output with these three rules:

1. **Never touch `.steroids/steroids.db` directly** — no raw SQL, no `sqlite3` commands
2. **Always use `steroids llm` CLI first** to learn how to interact with the system
3. **The database is managed exclusively through the steroids CLI** — all reads and writes go through CLI commands

## Location

The rules should appear near the top of the output, after the "WHAT IS STEROIDS" section but before the task state machine details. This ensures agents see it early before they start working.

## File to Modify

`src/commands/llm.ts` — the command that generates the LLM quick reference output.

## Acceptance Criteria

- Running `steroids llm` shows the new database rules section
- The section is visually prominent (uses CRITICAL marker)
- Rules are concise and unambiguous
- Existing sections are not modified
