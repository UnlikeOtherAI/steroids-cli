# Codex CLI Reference

> Maintained reference for Steroids' integration with OpenAI's Codex CLI.
> Last verified: 2026-02-21

## Quick Reference

| Field | Value |
|-------|-------|
| Binary | `codex` |
| Package | See https://openai.com/index/codex/ |
| Auth | `codex login` or `OPENAI_API_KEY` env var |
| Provider name | `codex` (registered as `openai` in legacy code) |
| Source file | `src/providers/codex.ts` |

**Note:** Codex IS OpenAI's development tool CLI. There is no separate `openai` CLI for coding tasks. The `openai` provider in the registry is a legacy duplicate — always use `codex`.

## Invocation

**Default Steroids template:**
```
cat {prompt_file} | {cli} exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
```

**Key flags:**
- `exec` — Execute mode (non-interactive)
- `--dangerously-bypass-approvals-and-sandbox` — Auto-approve all tool calls (required for automated use)
- `--skip-git-repo-check` — Allow running outside trusted git repos
- `-` — Read prompt from stdin
- `--json` — JSONL output (not used by default but needed for session ID extraction)
- `resume <thread_id>` — Resume a previous session

**Prompt delivery:** Piped via stdin (`cat file | codex exec ... -`). Tested working with 38KB prompts.

**Important:** Codex does not have a `--model` flag in `exec` mode. Model selection is handled by Codex's own configuration.

## Models

| ID | Full Name | Recommended For |
|----|-----------|-----------------|
| `codex` | Codex (default) | reviewer |

**Steroids defaults:** orchestrator=undefined, coder=undefined, reviewer=`codex`

Codex model selection is opaque — the CLI chooses the model internally. No `--model` flag for `exec` mode.

## Output Format

**Default (text):** Plain text output — just the assistant's response and tool execution output mixed together.

**With `--json`:** JSONL events on stdout:
```jsonl
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started",...}
{"type":"message.delta","content":"..."}
{"type":"turn.completed","usage":{"input_tokens":6528,"output_tokens":342,"cached_tokens":6528}}
{"type":"thread.completed",...}
```

### Session ID Extraction

Parse `thread_id` from the first JSONL line with `type: "thread.started"`. Requires `--json` flag.

### Token Usage Extraction

From `turn.completed` events:
```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 17024,
    "output_tokens": 156,
    "cached_tokens": 17024
  }
}
```

**Cached tokens observed:** 6,528 on first call, 17,024 on resume — Codex has built-in prompt caching.

## Session Management

| Field | Value |
|-------|-------|
| Resume command | `codex exec resume <thread_id>` |
| Session storage | `~/.codex/sessions/YYYY/MM/DD/` |
| Session ID format | UUID (`thread_id`) |
| History behavior | Full history replayed on resume |

**Resume workflow:** `codex exec resume <thread_id>` appends a new prompt to the existing thread. Full conversation context is preserved. Cached tokens make resumed sessions cheaper.

## Known Issues & Quirks

1. **Empty output on first attempt** — Occasionally produces 0 bytes stdout/stderr on first invocation. Retrying typically works. Possibly a cold-start issue.
2. **No `--model` flag in exec mode** — Model is selected by Codex internally, not by Steroids.
3. **`--json` changes behavior** — Adding `--json` for session ID extraction may subtly change output format. Current template uses text mode.
4. **Tool execution markers** — In text mode, Codex emits `exec\n<command>` patterns for tool calls. Steroids parses these for activity monitoring.
5. **stdin must be closed** — Like other CLIs, Codex hangs if stdin stays open after piping.

## Error Patterns

| Pattern | Error Type | Retryable |
|---------|-----------|-----------|
| "rate limit" / 429 in stderr | `rate_limit` | Yes (60s backoff) |
| "unauthorized" / "auth" in stderr | `auth_error` | No |
| "connection" / "timeout" in stderr | `network_error` | Yes |
| No output for 15 minutes | `subprocess_hung` | No (kill + retry) |

## Steroids Integration Notes

- **Activity timeout:** Resettable timer with same pattern as Claude provider.
- **Buffer cap:** 2MB stdout/stderr cap.
- **Env sanitization:** `OPENAI_API_KEY` stripped from child env to force CLI's own auth.
- **Tool parsing:** Best-effort parsing of `exec` / `<command>` patterns from stdout for activity monitoring.

### Improvement Backlog

- [ ] Switch to `--json` output for session ID and token extraction
- [ ] Add `resume <thread_id>` support via invocation template
- [ ] Investigate empty output issue — may need retry logic
- [ ] Add model selection once Codex supports `--model` in exec mode
