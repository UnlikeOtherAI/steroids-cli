# Vibe CLI Reference (Mistral)

> Maintained reference for Steroids' integration with Mistral's Vibe CLI.
> Last verified: 2026-02-21 (source code analysis of Vibe v2.2.1)

## Quick Reference

| Field | Value |
|-------|-------|
| Binary | `vibe` |
| Package | `mistral-vibe` (installed via `uv` or `pip`) |
| Auth | `vibe --setup` or `MISTRAL_API_KEY` env var |
| Provider name | `mistral` |
| Source file | `src/providers/mistral.ts` |
| Vibe source | `~/.local/share/uv/tools/mistral-vibe/lib/python3.12/site-packages/vibe/` |
| Config | `~/.vibe/config.toml` |

## Invocation

**Default Steroids template:**
```
{cli} -p "$(cat {prompt_file})" --output text --max-turns 80 --agent auto-approve
```

**Key flags:**
- `-p "prompt"` — **Programmatic mode** (non-interactive, auto-approves tools, exits on completion)
- `--output text|json|streaming` — Output format (only works with `-p`)
- `--max-turns <N>` — Limit agent turns (default: no limit)
- `--max-price <$>` — Stop if cost exceeds threshold
- `--agent <name>` — Agent profile (`auto-approve` is default in `-p` mode)
- `--resume <session_id>` — Resume previous session (8-char prefix match)
- `--continue` / `-c` — Resume most recent session
- `--enabled-tools <tool>` — Whitelist specific tools (supports globs, regex)
- `--workdir <dir>` — Set working directory

**Prompt delivery:** Shell expansion `$(cat {prompt_file})`. Tested working with 37KB prompts.

### Critical: `-p` Flag is Required

**Without `-p`, Vibe enters interactive TUI mode and hangs indefinitely.** The positional `PROMPT` argument starts an interactive session, not programmatic mode.

```bash
vibe -p "$(cat file)"              # Correct: programmatic mode, auto-exits
vibe "$(cat file)"                 # WRONG: interactive mode, hangs
echo "prompt" | vibe               # WRONG: stdin not supported for prompts
```

**The `--agent auto-approve` flag in the Steroids template is redundant** — `-p` mode auto-approves by default (see `get_initial_agent_name()` in `cli/cli.py` line 26).

### Argument-Based Invocation (Safer)

When no custom template is set, Steroids uses argument-based spawning (no shell interpolation):

```typescript
spawn('vibe', ['-p', promptContent, '--output', 'text', '--max-turns', '80', '--agent', 'auto-approve'], { shell: false })
```

This avoids command injection through prompt content.

## Models

| Alias | API Model Name | Recommended For |
|-------|---------------|-----------------|
| `devstral-2` | `mistral-vibe-cli-latest` | orchestrator, coder, reviewer |
| `devstral-small` | `devstral-small-latest` | quick/cheap tasks |
| `local` | `devstral` (llamacpp) | offline development |

**Model selection mechanism:** Vibe has **no `--model` flag** (`--model` causes `error: unrecognized arguments`). Models are selected via environment variables:

```bash
# BOTH env vars required for runtime model injection:
VIBE_ACTIVE_MODEL=mistral-large-latest                    # Which model to use
VIBE_MODELS='[{"name":"mistral-large-latest","provider":"mistral","alias":"mistral-large-latest","input_price":0,"output_price":0}]'  # Model definition
```

**Critical (verified 2026-02-21):**
- `VIBE_ACTIVE_MODEL` alone fails if the model isn't already in `~/.vibe/config.toml` — `ValueError: Active model 'X' not found in configuration`
- `VIBE_MODELS` injects runtime model definitions, bypassing `config.toml` — this is the key mechanism
- BOTH env vars must be set together for reliable model selection
- Pre-configured models in `~/.vibe/config.toml`: `devstral-2`, `devstral-small`, `local`

Steroids injects both env vars in `getSanitizedCliEnv()`.

**Note:** The `MISTRAL_MODELS` list in `src/providers/mistral.ts` uses stale IDs (`codestral-latest`). The actual default model via Le Chat subscription is `devstral-2`.

### Pricing (per million tokens)

| Model | Input | Output |
|-------|-------|--------|
| devstral-2 | $0.40 | $2.00 |
| devstral-small | $0.10 | $0.30 |

## Output Format

**`--output text` (current default):** Final assistant message only. No structured data.

**`--output json`:** All messages as JSON array:
```json
[
  {"role": "user", "content": "...", "message_id": "uuid"},
  {"role": "assistant", "content": "...", "message_id": "uuid", "tool_calls": [...]},
  {"role": "tool", "content": "...", "name": "bash", "tool_call_id": "..."}
]
```

**`--output streaming`:** NDJSON, one message per line as produced (similar to Claude's `stream-json`).

### Session ID Extraction

Session ID is **NOT available in stdout**. Must scan the filesystem after invocation:

```
~/.vibe/logs/session/session_YYYYMMDD_HHMMSS_<uuid8>/meta.json
```

Find the most recently modified directory, read its `meta.json`:
```json
{
  "session_id": "85c9ed55-01cc-466e-b42f-e9e2ea1d1d5c",
  "stats": {
    "session_prompt_tokens": 14736,
    "session_completion_tokens": 18,
    "session_cost": 0.0059,
    "input_price_per_million": 0.4,
    "output_price_per_million": 2.0
  }
}
```

**When using `VIBE_HOME` isolation**, the session path becomes `$VIBE_HOME/logs/session/` — Steroids must track the `VIBE_HOME` it set for each runner.

### Token Usage Extraction

From `meta.json` (see above). Contains `session_prompt_tokens`, `session_completion_tokens`, and calculated `session_cost`.

## Session Management

| Field | Value |
|-------|-------|
| Resume command | `vibe -p "prompt" --resume <session_id>` |
| Session storage | `~/.vibe/logs/session/session_*_<uuid8>/` |
| Session ID format | UUID; resume accepts 8-char prefix partial match |
| History behavior | **Last 20 messages only** (`HISTORY_RESUME_TAIL_MESSAGES`) |
| Listing | No `--list-sessions` command ([issue #249](https://github.com/mistralai/mistral-vibe/issues/249)) |

**Resume workflow:** On resume, only the last 20 non-system messages are loaded. A fresh system prompt is regenerated (not from the old session). This windowing means early context may be lost on long sessions — delta prompts must be self-contained.

**Session isolation for parallel runners:** Set `VIBE_HOME` env var per runner to avoid session file collisions:
```bash
VIBE_HOME=/tmp/steroids-runner-1/.vibe vibe -p "prompt"
```

## Architecture Internals

Vibe's core is an async event-driven agent loop (`core/agent_loop.py`):

```
Prompt → AgentLoop._conversation_loop()
  ├─ Middleware (turn limits, price limits, auto-compact)
  ├─ LLM API call → parse response
  ├─ Tool calls? → execute tools → append results
  └─ Loop until no tool calls or limit hit
```

**Automatic context injection:** Every invocation, Vibe's system prompt includes:
- Directory tree (up to 1000 files, depth 3)
- Git status + 5 recent commits
- All tool descriptions
- AGENTS.md / VIBE.md content (if trusted)
- OS and shell info

This means Vibe sessions have more context than Steroids provides — some duplication with Steroids' own prompt context is expected and harmless. Do NOT include directory structure in Steroids' prompt for Vibe — it already has it.

**Built-in tools:**

| Vibe Tool | Claude Code Equivalent | Notes |
|-----------|----------------------|-------|
| `bash` | Bash | Sets `CI=true`, `NONINTERACTIVE=1`; 300s default timeout |
| `read_file` | Read | Max 64KB |
| `write_file` | Write | Max 64KB |
| `search_replace` | Edit | Fuzzy matching (0.9 threshold) |
| `grep` | Grep | Uses ripgrep, max 100 matches |
| `todo` | TaskCreate/Update | Built-in task tracking |
| `task` | Task (subagent) | Delegates to `explore` subagent (read-only) |
| `ask_user_question` | AskUserQuestion | **Auto-answered in `-p` mode** — no user input |

## Known Issues & Quirks

1. **`-p` required for non-interactive mode** — Positional prompt argument enters interactive TUI. This caused 100% CPU hangs in early testing.
2. **No `--list-sessions`** — Must scan filesystem for session IDs ([issue #249](https://github.com/mistralai/mistral-vibe/issues/249)).
3. **No built-in retry/backoff** — Rate limit errors fail immediately ([issue #264](https://github.com/mistralai/mistral-vibe/issues/264)).
4. **Rate limiting with vague errors** — Error messages don't always indicate rate limiting clearly ([issue #275](https://github.com/mistralai/mistral-vibe/issues/275)).
5. **Mid-task stopping** — Agent sometimes stops without error mid-file-write ([issue #261](https://github.com/mistralai/mistral-vibe/issues/261)).
6. **Stalls and gibberish output** — Occasional hangs with garbled output ([issue #174](https://github.com/mistralai/mistral-vibe/issues/174)).
7. **20-message session window** — Earlier context lost on resume for long sessions.
8. **Model list stale in Steroids** — `src/providers/mistral.ts` lists `codestral-latest` but actual model is `devstral-2`.
9. **`--agent auto-approve` redundant in `-p` mode** — Programmatic mode auto-approves by default.

## Error Patterns

| Pattern | Error Type | Retryable |
|---------|-----------|-----------|
| "active model * not found" in stderr | `model_not_found` | No |
| "mistral_api_key" / "missing * environment variable" | `auth_error` | No |
| 429 / rate limit | `rate_limit` | Yes (manual — no built-in backoff) |
| No output for 15 minutes | `subprocess_hung` | No (kill + retry) |

## Steroids Integration Notes

- **No activity timeout in provider** — Unlike Claude/Codex/Gemini, the Mistral provider uses a fixed timeout (15 min) rather than a resettable activity timer. This may kill active agents prematurely.
- **Dual spawn path:** Custom template uses shell spawning; default uses argument-based spawning (safer).
- **Env vars injected:** `VIBE_ACTIVE_MODEL`, `VIBE_MODELS` (JSON model config).
- **Env sanitization:** `MISTRAL_API_KEY` stripped from child env to force CLI's own auth.
- **No stream-json equivalent yet** — Using `--output text` means no structured monitoring. Switching to `--output streaming` would enable real-time NDJSON events.

### VIBE_HOME Isolation (CRITICAL)

Steroids uses `setupIsolatedHome('.vibe', [...])` to create an isolated VIBE_HOME per invocation. **Three files must be symlinked** or Vibe shows the onboarding TUI:

| File | Why Required |
|------|-------------|
| `.env` | **Critical** — contains Mistral API key. Without it, `VibeConfig.load()` raises `MissingAPIKeyError` → triggers `run_onboarding()` → animated TUI loops indefinitely |
| `config.toml` | Model definitions and settings |
| `trusted_folders.toml` | Folder trust allowlist |

**Path alignment:** `setupIsolatedHome('.vibe', ...)` places files at `isolatedHome/.vibe/`. Set `VIBE_HOME = isolatedHome + '/.vibe'` (not `isolatedHome`). The `.vibe` subdirectory IS the VIBE_HOME, not the parent.

```typescript
const isolatedHome = this.setupIsolatedHome('.vibe', ['.env', 'config.toml', 'trusted_folders.toml']);
const vibeHome = join(isolatedHome, '.vibe');  // VIBE_HOME points here
env.VIBE_HOME = vibeHome;
// Session logs at vibeHome/logs/session/ (not isolatedHome/logs/session/)
```

### Improvement Backlog

- [ ] Add resettable activity-based timeout (like Claude/Codex/Gemini providers)
- [ ] Update model list: replace `codestral-latest` with `devstral-2` + `devstral-small`
- [ ] Add `--max-price` safety net to default template
- [ ] Switch to `--output streaming` for structured monitoring
- [ ] Add rate limit error classification with `retryable: true`
- [ ] Extract session ID from filesystem `meta.json` post-invocation
- [ ] Consider `--enabled-tools read_file,grep,bash` for reviewer invocations (read-only)
- [ ] Add `VIBE_HOME` isolation for parallel runner support
- [ ] Remove redundant `--agent auto-approve` from template
