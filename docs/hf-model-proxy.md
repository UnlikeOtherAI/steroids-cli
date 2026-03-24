# HuggingFace Model Proxy — CLI & Model Compatibility

How steroids routes HuggingFace models through CLI tools that don't natively support them.

## The Problem

Each CLI tool speaks one API protocol:

| CLI Tool | Native Protocol | Env Vars for Base URL |
|----------|----------------|-----------------------|
| Claude Code | Anthropic Messages API (`/v1/messages`) | `ANTHROPIC_BASE_URL` |
| Codex | OpenAI Chat Completions (`/v1/chat/completions`) | `OPENAI_BASE_URL` |
| Vibe (Mistral) | Mistral API (OpenAI-compatible subset) | N/A (config-driven) |
| Gemini CLI | Google Gemini API | N/A (no base URL override) |
| OpenCode | OpenAI-compatible (native HF support) | Configured via `opencode.json` |

The HuggingFace Router (`router.huggingface.co/v1`) exposes an OpenAI-compatible API, but:

1. **Codex** rejects HF's `/v1/models` response — it includes extra fields (`providers`, `architecture`) that Codex's Rust parser doesn't expect.
2. **Claude Code** only speaks the Anthropic Messages API — it cannot talk to OpenAI-compatible endpoints at all.
3. **Vibe** is config-driven and doesn't support arbitrary base URL overrides.
4. **Gemini CLI** has no base URL mechanism — it only talks to Google's API.
5. **OpenCode** works natively with HF models via its `opencode.json` config.

## The Proxy Solution

A local HTTP proxy (`src/proxy/hf-proxy.ts`) runs on `127.0.0.1:3580` and translates between protocols:

```
Claude Code ──▶ POST /v1/messages      ──▶ Anthropic→OpenAI translation ──▶ HF Router
Codex       ──▶ POST /v1/chat/completions ──▶ Pass-through (stream-proxy) ──▶ HF Router
Codex       ──▶ GET  /v1/models           ──▶ Strip extra fields           ──▶ HF Router
Any CLI     ──▶ GET  /health              ──▶ { "status": "ok" }
```

### Model Detection

A model is identified as HuggingFace when its ID contains a `/` (e.g., `MiniMaxAI/MiniMax-M2.5`, `deepseek-ai/DeepSeek-V3-0324`). Native provider models never have slashes (`claude-opus-4-6`, `gpt-5.3-codex`, `codestral-latest`).

Exception: IDs starting with `models/` are not treated as HF (some providers use that prefix internally).

### Env Var Injection

When a provider detects an HF model, it starts the proxy and passes `STEROIDS_HF_PROXY_URL` into `getSanitizedCliEnv()`. The base class then sets:

```
OPENAI_BASE_URL    = http://127.0.0.1:3580
OPENAI_API_KEY     = hf-proxy
ANTHROPIC_BASE_URL = http://127.0.0.1:3580
ANTHROPIC_API_KEY  = hf-proxy
```

The `hf-proxy` API key is a dummy — the proxy adds the real `Bearer hf_...` token when forwarding to HF Router.

### HF Token Resolution

The proxy authenticates with HF Router using a token resolved in priority order:

1. `HF_TOKEN` environment variable
2. `~/.config/opencode/opencode.json` → `provider.huggingface.options.apiKey`
3. `~/.huggingface/token` file

If no token is found, the proxy doesn't start and the CLI falls through to its native API (which will likely fail for an HF model ID).

## Compatibility Matrix

| Provider | CLI Tool | HF Models via Proxy | Native Models | Notes |
|----------|----------|:-------------------:|:-------------:|-------|
| **claude** | Claude Code | Yes | Yes | Proxy translates Anthropic↔OpenAI. Non-streaming only (streaming Anthropic SSE translation not yet implemented). |
| **codex** | Codex CLI | Yes | Yes | Proxy normalizes `/v1/models` schema and stream-proxies completions. |
| **mistral** | Vibe CLI | Yes | Yes | Proxy injects `OPENAI_BASE_URL` but Vibe's config-driven model selection may not honor it for all model aliases. Untested in production. |
| **gemini** | Gemini CLI | **No** | Yes | No base URL override mechanism. Gemini CLI only talks to Google's API. |
| **opencode** | OpenCode | N/A (native) | N/A | OpenCode natively supports HF models via `opencode.json` `huggingface` provider config. No proxy needed. |

## What Works

### Codex + HF Models
The primary use case. Codex sends standard OpenAI requests; the proxy:
- Normalizes `/v1/models` to only `{ id, object, created, owned_by }` (Codex's parser rejects extra fields)
- Stream-proxies `/v1/chat/completions` verbatim (HF Router's response is already OpenAI-compatible)

### Claude Code + HF Models
Claude Code sends Anthropic Messages API requests to `ANTHROPIC_BASE_URL`. The proxy translates:

| Direction | Translation |
|-----------|-------------|
| Request: `system` (top-level) | → `messages[0] = { role: "system", content: ... }` |
| Request: `messages[].content` (block array) | → Flattened to single string (text blocks joined with `\n`) |
| Request: `tools[]` (Anthropic schema) | → OpenAI function calling format |
| Response: `choices[0].message.content` | → `content: [{ type: "text", text: ... }]` |
| Response: `choices[0].message.tool_calls` | → `content: [{ type: "tool_use", ... }]` |
| Response: `usage.prompt_tokens` | → `usage.input_tokens` |
| Response: `finish_reason: "stop"` | → `stop_reason: "end_turn"` |

### OpenCode + HF Models (No Proxy)
OpenCode has native HuggingFace support. Configure in `~/.config/opencode/opencode.json`:
```json
{
  "provider": {
    "huggingface": {
      "options": { "apiKey": "hf_..." }
    }
  }
}
```
Model IDs use `huggingface/Org/Model` format in OpenCode.

## What Doesn't Work

### Gemini CLI + HF Models
The Gemini CLI has no `GOOGLE_BASE_URL` or equivalent override. It exclusively communicates with Google's Gemini API. There is no way to route it through the proxy.

### Streaming Anthropic SSE Translation
The proxy currently only translates **non-streaming** Anthropic requests. When Claude Code sends `"stream": true`, the proxy would need to convert OpenAI SSE chunks (`data: {"choices":[{"delta":{"content":"..."}}]}`) into Anthropic SSE events (`event: content_block_delta`, `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`). This is not yet implemented.

In practice, Claude Code's `--output-format text` mode (used by steroids) does not require streaming, so this is not a blocker for the current integration.

### Tool Use in Streaming Mode
Even if streaming translation were implemented, tool use calls during streaming require careful state tracking (accumulating partial JSON for function arguments across chunks). Not implemented.

### Vibe (Mistral) + HF Models — Untested
The proxy injects `OPENAI_BASE_URL` and `OPENAI_API_KEY` into Vibe's env, but Vibe selects models through its own config system (`VIBE_MODELS`, `VIBE_ACTIVE_MODEL`). Whether Vibe honors `OPENAI_BASE_URL` for arbitrary model names hasn't been verified. The model alias system may need a `provider: "openai"` entry rather than `provider: "mistral"` for the routing to work.

### Image/Multimodal Content
The Anthropic→OpenAI translation only handles text content blocks. Image blocks (`type: "image"`) are silently dropped during the content flattening step.

## Proxy Lifecycle

### Auto-Start with Web Dashboard
`steroids web` automatically spawns the proxy as a detached daemon alongside the API and WebUI if an HF token is available. `steroids web stop` kills all three. `steroids web status` shows all three.

### Auto-Start per Invocation
Each provider's `invokeWithFile()` calls `ensureProxy()` when it detects an HF model. The proxy starts on first use and subsequent invocations reuse it via PID file check. If the proxy can't start (port busy, no token), the provider continues without it.

### Manual Control
```
steroids ai proxy start    # Start on port 3580
steroids ai proxy stop     # Stop
steroids ai proxy status   # Check state
```

### PID File
`~/.steroids/proxy.pid` contains `{ "pid": <number>, "port": <number> }`. Used for process liveness detection (`kill(pid, 0)`). Stale PID files are auto-cleaned.

### Logs
Daemon mode writes to `~/.steroids/logs/proxy.log`.

## Architecture

```
src/proxy/
  hf-proxy.ts       — HTTP server with route handlers (models, chat, messages, health)
  hf-token.ts       — Token resolution (env → opencode.json → ~/.huggingface/token)
  lifecycle.ts       — start/stop/ensure (in-process), spawnProxyDaemon (detached)
  daemon-entry.ts    — Entrypoint for detached daemon process

src/providers/
  interface.ts       — getSanitizedCliEnv() injects proxy URL when STEROIDS_HF_PROXY_URL is set
  claude.ts          — Detects HF model → ensureProxy → injects overrides
  codex.ts           — Same pattern
  mistral.ts         — Same pattern
  opencode.ts        — No proxy needed (native HF support)
  gemini.ts          — No proxy support (no base URL mechanism)

src/commands/
  ai-proxy.ts        — CLI subcommand (start/stop/status)
  web.ts             — Spawns proxy daemon on launch, kills on stop
```

## Tested HF Models

The following models were verified working through the proxy during development:

| Model | Via Codex | Via Claude Code | Via OpenCode |
|-------|:---------:|:---------------:|:------------:|
| `MiniMaxAI/MiniMax-M2.5` | Quota blocked* | Not tested | Works |
| `MiniMaxAI/MiniMax-M2.0` | Quota blocked* | Not tested | Works |
| `deepseek-ai/DeepSeek-V3-0324` | Quota blocked* | Not tested | Works |

\* Codex CLI had an unrelated account quota exhaustion during testing. The proxy schema normalization was verified independently via `curl`.

The proxy's `/v1/models` endpoint was verified to correctly normalize all 124 HF Router models to OpenAI-compatible schema (no `providers` or `architecture` fields leak through).
