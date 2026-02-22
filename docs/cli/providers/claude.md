# Claude Code CLI Reference

> Maintained reference for Steroids' integration with Anthropic's Claude Code CLI.
> Last verified: 2026-02-21

## Quick Reference

| Field | Value |
|-------|-------|
| Binary | `claude` |
| Package | `brew install anthropic/tap/claude` |
| Auth | `claude login` (OAuth) or API key |
| Provider name | `claude` |
| Source file | `src/providers/claude.ts` |

## Invocation

**Default Steroids template:**
```
{cli} -p "$(cat {prompt_file})" --model {model} --output-format stream-json --verbose --dangerously-skip-permissions
```

**Key flags:**
- `-p "prompt"` — Print mode (non-interactive, outputs response and exits)
- `--model <alias>` — Model selection (accepts aliases: `opus`, `sonnet`, `haiku`)
- `--output-format stream-json` — JSONL output with structured events
- `--verbose` — Include token usage and cost in output
- `--dangerously-skip-permissions` — Bypass all permission checks (required for automated sessions; without this, Write/Edit/Bash tools require interactive approval that can't be granted)
- `--resume <session_id>` — Resume a previous session
- `--max-turns <N>` — Limit agentic turns

**Prompt delivery:** Shell expansion `$(cat {prompt_file})` — handles prompts up to ARG_MAX (~1MB). Tested working with 38KB prompts.

## Models

| ID (Alias) | Full Name | Recommended For |
|------------|-----------|-----------------|
| `opus` | Claude Opus (latest) | orchestrator, reviewer |
| `sonnet` | Claude Sonnet (latest) | coder |
| `haiku` | Claude Haiku (latest) | quick tasks |

**Steroids defaults:** orchestrator=`opus`, coder=`sonnet`, reviewer=`opus`

## Output Format

Uses `--output-format stream-json` producing JSONL events on stdout:

```jsonl
{"type":"system","subtype":"init","session_id":"<uuid>","model":"claude-opus-4-6",...}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]},"session_id":"<uuid>"}
{"type":"result","subtype":"success","result":"...","session_id":"<uuid>","total_cost_usd":0.0738,...}
```

**Key event types:**
- `system/init` — Session start, contains `session_id` and `model`
- `assistant` — Model response, content blocks (text + tool_use)
- `result` — Final summary, contains `result` text, `total_cost_usd`, and cumulative token counts

### Session ID Extraction

Parse `session_id` from any stream-json event (available in `init`, `assistant`, and `result` events). The `result` event is most reliable as it's guaranteed to appear.

### Token Usage Extraction

From the `result` event:
```json
{
  "type": "result",
  "total_cost_usd": 0.0738,
  "num_turns": 5,
  "session_id": "abc-123"
}
```

With `--verbose`, stderr contains detailed token breakdown including cached tokens:
```
input_tokens: 18110 (cache_read: 18110, cache_creation: 0)
output_tokens: 342
```

**Prompt caching is automatic** — on resumed sessions, previously seen tokens are served from cache at reduced cost. Observed: 18,110 cached read tokens on second invocation.

## Session Management

| Field | Value |
|-------|-------|
| Resume command | `claude -p "prompt" --resume <session_id>` |
| Session storage | `~/.claude/sessions/` |
| Session ID format | UUID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`) |
| History behavior | Full history replayed on resume |
| Prompt caching | Automatic — cached read tokens on resume |

**Resume workflow:** On resume, the full conversation history is available. The new prompt is appended as a continuation. System prompt is preserved from the original session. Prompt caching means resumed sessions cost significantly less.

## Known Issues & Quirks

1. **stdin must be closed immediately** — Claude CLI hangs if stdin pipe stays open (especially with `--verbose`). Steroids calls `child.stdin?.end()` right after spawn.
2. **`--verbose` required for token counts** — Without it, only `total_cost_usd` is available; no token breakdown.
3. **API key vs OAuth confusion** — If `ANTHROPIC_API_KEY` is in the environment, Claude uses it instead of OAuth. Steroids strips this via `getSanitizedCliEnv()`.
4. **Stream-json result event** — The `result` event's `result` field contains the final text. Steroids uses this as the definitive stdout, overriding streamed text.

## Error Patterns

| Pattern | Error Type | Retryable |
|---------|-----------|-----------|
| "rate limit" / 429 in stderr | `rate_limit` | Yes (60s backoff) |
| "unauthorized" / "auth" in stderr | `auth_error` | No |
| "Credit balance is too low" | `credit_exhaustion` | No |
| "context" / "token limit" in stderr | `context_exceeded` | No |
| No output for 15 minutes | `subprocess_hung` | No (kill + retry next cycle) |

## Steroids Integration Notes

- **Activity timeout:** Resettable timer — only kills on silence, not wall-clock time. Active tool execution resets the timer.
- **Buffer cap:** stdout/stderr capped at 2MB to prevent memory issues.
- **Env sanitization:** `ANTHROPIC_API_KEY` stripped from child env to force OAuth.
- **Stream-json parsing:** Extracts text content from assistant events, tool names from tool_use blocks, final result from result event.
- **Permission bypass:** `--dangerously-skip-permissions` required for automated sessions. Without it, Write/Edit/Bash tools require interactive approval.
- **Settings symlink:** `settings.json` is symlinked to the isolated HOME alongside `config.json` and `.credentials.json`, preserving user's tool allow-lists and permission mode.

### Improvement Backlog

- [ ] Extract `session_id` from stream-json and return in `InvokeResult`
- [ ] Extract token usage from `--verbose` stderr and return in `InvokeResult`
- [ ] Add `--resume {session_id}` support via invocation template
- [ ] Consider `--max-turns` for bounded execution
