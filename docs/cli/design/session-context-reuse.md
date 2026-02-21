# Session Context Reuse Across Invocations

> **Status:** Draft / Research
> **Created:** 2026-02-21
> **Problem:** Every coder/reviewer invocation starts from scratch, re-scanning the entire project and loading all documentation. This wastes tokens and time.

---

## Problem Statement

When Steroids invokes a coder or reviewer, each invocation is a **completely fresh CLI session**. The AI agent must:

1. Read the project's `CLAUDE.md` / `AGENTS.md` / configuration files
2. Scan the codebase to understand architecture
3. Read the specific files relevant to the task
4. Load rejection history and coordinator guidance from the prompt

For a reviewer especially, this means re-scanning the same project structure and docs on every single review cycle. If a task takes 5 rejection cycles, that's 5x coder + 5x reviewer = **10 fresh sessions** all re-reading the same project context.

**Estimated waste per cycle:** 50-80% of tokens go to project context that hasn't changed since the last invocation.

---

## Current Architecture

### How Invocations Work Today

```
┌─────────────┐     prompt file      ┌──────────────┐
│  Steroids   │ ──────────────────▶  │  CLI (fresh)  │
│  Orchestrator│                      │  claude -p    │
│             │ ◀──────────────────  │  codex exec   │
│             │     stdout/stderr     │  gemini       │
└─────────────┘                      │  vibe -p      │
                                     └──────────────┘
```

Each invocation:
- Writes the full prompt to a temp file
- Spawns a fresh CLI process (`claude -p`, `codex exec`, etc.)
- Captures stdout/stderr
- Cleans up the temp file

**No state persists between invocations.** The `InvokeResult` returns `{ success, exitCode, stdout, stderr, duration, timedOut }` — no session ID.

### Key Files

| File | Role |
|------|------|
| `src/providers/interface.ts` | `InvokeOptions` / `InvokeResult` — no session fields |
| `src/providers/claude.ts` | Fresh `claude -p` each time |
| `src/providers/codex.ts` | Fresh `codex exec` each time |
| `src/providers/gemini.ts` | Fresh `gemini` each time |
| `src/providers/mistral.ts` | Fresh `vibe -p` each time |
| `src/orchestrator/coder.ts` | Generates full prompt, invokes provider |
| `src/orchestrator/reviewer.ts` | Generates full prompt, invokes provider |

---

## Provider Session Capabilities

### CLI-Level Session Resumption

All four provider CLIs support resuming previous sessions:

| Provider | Resume Last | Resume by ID | Non-Interactive Resume | Session Storage |
|----------|------------|--------------|----------------------|-----------------|
| **Claude** | `claude -c` | `claude -r <id>` | `claude -p --resume <id> "msg"` | `~/.claude/sessions/` |
| **Codex** | `codex resume --last` | `codex resume <id>` | `codex exec resume <id> "msg"` | `~/.codex/sessions/YYYY/MM/DD/` |
| **Gemini** | `gemini --resume` | `gemini --resume <uuid>` | `gemini --prompt "msg" --resume <uuid>` | `~/.gemini/tmp/<hash>/chats/` |
| **Vibe** | `vibe -c` | `vibe --resume <id>` | `vibe -p --resume <id> "msg"` | `~/.vibe/logs/session/` (metadata); `~/.vibe/sessions/` (JSONL history) |

**Key detail:** When resumed, Claude, Codex, and Gemini replay the full conversation history internally — the AI model sees all previous messages, tool calls, and results. No re-scanning needed for context the agent already explored. **Exception: Vibe only loads the last 20 messages** on resume (`HISTORY_RESUME_TAIL_MESSAGES`), so earlier context may be lost in long sessions.

**Claude specifics:**
- `--output-format json` includes `session_id` in the response
- `--fork-session` creates a new session branched from an existing one
- `--no-session-persistence` disables saving (print mode only)

**Codex specifics:**
- Sessions stored as JSONL rollout files
- `codex fork` creates a branch of a session
- `--ephemeral` flag disables session persistence

**Gemini specifics:**
- Auto-records sessions via `ChatRecordingService`
- Also has manual checkpoints via `/chat save <tag>`
- `--list-sessions` to enumerate saved sessions

**Vibe (Mistral) specifics:**
- CLI binary is `vibe` (package is `mistral-vibe`)
- `--continue` / `-c` resumes most recent session; `--resume SESSION_ID` resumes by ID (supports partial matching)
- Sessions stored as JSONL in `~/.vibe/sessions/` (configurable via `VIBE_HOME` env var)
- Prints session ID (first 8 chars) on exit — usable with `--resume`
- Output formats: `--output text|json|streaming` (session ID is NOT in any stdout format — must use filesystem)
- Session windowing: only loads last 20 messages on resume (`HISTORY_RESUME_TAIL_MESSAGES`), loads more on demand
- **No `--list-sessions` flag** — [known gap (issue #249)](https://github.com/mistralai/mistral-vibe/issues/249). Must use `--continue` or remember the session ID from exit output
- Has `--max-price DOLLARS` for cost ceiling and `--max-turns N` for turn limits — useful for automation safety

### API-Level Token Savings

Beyond CLI session resumption, each provider offers API-level caching:

#### Anthropic — Prompt Caching + Compaction

**Prompt Caching:**
- Mark content blocks with `cache_control: { type: "ephemeral" }` or `{ type: "ephemeral", ttl: "1h" }`
- Cached reads cost **10% of normal input price** (90% savings)
- Default 5-min TTL (refreshed on use), or 1-hour TTL (2x write cost)
- Minimum 4096 tokens for Opus, 1024 for Sonnet

**Context Compaction (Beta `compact-2026-01-12`):**
- Server-side summarization when context exceeds threshold
- Returns compaction block to pass back in subsequent requests
- Effectively infinite conversations without growing token count

**Relevance to Steroids:** Not directly usable from CLI invocations (the CLI handles this internally), but relevant if we ever move to direct API calls.

#### OpenAI — Conversations API + Compaction

**Conversations API:**
- Create persistent conversation objects (no TTL — indefinite)
- Reference by `conversation_id` across requests
- Server stores all messages — no need to re-send history

**`previous_response_id`:**
- Chain responses without managing message arrays
- All previous tokens still billed as input

**Compaction:**
- Server-side via `compact_threshold` parameter
- Standalone `/responses/compact` endpoint for manual compaction

**Relevance to Steroids:** Codex CLI likely uses these internally. Session resumption via CLI is the practical interface.

#### Google Gemini — Context Caching

**Explicit Context Caching:**
- Create a `cachedContents` resource with system instructions + large documents
- Reference by cache name in subsequent requests
- Configurable TTL (default 60 min)
- 90% discount on cached reads (Gemini 2.5), 75% (Gemini 2.0)

**Implicit Caching:**
- Automatic, no configuration needed
- Google detects repeated content prefixes

**Relevance to Steroids:** Could cache project-level context (docs, architecture) as a `cachedContents` resource if using Gemini API directly.

#### Mistral — Conversations API (Beta)

Mistral has a Beta Conversations API providing server-side session persistence:

**Conversations API:**
- `POST /v1/conversations` — create a new conversation
- `POST /v1/conversations/{id}` — append to existing conversation (server retains full history)
- `GET /v1/conversations/{id}/history` — retrieve full conversation history
- `POST /v1/conversations/{id}/restart` — branch from a specific entry point
- `store: false` for ephemeral conversations not persisted server-side

**Key advantage:** Full conversation history is retained server-side. On each append, the model receives the entire history plus new inputs — no need to resend previous messages. This is similar to OpenAI's Conversations API.

**No prompt caching:** Mistral does not have a public prompt caching API comparable to Anthropic's `cache_control` or Google's `cachedContents`. The Conversations API achieves a similar goal through server-side context persistence.

**Prefix feature:** Mistral has a `prefix` parameter on assistant messages to prepend content to model responses. This is for output steering, not caching, but could reduce verbose system prompt overhead.

**Relevance to Steroids:** The Vibe CLI likely uses the Conversations API internally. Session resumption via CLI is the practical interface. Direct API integration would be a future optimization.

---

## Proposed Design

### Approach: CLI Session Resumption

The most practical approach is to **resume CLI sessions** rather than managing API-level caching. This works with the existing architecture (CLI-based invocation) and leverages what each provider already does well.

### Core Concept

Instead of a single invocation per task cycle, maintain a **session chain**:

```
Task Cycle 1 (Coder):
  claude -p "code the feature" --output-format stream-json
  → captures session_id: "abc123"
  → stores session_id in task_invocations

Task Cycle 2 (Coder, after rejection):
  claude -p --resume "abc123" "reviewer rejected because X, fix Y"
  → continues in same session (all previous context preserved)
  → captures new session_id (or same one)
```

The coder doesn't need to re-read the entire project — it already did that in cycle 1. The follow-up prompt only needs to contain the **delta**: what the reviewer said and what to fix.

### Architecture Changes

#### 1. Extend `InvokeResult` with Session ID

```typescript
export interface InvokeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  // NEW: Session ID from the provider CLI (if available)
  sessionId?: string;
}
```

#### 2. Extend `InvokeOptions` with Resume Session

```typescript
export interface InvokeOptions {
  model: string;
  timeout?: number;
  cwd?: string;
  promptFile?: string;
  role?: 'orchestrator' | 'coder' | 'reviewer';
  invocationTemplate?: string;
  streamOutput?: boolean;
  onActivity?: (activity: InvocationActivity) => void;
  // NEW: Resume a previous session instead of starting fresh
  resumeSessionId?: string;
}
```

#### 3. Provider-Specific Resume Templates

Each provider needs a **resume invocation template** alongside the standard one:

**Claude:**
```
# Standard (fresh session)
{cli} -p "$(cat {prompt_file})" --model {model} --output-format stream-json --verbose

# Resume (continue session)
{cli} -p "$(cat {prompt_file})" --resume {session_id} --model {model} --output-format stream-json --verbose
```

**Codex:**
```
# Standard
cat {prompt_file} | {cli} exec --dangerously-bypass-approvals-and-sandbox -

# Resume
cat {prompt_file} | {cli} exec resume {session_id} --dangerously-bypass-approvals-and-sandbox -
```

**Gemini:**
```
# Standard (current template already uses stream-json)
{cli} -p "$(cat {prompt_file})" -m {model} --output-format stream-json

# Resume (continue session)
{cli} --output-format=stream-json -m {model} --resume {session_id} --prompt "$(cat {prompt_file})"
```

**Vibe (Mistral):**
```
# Standard (current template)
{cli} -p "$(cat {prompt_file})" --output text --max-turns 80 --agent auto-approve

# Resume (continue session)
{cli} -p "$(cat {prompt_file})" --resume {session_id} --output text --max-turns 80 --agent auto-approve
```

Note: Vibe uses env vars `VIBE_ACTIVE_MODEL` and `VIBE_MODELS` for model selection rather than a `--model` flag. The Steroids Mistral provider already sets these.

#### 4. Session ID Extraction (All Verified 2026-02-21)

Each provider emits the session ID differently. All four have been **tested with actual round-trip invocations** (initial prompt → extract session ID → resume → verify recall).

##### Claude — Parse `session_id` from stream-json events (VERIFIED)

**Tested:** `claude -p "hi remember number 456" --output-format stream-json --verbose` → resumed by UUID → correctly recalled **456**.

**Important:** `--output-format stream-json` requires `--verbose` flag in print mode. Without it, Claude errors: `"When using --print, --output-format=stream-json requires --verbose"`.

**Actual output structure (3 events):**
```json
{"type":"system","subtype":"init","session_id":"1b555142-f6dd-42ce-a9b1-9fed07e5b85b","model":"claude-opus-4-6","tools":[...],...}
{"type":"assistant","message":{"content":[{"type":"text","text":"Got it — 456."}],...},"session_id":"1b555142-f6dd-42ce-a9b1-9fed07e5b85b"}
{"type":"result","subtype":"success","result":"Got it — 456.","session_id":"1b555142-f6dd-42ce-a9b1-9fed07e5b85b","total_cost_usd":0.0738,"usage":{...}}
```

**Session ID appears in ALL three event types** — `init`, `assistant`, and `result`. Easiest to grab from `init` (first line) or `result` (last line).

**Resume:** `claude -p "what number?" --resume "1b555142-f6dd-42ce-a9b1-9fed07e5b85b" --output-format stream-json --verbose` → same session_id, response: **456**.

**Extraction:** In `parseStreamJsonLine()` (already in `claude.ts`), capture `event.session_id` from any event type:

```typescript
if (event.type === 'result') {
  sessionId = event.session_id;  // ← NEW: capture this
  return { result: typeof event.result === 'string' ? event.result : '' };
}
```

**Bonus:** Usage shows `cache_read_input_tokens: 18110` — Claude already does prompt caching automatically. On resume, the bulk of context is cached.

**Testing note:** `claude -p` cannot be invoked from inside a running Claude Code session (detects nested sessions). Must background the process or run from a separate terminal. In Steroids production this is not an issue — invocations run as independent processes.

**Confidence:** High. Fully verified with round-trip test.

##### Codex — Parse `thread.started` from `--json` JSONL (VERIFIED)

**Tested:** `codex exec --json "hi, remember number 456"` → resumed → correctly recalled 456.

Our current Codex template uses plain text mode. Switch to `--json` mode. The **first JSONL line** on stdout is always:

```json
{"type":"thread.started","thread_id":"019c8110-5fda-72d2-87e5-36225441d502"}
```

The actual agent response comes as subsequent JSONL events:
```json
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Got it: `456`."}}
{"type":"turn.completed","usage":{"input_tokens":10629,"cached_input_tokens":6528,"output_tokens":36}}
```

Resume command: `codex exec resume "019c8110-5fda-72d2-87e5-36225441d502" --json "what number?"` → returned `456`.

**Required template change:**
```
# OLD (no session ID available)
cat {prompt_file} | {cli} exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -

# NEW (session ID in first JSONL line)
cat {prompt_file} | {cli} exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
```

**Extraction:** Parse JSONL line-by-line. First line with `type === "thread.started"` → capture `thread_id`. Lines with `item.type === "agent_message"` → accumulate as stdout.

**Fallback:** In normal (non-JSON) mode, Codex prints `session id: <UUID>` to stderr in a header block.

**Bonus:** Token usage shows `cached_input_tokens` — Codex already does server-side caching (6,528 of 10,629 input tokens cached on first call; 17,024 of 25,255 cached on resume).

**Confidence:** High. Fully verified with round-trip test. UUID v7 format.

##### Gemini — Parse from `-o stream-json` init event (VERIFIED)

**Tested:** `gemini --output-format=stream-json --prompt "hi remember number 456"` → resumed by UUID → correctly recalled "the number **456**".

**Actual output from test (stream-json mode):**
```json
{"type":"init","timestamp":"2026-02-21T16:41:52.737Z","session_id":"e90c60eb-d590-4ed3-b041-8cd470afbb8d","model":"auto-gemini-3"}
{"type":"message","timestamp":"...","role":"user","content":"hi remember number 456"}
{"type":"message","timestamp":"...","role":"assistant","content":"I've noted the number 456...","delta":true}
{"type":"result","timestamp":"...","status":"success","stats":{"total_tokens":16866,"input_tokens":15784,"output_tokens":149,"cached":3079,"duration_ms":13874}}
```

Resume: `gemini --output-format=stream-json --prompt "what number?" --resume "e90c60eb-..."` → same `session_id` in init event, response: "the number **456**".

**Important syntax note:** Gemini CLI is picky about flag ordering. Use `--prompt "text"` (not `-p "text"` with other flags after). The `--output-format=stream-json` flag must use `=` or `--output-format stream-json` with the full flag name. Tested with Gemini v0.29.5.

**Required template change:**
```
# OLD (current template — already uses stream-json, session ID available in init event)
{cli} -p "$(cat {prompt_file})" -m {model} --output-format stream-json

# NEW (resume — use full flag names with = syntax to avoid flag-ordering bugs)
{cli} --output-format=stream-json -m {model} --resume {session_id} --prompt "$(cat {prompt_file})"
```

**Note:** The current Gemini template already uses `--output-format stream-json`, so session IDs are already extractable. The only change needed is adding `--resume` for the resume path.

**Extraction:** Parse first JSONL line with `type === "init"` → capture `session_id`.

**Note:** `-o text` mode emits **no session ID at all**. Must use a structured format.

**Bonus:** Stats show `cached: 3079` tokens — Gemini does implicit caching automatically.

**Confidence:** High. Fully verified with round-trip test. Standard UUID format.

##### Vibe (Mistral) — Session ID NOT in Structured Output (Verified 2026-02-21)

**Tested:** Session ID is **NOT included** in `--output json` or `--output streaming` stdout. Both formats return conversation messages only, no session metadata.

**Where session IDs actually live:** `~/.vibe/logs/session/session_<YYYYMMDD>_<HHMMSS>_<short_id>/meta.json`

**Extraction: Filesystem scan after invocation (only reliable method):**

```typescript
// Scan ~/.vibe/logs/session/ for most recently created session
const sessionsDir = path.join(os.homedir(), '.vibe', 'logs', 'session');
const dirs = fs.readdirSync(sessionsDir)
  .filter(d => d.startsWith('session_'))
  .sort().reverse(); // newest first (YYYYMMDD_HHMMSS in name)
const metaPath = path.join(sessionsDir, dirs[0], 'meta.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
const sessionId = meta.session_id; // full UUID
```

**Tested round-trip (2026-02-21):**
```
# Step 1: Initial session
$ vibe -p "hi, remember number 456" --output json --max-turns 5
→ stdout: conversation messages only (NO session ID)
→ Session ID found in: ~/.vibe/logs/session/session_20260221_163756_61a31785/meta.json
→ session_id: "61a31785-5a70-47e9-928d-8515535ba2fd"

# Step 2: Resume by ID (partial match works!)
$ vibe -p "what number?" --resume 61a31785 --output json --max-turns 5
→ Response: "456" ✓

# Step 3: --continue also works (resumes most recent)
$ vibe -p "what number?" --continue --output json --max-turns 5
→ Response: "456" ✓
```

**Vibe caveat:** Session windowing loads only the last 20 messages on resume (`HISTORY_RESUME_TAIL_MESSAGES = 20`). For long coder sessions with many tool calls, earlier context may not be in the active window. This is different from Claude/Codex/Gemini which replay the full history. Need to test whether the windowed context is sufficient for our delta-prompt approach.

**Confidence:** High for resume. Medium for extraction (filesystem scan is reliable but feels fragile — depends on Vibe's internal directory structure not changing).

#### Token Usage Extraction (All Verified 2026-02-21)

Each provider reports token usage in its structured output. Steroids should capture this data alongside session IDs to track cost savings from session reuse.

##### Claude — Token Usage in `result` Event

From the `type: "result"` event in stream-json output:

```json
{
  "type": "result",
  "total_cost_usd": 0.07350125,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 10285,
    "cache_read_input_tokens": 18110,
    "output_tokens": 6,
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 10285,
      "ephemeral_5m_input_tokens": 0
    }
  }
}
```

**Key fields:**
- `total_cost_usd` — Total cost for the invocation
- `usage.input_tokens` — New (non-cached) input tokens
- `usage.cache_read_input_tokens` — Tokens served from cache (90% cheaper)
- `usage.cache_creation_input_tokens` — Tokens written to cache (25% surcharge)
- `usage.output_tokens` — Output tokens generated

**Observation:** On resume, `cache_read_input_tokens` (18,110) dwarfs `input_tokens` (3) — Claude's prompt caching is already active. Session reuse with delta prompts would reduce even the cached token count.

##### Codex — Token Usage in `turn.completed` Event

From the `type: "turn.completed"` JSONL event:

```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 10629,
    "cached_input_tokens": 6528,
    "output_tokens": 36
  }
}
```

On resume:
```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 25255,
    "cached_input_tokens": 17024,
    "output_tokens": 62
  }
}
```

**Key fields:**
- `usage.input_tokens` — Total input tokens (includes cached)
- `usage.cached_input_tokens` — Subset served from server-side cache
- `usage.output_tokens` — Output tokens generated

**Observation:** On resume, `cached_input_tokens` increased from 6,528 to 17,024 — the conversation history from the initial session is being cached server-side. No separate cost field; use OpenAI pricing to compute.

##### Gemini — Token Usage in `result` Event Stats

From the `type: "result"` event in stream-json output:

```json
{
  "type": "result",
  "status": "success",
  "stats": {
    "total_tokens": 16866,
    "input_tokens": 15784,
    "output_tokens": 149,
    "cached": 3079,
    "duration_ms": 13874
  }
}
```

On resume:
```json
{
  "type": "result",
  "stats": {
    "total_tokens": 9841,
    "input_tokens": 9511,
    "output_tokens": 43,
    "cached": 3079,
    "duration_ms": 6780
  }
}
```

**Key fields:**
- `stats.total_tokens` — Total token count
- `stats.input_tokens` — Input tokens
- `stats.output_tokens` — Output tokens
- `stats.cached` — Tokens served from implicit cache
- `stats.duration_ms` — Wall-clock duration

**Observation:** Resume was ~40% fewer total tokens (16,866 → 9,841) and ~50% faster (13.8s → 6.8s). The `cached` count stayed constant at 3,079, suggesting Gemini's implicit caching covers system/project context.

##### Vibe (Mistral) — Token Usage in `meta.json` Only

Token usage is **NOT available in stdout** for any output mode (`text`, `json`, `streaming`). Must read from the session's `meta.json` file on disk:

```json
// ~/.vibe/logs/session/session_20260221_165157_2251efdb/meta.json
{
  "session_id": "2251efdb-d316-44aa-b9ef-e1e621684442",
  "stats": {
    "session_prompt_tokens": 14736,
    "session_completion_tokens": 18,
    "context_tokens": 14754,
    "session_cost": 0.005930400000000001,
    "input_price_per_million": 0.4,
    "output_price_per_million": 2.0
  }
}
```

**Key fields:**
- `stats.session_prompt_tokens` — Input tokens for the session
- `stats.session_completion_tokens` — Output tokens
- `stats.context_tokens` — Total context size
- `stats.session_cost` — Total cost in USD
- `stats.input_price_per_million` / `stats.output_price_per_million` — Per-token pricing

**Extraction:** Same filesystem scan used for session ID. Read `meta.json` from the most recently created `~/.vibe/logs/session/session_*` directory.

##### Token Usage Comparison (Single "Remember 456" Test)

| Provider | Input Tokens | Cached/Read | Output Tokens | Cost | Source |
|----------|-------------|-------------|---------------|------|--------|
| **Claude** | 3 (new) | 18,110 (read) + 10,285 (created) | 6 | $0.0735 | `result` event in stream-json |
| **Codex** | 10,629 | 6,528 cached | 36 | — | `turn.completed` JSONL event |
| **Gemini** | 15,784 | 3,079 cached | 149 | — | `result` event stats |
| **Vibe** | 14,736 | — | 18 | $0.0059 | `meta.json` on disk |

**Note:** Costs vary by model tier. Claude used Opus 4.6 ($15/$75 per MTok), Vibe used Mistral's pricing ($0.40/$2.00 per MTok). These are not comparable — the table shows extraction methods, not cost benchmarks.

##### Proposed `InvokeResult` Extension for Token Usage

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;   // Codex, Gemini
  cacheReadTokens?: number;     // Claude
  cacheCreationTokens?: number; // Claude
  totalCostUsd?: number;        // Claude, Vibe
}

export interface InvokeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  sessionId?: string;     // NEW: for session reuse
  tokenUsage?: TokenUsage; // NEW: for cost tracking
}
```

##### Summary: What Changes Are Needed Per Provider

| Provider | Current Template | Change Needed | Session ID Source | Resume Flag | Verified |
|----------|-----------------|---------------|-------------------|-------------|----------|
| **Claude** | `stream-json --verbose` ✓ | Add `--resume {id}` for resume path only | Any event → `session_id` (init, assistant, or result) | `--resume <uuid>` | Yes — round-trip ✓ |
| **Codex** | Plain text | Switch to `--json` + add `resume {id}` subcommand | `thread.started` event → `thread_id` | `resume <uuid>` (subcommand) | Yes — round-trip ✓ |
| **Gemini** | `stream-json` ✓ | Add `--resume {id}` for resume path only | `init` event → `session_id` | `--resume <uuid>` | Yes — round-trip ✓ |
| **Vibe** | `--output text` | Add `--resume {id}` for resume path; filesystem scan for extraction | Filesystem: `~/.vibe/logs/session/*/meta.json` | `--resume <8-char-prefix>` | Yes — round-trip ✓ |

#### 5. Database: Store Session ID Per Invocation

Add columns to `task_invocations` table. Per the repo's migration system, this requires a numbered SQL file + `migrations/manifest.json` update:

```sql
-- migrations/NNN_add_session_context.sql
-- UP
ALTER TABLE task_invocations ADD COLUMN session_id TEXT;
ALTER TABLE task_invocations ADD COLUMN resumed_from_session_id TEXT;
ALTER TABLE task_invocations ADD COLUMN invocation_mode TEXT DEFAULT 'fresh'; -- 'fresh' | 'resume'
ALTER TABLE task_invocations ADD COLUMN token_usage_json TEXT; -- JSON blob of TokenUsage
CREATE INDEX idx_invocations_session ON task_invocations(session_id);

-- DOWN
-- SQLite cannot DROP COLUMN; recreate table without new columns
```

**Note:** `invocation_mode` and `resumed_from_session_id` track the session chain lineage. `token_usage_json` stores the provider-specific token data for cost analysis.

#### 6. Orchestrator Logic: When to Resume vs. Fresh

The coder/reviewer orchestrators decide whether to resume or start fresh:

```
shouldResume(task, role):
  1. Find last successful invocation for (task_id, role, provider, model) ordered by id DESC
  2. If no previous invocation → fresh session
  3. If previous invocation has a session_id:
     a. Check provider + model + role all match current config
     b. Check session age < TTL (default 30 min)
     c. Check task context hasn't changed substantially
        (e.g., new coordinator guidance = probably fresh)
     d. Check previous invocation was successful (not error/timeout)
     e. If all valid → resume with delta prompt
     f. If any invalid → fresh session
  4. If provider doesn't support resume → always fresh
```

**When to always start fresh:**
- First invocation for a task
- Provider or model changed since last invocation
- Task was manually restarted (rejection count reset)
- Coordinator issued a major scope change
- Session is older than a configurable TTL (e.g., 30 minutes)
- Previous session ended in error/timeout
- Reviewer signals "context reset" (coder is lost, start over)

**When to resume:**
- Same provider, same task, previous session succeeded
- Only the rejection feedback changed
- Within the session TTL window

#### 7. Delta Prompts for Resumed Sessions

When resuming, the prompt should be **much shorter** — just the new information:

**Coder resume prompt (instead of full regeneration):**
```
The reviewer rejected your last submission.

Rejection #3 notes:
"The error handling in auth.ts doesn't cover the case where the token
is expired. Also missing a test for the happy path."

Fix these issues and resubmit.
```

**Reviewer resume prompt (instead of full regeneration):**
```
The coder has submitted a new attempt. Here is the diff since last review:

<git diff>

Previous rejection notes you gave:
"Missing error handling for expired tokens, missing happy path test."

Review this new submission. Has the coder addressed your feedback?
```

Compare this to today's prompts which include the full task spec, all project context, coding standards, etc.

**Important:** Even in delta prompts, always include a minimal **role and objective** preamble (e.g., "You are a code reviewer for task T-123. Your job is to verify the coder's submission meets the specification."). The resumed session has the original context, but the model needs to re-anchor its purpose — especially for providers like Vibe that window to the last 20 messages and may have lost the original system framing.

### Session Chain Lifecycle

```
Task: "Add auth token refresh"
├── Coder Session Chain
│   ├── Invocation 1 (FRESH): Full prompt + project context
│   │   └── session_id: "coder-abc"
│   ├── Invocation 2 (RESUME "coder-abc"): Delta prompt (rejection feedback)
│   │   └── session_id: "coder-abc" (same session)
│   └── Invocation 3 (RESUME "coder-abc"): Delta prompt (2nd rejection)
│       └── session_id: "coder-abc" (same session)
│
├── Reviewer Session Chain
│   ├── Invocation 1 (FRESH): Full prompt + project context + diff
│   │   └── session_id: "reviewer-xyz"
│   ├── Invocation 2 (RESUME "reviewer-xyz"): Delta prompt (new diff)
│   │   └── session_id: "reviewer-xyz" (same session)
│   └── Invocation 3 (RESUME "reviewer-xyz"): Delta prompt (final diff)
│       └── session_id: "reviewer-xyz" (same session)
│
└── Coordinator (always fresh — infrequent, needs clean perspective)
```

### Estimated Token Savings

| Scenario | Today (fresh each time) | With Session Reuse |
|----------|------------------------|--------------------|
| Coder invocation 1 | ~15,000 tokens (full context) | ~15,000 tokens (first is always fresh) |
| Coder invocations 2–5 | 4 × ~15,000 = ~60,000 tokens | 4 × ~2,000 = ~8,000 tokens (delta only) |
| Reviewer invocation 1 | ~12,000 tokens | ~12,000 tokens |
| Reviewer invocations 2–5 | 4 × ~12,000 = ~48,000 tokens | 4 × ~3,000 = ~12,000 tokens (new diff only) |
| **5-cycle task total** | **~135,000 tokens** | **~47,000 tokens** |
| **Savings** | — | **~65% reduction** |

These are conservative estimates. For large projects with extensive documentation, savings could be higher.

---

## Open Questions

### 1. Session Validity & Staleness

How long should a session be considered "resumable"? Provider CLIs store sessions locally, but the AI's context window has limits. A session from 2 hours ago might have been evicted from server-side caches.

**Proposed:** Default 30-minute TTL for session reuse. Configurable via `config.yaml`:
```yaml
ai:
  session:
    reuseTtlMinutes: 30
    enabled: true
```

### 2. Session ID Extraction Reliability

All four providers have been verified for session ID extraction (2026-02-21). Claude, Codex, and Gemini emit session IDs in structured JSONL output. Vibe requires a filesystem scan of `~/.vibe/logs/session/*/meta.json`.

**Fallback:** If session ID extraction fails, silently fall back to fresh sessions. Never let session management failures block task execution. Vibe's filesystem-based extraction is the most fragile — internal directory structure could change between versions.

### 3. Context Window Growth

When resuming, the session's context grows with each turn. After 5 rejections, the accumulated context might approach the model's limit. Need a strategy for when to "reset" and start fresh.

**Proposed:** If a resumed session returns a `context_exceeded` error, automatically retry with a fresh session.

### 4. Provider Switching Mid-Task

If the user changes the coder provider mid-task (e.g., from Claude to Codex), session resumption is impossible. The new provider doesn't have the old provider's session.

**Proposed:** Detect provider change → always fresh session. Store provider name alongside session ID.

### 5. Parallel Runners

If multiple runners process tasks concurrently, sessions are per-runner. This is fine — each runner maintains its own session chains. No cross-runner session sharing needed.

### 6. Forking vs. Resuming

Claude and Codex both support **forking** sessions (creating a branch). This could be useful for the reviewer — fork the coder's session so the reviewer starts with all the coder's context without modifying the coder's session.

**Status:** Interesting but adds complexity. Defer to v2.

### 7. CLI vs. API Direct Calls

Session reuse via CLI is the pragmatic first step. But for maximum token savings, direct API calls with prompt caching (Anthropic) or Conversations API (OpenAI) would be even more efficient. This would be a larger architectural change.

**Status:** CLI-level session reuse first. Direct API integration as a future phase.

### 8. Session File Cleanup / Garbage Collection

Provider CLIs accumulate session files on disk (`~/.claude/sessions/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, `~/.vibe/logs/session/`). With high task throughput, these can grow unbounded.

**Open questions:**
- Should Steroids clean up sessions it created after task completion?
- Should there be a `steroids sessions prune` command?
- What's the retention policy — keep for N days? Keep only the latest per task?
- How to handle `VIBE_HOME` isolation directories — prune per-runner homes after runner stops?

**Proposed:** Add a configurable retention policy (default: 7 days). Run cleanup on daemon startup or as part of `steroids runners wakeup`. Only delete sessions Steroids created (tracked by `session_id` in `task_invocations`).

### 9. Reviewer "Context Reset" Signal

Sometimes the coder gets fundamentally lost — wrong approach, wrong files, misunderstood spec. Resuming the session just continues the confused context. The reviewer should be able to signal "start over" to force a fresh session.

**Proposed:** Add a structured signal in reviewer output (e.g., `CONTEXT_RESET: true` in the rejection JSON). When the coder orchestrator sees this, it discards the session chain and starts a fresh invocation with the full prompt. This is distinct from a normal rejection (which resumes with delta feedback).

---

## Implementation Phases

### Phase 1: Infrastructure (Low Risk)

1. Add `sessionId` and `tokenUsage` to `InvokeResult`; add `resumeSessionId` to `InvokeOptions`
2. Add `session_id`, `resumed_from_session_id`, `invocation_mode`, and `token_usage_json` columns to `task_invocations` table (migration + manifest update)
3. Extract session IDs from Claude's stream-json output (most reliable provider to start with)
4. Extract token usage from provider output (Claude `result` event, Codex `turn.completed`, Gemini `result` stats, Vibe `meta.json`)
5. Store session IDs and token usage in database alongside invocations
6. Add `{session_id}` placeholder support to `buildCommand()` for resume templates
7. Add provider-level `resume(sessionId, prompt)` method alongside existing `invoke()` — each provider implements its own resume command construction

**No behavior change yet** — just capturing the data and preparing the resume interface.

### Phase 2: Claude Session Resumption

1. Implement resume template for Claude provider
2. Add `shouldResume()` logic in coder orchestrator
3. Create delta prompt generators for coder (resumed) and reviewer (resumed)
4. Add session TTL configuration
5. Implement fallback: `context_exceeded` on resume → retry fresh

**Claude first** because its session ID extraction is most reliable (JSON output).

### Phase 3: Codex + Gemini + Vibe Session Resumption

1. Implement session ID extraction for Codex (JSONL parsing)
2. Implement session ID extraction for Gemini
3. Implement session ID extraction for Vibe (exit output or filesystem scan)
4. Add resume templates for all three providers
5. Validate non-interactive resume works for each
6. **Vibe-specific:** Test session windowing (20-message limit) — verify delta prompts work within the windowed context

### Phase 4: Delta Prompts

1. Create `generateResumingCoderDeltaPrompt()` — rejection feedback only
2. Create `generateResumingReviewerDeltaPrompt()` — new diff + previous notes
3. A/B test: compare full prompts vs. delta prompts on task success rate
4. Tune the balance — too little context in delta = confused agent

### Phase 5: Advanced (Future)

1. Session forking for reviewer (fork coder's session)
2. Direct API integration for Anthropic prompt caching
3. Gemini API context caching for project-level docs
4. OpenAI Conversations API for persistent threads
5. Context compaction for very long session chains

---

## Prerequisite: Environment Sanitization (DONE)

**Discovered and fixed 2026-02-21.** When Steroids spawns provider CLIs, the child process inherits the full `process.env`, including `STEROIDS_ANTHROPIC_API_KEY` and other Steroids-internal API keys. Some provider CLIs scan env vars for API key patterns and will use them instead of their own OAuth/login credentials.

**Symptom:** A spawned `claude -p` process reported `apiKeySource: "ANTHROPIC_API_KEY"` and hit "Credit balance is too low" — it used a pay-per-token API key instead of the user's Max subscription (free with OAuth).

**Fix:** `BaseAIProvider.getSanitizedCliEnv()` in `src/providers/interface.ts` now strips these env vars before spawning child processes:

| Stripped Env Var | Provider CLI It Could Confuse |
|---|---|
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | Codex |
| `GOOGLE_API_KEY` | Gemini |
| `GEMINI_API_KEY` | Gemini |
| `GOOGLE_CLOUD_API_KEY` | Gemini |
| `MISTRAL_API_KEY` | Vibe |

This forces each CLI to use its own auth (OAuth, `login`, subscription). The `STEROIDS_*` prefixed keys are unaffected — they're only used by Steroids' own direct API calls in `api-models.ts`.

**This fix is a prerequisite for session reuse** — if a CLI uses the wrong auth, it may produce sessions under a different account/tier, causing resume failures or unexpected billing.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Session ID extraction is fragile | Graceful fallback to fresh sessions; never block on session management |
| Resumed context is stale/wrong | TTL-based expiry + provider change detection |
| Context window overflow after many resumes | Auto-detect `context_exceeded` and restart fresh |
| Delta prompts lack necessary context | Start conservative (include more context), measure, then trim |
| Provider CLI changes break session format | Version-pin session format expectations; test in CI |
| Reviewer needs coder's context but can't resume coder's session | Start with independent session chains; fork in v2 |
| Vibe's 20-message window may lose earlier context on resume | Test whether delta prompts fit within the window; if not, include slightly more context in Vibe delta prompts |
| Vibe has no `--list-sessions` (issue #249) | Extract session ID from exit output or filesystem; don't depend on listing |

---

## Vibe Integration Gaps (Resolved)

**Original issue (2026-02-21):** Vibe appeared to hang on large prompts (~38KB) with zero stdout/stderr output.

**Root cause found:** The `-p` / `--prompt` flag is **required** for non-interactive (programmatic) mode. Without it, Vibe enters interactive mode and waits for terminal input indefinitely — even if a prompt is provided as a positional argument. The original test likely used positional argument syntax or was missing the `-p` flag.

**Verified working patterns (Vibe v2.2.1, tested with 37KB prompt):**
```bash
# Correct — programmatic mode, auto-exits after response
vibe -p "$(cat large_prompt.txt)" --output text           # ✅ Works
vibe -p "$(cat large_prompt.txt)" --output json            # ✅ Works
vibe -p "$(cat large_prompt.txt)" --output streaming       # ✅ Works
vibe -p "$(cat large_prompt.txt)" --max-turns 5            # ✅ Works

# WRONG — positional argument enters interactive mode, hangs
vibe "$(cat large_prompt.txt)"                             # ❌ Hangs
echo "prompt" | vibe                                       # ❌ Error (no stdin support)
```

**Key Vibe CLI facts:**
- `-p` / `--prompt` = programmatic mode: sends prompt, auto-approves tools, outputs response, exits
- Positional `PROMPT` argument = interactive mode: opens session, waits for user input
- `--agent auto-approve` is only relevant in interactive mode; `-p` auto-approves by default
- `--enabled-tools TOOL` whitelists specific tools in programmatic mode (supports globs, regex)
- `--workdir DIR` sets CWD before running (useful for project-scoped invocations)
- Max shell argument size (ARG_MAX): 1,048,576 bytes — well above typical prompt sizes

**Impact on design:** Vibe is fully usable for coder/reviewer invocations with large prompts. The current Steroids Mistral provider template already uses `-p`, so this is consistent. Phase 3 implementation for Vibe can proceed as planned.

**Remaining Vibe-specific considerations:**
1. Session ID extraction requires filesystem scan (no structured output for session metadata)
2. 20-message session windowing may lose early context on resume — test with real coder sessions
3. `VIBE_HOME` isolation per runner is recommended for parallel execution
4. No `--list-sessions` command ([issue #249](https://github.com/mistralai/mistral-vibe/issues/249))

---

## Cross-Provider Review (2026-02-21)

This design document was reviewed by Claude (Opus 4.6), Codex (OpenAI), and Gemini (auto-gemini-3). Vibe review was attempted but blocked by the integration gaps above.

### Findings Accepted

| Finding | Source | Action |
|---------|--------|--------|
| Use `VIBE_HOME` per task/runner to isolate Vibe sessions | Gemini | Add to Phase 3 implementation |
| Session file cleanup strategy needed | Gemini, Claude | Add to Open Questions |
| `buildCommand()` needs `{session_id}` placeholder | Codex | Add to Phase 1 |
| Migration example needs numbered SQL + manifest.json | Codex | Fix in doc |
| Resume failure classes beyond `context_exceeded` | Codex, Claude | Add `session_not_found`, `session_expired`, auth mismatch |
| Vibe storage path contradiction (`sessions/` vs `logs/session/`) | Codex | Fix in doc |
| "Full history replay" contradicts Vibe's 20-message window | Codex | Fix "Key detail" section |
| Provider-level resume API instead of template-only approach | Codex | Adopt for Phase 2 |
| Richer invocation metadata (`invocation_mode`, `resumed_from`) | Codex | Add to Phase 1 |
| Delta prompts need minimum role/objective even on resume | Gemini | Add to Phase 4 design |
| Race condition in Vibe filesystem scan under parallel runners | Claude, Gemini | Mitigated by `VIBE_HOME` isolation |
| Reviewer "context reset" signal to force fresh session | Gemini | Add to Open Questions |

### Findings Deferred

| Finding | Source | Reason |
|---------|--------|--------|
| Prioritize session forking to Phase 3-4 | Gemini | Need to verify forking works reliably first |
| Non-Goals section and Edge Cases table | Codex | Good practice but not blocking implementation |
| Distributed/containerized runner support | Gemini, Codex | Current architecture is local-only by design |
| Token savings "virtualization" / reporting UI | Gemini | Nice-to-have, not blocking |

### Findings Assessed but Not Adopted

| Finding | Source | Assessment |
|---------|--------|------------|
| "Not ready for implementation as-is" | Codex | Disagree for Phase 1 — infrastructure changes (capture session IDs, token usage) are safe with no behavior change. Phase 2+ needs the fixes above. |

---

## References

- [Claude Code CLI Reference — Session Flags](https://code.claude.com/docs/en/cli-reference)
- [Codex CLI — Session Resumption](https://developers.openai.com/codex/cli/reference/)
- [Gemini CLI — Session Management](https://geminicli.com/docs/cli/session-management/)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [OpenAI Conversations API](https://platform.openai.com/docs/guides/conversation-state)
- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction/)
- [Gemini API Context Caching](https://ai.google.dev/gemini-api/docs/caching)
- [Mistral Vibe CLI — GitHub](https://github.com/mistralai/mistral-vibe)
- [Mistral Vibe CLI — Configuration](https://docs.mistral.ai/mistral-vibe/introduction/configuration)
- [Mistral Vibe CLI — Quickstart](https://docs.mistral.ai/mistral-vibe/introduction/quickstart)
- [Mistral Vibe — Session Listing Issue #249](https://github.com/mistralai/mistral-vibe/issues/249)
- [Mistral Conversations API (Beta)](https://docs.mistral.ai/api/endpoint/beta/conversations)
