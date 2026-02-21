# Gemini CLI Reference

> Maintained reference for Steroids' integration with Google's Gemini CLI.
> Last verified: 2026-02-21

## Quick Reference

| Field | Value |
|-------|-------|
| Binary | `gemini` (fallback: `gcloud`) |
| Package | `npm install -g @anthropic-ai/gemini-cli` or via Google Cloud SDK |
| Auth | `gemini login` or Google Cloud credentials |
| Provider name | `gemini` |
| Source file | `src/providers/gemini.ts` |

## Invocation

**Default Steroids template:**
```
{cli} -p "$(cat {prompt_file})" -m {model} --output-format stream-json
```

**Key flags:**
- `-p "prompt"` — Non-interactive print mode
- `-m <model>` — Model selection
- `--output-format stream-json` — JSONL output with structured events
- `--resume <session_id>` — Resume a previous session
- `--sandbox` — Enable sandboxed execution

**Prompt delivery:** Shell expansion `$(cat {prompt_file})`. Tested working with 38KB prompts.

### Flag Ordering Quirk (Important!)

Gemini CLI has a quirk with flag parsing. The `--output-format` flag must use `=` syntax when combined with `--prompt`:

```bash
# Works
gemini --prompt "text" --output-format=stream-json

# May fail (space-separated)
gemini --prompt "text" --output-format stream-json
```

The current Steroids template uses `-p` (short form) which avoids this issue.

## Models

| ID | Full Name | Recommended For |
|----|-----------|-----------------|
| `gemini-2.5-pro` | Gemini 2.5 Pro | orchestrator, coder, reviewer |
| `gemini-2.5-flash` | Gemini 2.5 Flash | quick tasks |
| `gemini-2.0-flash` | Gemini 2.0 Flash | legacy |

**Steroids defaults:** orchestrator=`gemini-2.5-pro`, coder=`gemini-2.5-pro`, reviewer=`gemini-2.5-pro`

**Note:** Gemini CLI may report a different internal model name (e.g., `auto-gemini-3`) in stream-json output than what was requested.

## Output Format

Uses `--output-format stream-json` producing JSONL events on stdout:

```jsonl
{"type":"init","timestamp":"...","session_id":"<uuid>","model":"auto-gemini-3",...}
{"type":"message","timestamp":"...","role":"assistant","content":"...","delta":true}
{"type":"tool_call","name":"edit_file","args":{...}}
{"type":"result","timestamp":"...","status":"success","stats":{"total_tokens":16866,"cached":3079,...}}
```

**Key event types:**
- `init` — Session start, contains `session_id` and resolved `model`
- `message` — Assistant response, `delta: true` for streaming chunks
- `tool_call` / `function_call` — Tool execution events
- `result` — Final summary with token stats

### Session ID Extraction

Parse `session_id` from the first JSONL line with `type: "init"`.

### Token Usage Extraction

From the `result` event:
```json
{
  "type": "result",
  "stats": {
    "total_tokens": 16866,
    "input_tokens": 14562,
    "output_tokens": 2304,
    "cached": 3079
  }
}
```

**Implicit caching:** Gemini automatically caches context. Observed 3,079 cached tokens on second invocation without any explicit caching configuration.

## Session Management

| Field | Value |
|-------|-------|
| Resume command | `gemini --resume <session_id>` |
| Session storage | `~/.gemini/tmp/<hash>/chats/` |
| Session ID format | UUID |
| History behavior | Full history replayed on resume |
| Caching | Implicit — cached tokens on resume |

**Resume workflow:** On resume, full conversation history is replayed. Implicit caching reduces cost on repeated context.

## Known Issues & Quirks

1. **Flag ordering sensitivity** — `--output-format` may need `=` syntax with certain flag combinations (see Invocation section).
2. **Model name mismatch** — Requested model (e.g., `gemini-2.5-pro`) may appear as different name in stream-json output (e.g., `auto-gemini-3`).
3. **gcloud fallback** — If `gemini` CLI is not found, Steroids checks for `gcloud`. The invocation template may need adjustment for gcloud.
4. **RESOURCE_EXHAUSTED error** — Can mean either rate limiting OR credit exhaustion. Steroids' error classifier distinguishes between the two.

## Error Patterns

| Pattern | Error Type | Retryable |
|---------|-----------|-----------|
| RESOURCE_EXHAUSTED + "quota" | `rate_limit` | Yes (60s backoff) |
| RESOURCE_EXHAUSTED + "billing" | `credit_exhaustion` | No |
| "unauthorized" / "auth" in stderr | `auth_error` | No |
| No output for 15 minutes | `subprocess_hung` | No (kill + retry) |

## Steroids Integration Notes

- **Activity timeout:** Resettable timer, same pattern as Claude.
- **Buffer cap:** 2MB stdout/stderr cap.
- **Env sanitization:** `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLOUD_API_KEY` stripped from child env.
- **Stream-json parsing:** Extracts text from message events, tool names from tool_call/function_call events, stats from result event.
- **gcloud fallback:** `isAvailable()` checks for `gemini` first, then `gcloud`.

### Improvement Backlog

- [ ] Extract `session_id` from stream-json `init` event and return in `InvokeResult`
- [ ] Extract token usage from `result` stats and return in `InvokeResult`
- [ ] Add `--resume {session_id}` support via invocation template
- [ ] Verify gcloud invocation template works as fallback
