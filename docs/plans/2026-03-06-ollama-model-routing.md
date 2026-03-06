# Ollama Model Routing

> **Status:** Draft
> **Date:** 2026-03-06
> **Author:** Human (requirements), Claude (design)
> **Related:** [Hugging Face Model Routing](./2026-03-06-huggingface-model-routing.md) — sibling integration, same UI patterns

## Problem Statement

Steroids currently only supports Anthropic models for orchestrator, coder, and reviewer roles. Users who want to run models locally (for privacy, cost, or offline use) or through Ollama's cloud service have no path to do so.

Ollama provides both a local runtime and a cloud service with an identical API surface. By integrating Ollama as a provider, Steroids can offer local and cloud model execution using the same UI patterns as the Hugging Face integration.

## Current Behavior

- Model selection is limited to Anthropic models: `sonnet`, `opus`, `haiku`
- An Ollama provider already exists at `src/providers/ollama.ts` (279 lines) and is registered in `src/providers/registry.ts` via `createDefaultRegistry()`. It uses `node:http` directly, calls the native `/api/chat` endpoint (not `/v1/`), supports dynamic model discovery from `/api/tags`, has `stream: false` hardcoded, and reads endpoint config from `STEROIDS_OLLAMA_HOST`/`STEROIDS_OLLAMA_PORT` env vars
- `'ollama'` is already in the `ProviderName` union type in `src/config/loader.ts`
- No Ollama section in the web UI sidebar
- No model browsing, pairing, or usage tracking UI

## Desired Behavior

### Web UI — Left Sidebar

A new **Ollama** section in the left menu (alongside the Hugging Face section) with:

1. **Connection** — configure Ollama endpoint (local or cloud), test connectivity
2. **Installed Models** — list models available on the connected Ollama instance
3. **Model Library** — browse and pull models from the Ollama registry
4. **Ready to Use** — models paired with a runtime (Claude Code or OpenCode)
5. **Account** — connection status, tier info (cloud only), billing link

### Model Selection Popup

The orchestrator/coder/reviewer model picker expands to include Ollama groups:

```
Claude Code (Anthropic)
  ├─ Sonnet
  ├─ Opus
  └─ Haiku

Claude Code (Ollama)
  ├─ deepseek-coder-v2:33b
  ├─ qwen2.5-coder:32b
  ├─ llama3.3:70b
  └─ codestral:22b

OpenCode (Ollama)
  ├─ deepseek-coder-v2:33b
  └─ qwen2.5-coder:32b
```

Groups populated from paired models in "Ready to Use".

## Design

### 1. Ollama API Client

**File:** `src/ollama/api-client.ts`

Wraps the Ollama API. The same client works for both local and cloud endpoints — only the base URL and auth differ.

#### API Surface Used

**Health & Status:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Health check — returns `"Ollama is running"` (200) |
| `GET` | `/api/version` | Server version |
| `GET` | `/api/ps` | Currently loaded models (VRAM/RAM usage) |

**Model Discovery:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/tags` | List installed models — returns `name`, `size`, `digest`, `details` (family, parameter_size, quantization_level) |
| `POST` | `/api/show` | Full model metadata — `modelfile`, `parameters`, `template`, `system`, `license`, `details` |

**Model Management:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/pull` | Download model from registry — streamed progress (`status`, `digest`, `total`, `completed`) |
| `DELETE` | `/api/delete` | Remove model from local instance |

**Inference:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/chat` | Chat completion (native format) — **primary inference endpoint** (returns timing metrics) |
| `POST` | `/v1/chat/completions` | Chat completion (OpenAI-compatible) — available but not used for inference (strips timing metrics) |

**OpenAI-compatible endpoints (alternative surface):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/models` | List models in OpenAI format |
| `GET` | `/v1/models/{model}` | Single model detail |
| `POST` | `/v1/chat/completions` | Chat completion |

The OpenAI-compatible surface is used **only for model listing** in the UI (consistent format with HF). **Inference always uses the native `/api/chat` endpoint** to capture timing metrics — see §4 Dual-Endpoint Strategy.

#### Connection Modes

| Mode | Base URL | Auth |
|------|----------|------|
| Local | `http://localhost:11434` (default, configurable) | None |
| Cloud | `https://ollama.com` | `Authorization: Bearer {api_key}` via `OLLAMA_API_KEY` |

### 2. Model Registry & Cache

**File:** `src/ollama/model-registry.ts`

Unlike Hugging Face (which requires Hub API discovery), Ollama models are discovered directly from the running instance.

**Cache location:** `~/.steroids/ollama/models.json`

**Cache schema:**

```ts
interface OllamaModelCache {
  lastUpdated: number;          // epoch ms
  endpoint: string;             // base URL used for this cache
  models: OllamaCachedModel[];
}

interface OllamaCachedModel {
  name: string;                 // e.g. "deepseek-coder-v2:33b"
  size: number;                 // bytes
  parameterSize: string;        // e.g. "33B"
  family: string;               // e.g. "deepseek2"
  quantization: string;         // e.g. "Q4_K_M"
  digest: string;               // model hash
  modifiedAt: string;           // ISO timestamp
  source: 'installed' | 'pulled';
}
```

**Refresh strategy:**

- Local: query `/api/tags` on page load and after pull/delete operations
- Cloud: query `/api/tags` on page load, cache for 5 minutes
- No periodic background refresh needed (unlike HF) — the model list is the instance's local state

### 3. Connection & Authentication

**File:** `src/ollama/connection.ts`

**Local connection:**

1. User configures endpoint URL (default `http://localhost:11434`)
2. Health check via `GET /` — expect `200` with body `"Ollama is running"`
3. No auth required
4. Store endpoint in `~/.steroids/ollama/config.json`

**Cloud connection:**

1. User enters API key (created at `ollama.com/settings/keys`)
2. Validate via `GET /api/tags` with `Authorization: Bearer {key}`
3. Store key in `~/.steroids/ollama/token` (`0600` permissions)
4. Store endpoint as `https://ollama.com` in config

**Config file:** `~/.steroids/ollama/config.json`

```json
{
  "endpoint": "http://localhost:11434",
  "mode": "local",
  "cloudTier": null
}
```

### 4. Provider Adapter

**File:** `src/providers/ollama.ts` — **refactor of existing implementation**, not a new file.

The existing provider uses `node:http` with native `/api/chat` and `stream: false`. This refactor:
- Adds streaming support (currently hardcoded off)
- Adds dual-endpoint support (see below)
- Preserves backward compatibility with `STEROIDS_OLLAMA_HOST`/`STEROIDS_OLLAMA_PORT` env vars
- Adds file-based config as secondary source (env vars take precedence)
- Adds `OLLAMA_API_KEY` to `keysToStrip` in `getSanitizedCliEnv()`

#### Dual-Endpoint Strategy

The adapter uses **two endpoints** for different purposes:

| Purpose | Endpoint | Why |
|---------|----------|-----|
| **Inference** | `/api/chat` (native) | Returns timing metrics (`total_duration`, `eval_duration`, etc.) needed for the admin dashboard. The `/v1/` endpoint strips these. |
| **Token counts** | Same `/api/chat` response | `prompt_eval_count` and `eval_count` in the final chunk |
| **Model listing** (for UI) | `/v1/models` (OpenAI-compat) | Consistent format with HF for shared UI code |

The adapter translates Steroids' prompt format to Ollama's native chat format, parses the streaming NDJSON response (not SSE — Ollama uses newline-delimited JSON), and maps the native fields to a unified `InvokeResult`.

**Key options:**

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `temperature` | 0.8 | Creativity/randomness |
| `top_p` | 0.9 | Nucleus sampling |
| `num_predict` | -1 | Max tokens (-1 = infinite) |
| `num_ctx` | 32768 | Context window size — **must be large enough for coding tasks**. Auto-detect from model's max context via `POST /api/show` when possible. |
| `stop` | — | Stop sequences |
| `seed` | 0 | Reproducibility |

**Note on `num_ctx`:** The Ollama default is 2048, which is far too small for coding agents that process entire files and diffs. Set a minimum of 8192; prefer 32768 or the model's maximum. VRAM requirements scale with context size — document this in the UI.

The adapter handles:
- Translating Steroids' internal prompt format to Ollama chat format
- Streaming NDJSON response parsing (not SSE)
- Extracting timing metrics from the final `done: true` chunk
- Error mapping (connection refused, model not found, OOM)
- Timeout handling for local models (cold start can be slow)

#### Concurrency & Parallel Runners

Steroids can run multiple parallel runners (up to `maxClones: 5`). When targeting a local Ollama endpoint, concurrent inference requests multiply VRAM pressure from KV cache. A model that fits for one request may OOM under five concurrent requests.

**Design decision:** The Ollama adapter enforces a per-endpoint concurrency semaphore with configurable `maxConcurrent` (default: 1 for local, 3 for cloud). When all slots are busy, additional requests queue with a configurable timeout. This prevents OOM crashes without requiring users to understand VRAM arithmetic.

**Semaphore invariants:**
- Slot is acquired **before** the HTTP request is initiated
- Slot is held for the **entire stream duration** (from request start to final `done: true` NDJSON chunk), not just until connection is established
- Slot is released in a `try/finally` block wrapping the full HTTP request lifecycle, including error, timeout, and client disconnect paths
- If a request errors or times out mid-stream, the slot is guaranteed to be released — failure to do so permanently consumes the slot and deadlocks the endpoint after N errors

```ts
// Pseudocode for semaphore usage
const slot = await semaphore.acquire(timeoutMs);
try {
  const response = await httpRequest('/api/chat', payload);
  for await (const chunk of parseNDJSON(response)) {
    // process chunk...
    if (chunk.done) break;
  }
} finally {
  slot.release(); // guaranteed release on success, error, or timeout
}
```

If `maxConcurrent` is too restrictive, users can increase it in config:

```yaml
ollama:
  maxConcurrent: 3  # for GPUs with enough VRAM
```

### 5. Runtime Pairing

Same pattern as Hugging Face — models paired with a runtime label. The runtime label is a user-facing grouping concept; under the hood, both runtimes invoke the same Ollama provider adapter.

**Tool support validation:** At pairing time, check the model's `capabilities` array from `POST /api/show`. If `"tools"` is not present, display a warning: "This model does not support tool calling. Agent tasks requiring file edits and bash execution will fail."

Paired models are stored in the global Steroids database (see §6 Usage Tracking):

```sql
-- In ~/.steroids/global.db
CREATE TABLE ollama_paired_models (
  id INTEGER PRIMARY KEY,
  model_name TEXT NOT NULL,       -- "deepseek-coder-v2:33b"
  runtime TEXT NOT NULL,          -- 'claude-code' | 'opencode'
  endpoint TEXT NOT NULL,         -- which Ollama instance
  supports_tools INTEGER DEFAULT 0,
  available INTEGER DEFAULT 1,           -- 0 if model not found on endpoint after re-validation
  added_at INTEGER NOT NULL,
  UNIQUE(model_name, runtime, endpoint)  -- prevent duplicate pairings; upsert on conflict
);
```

### 6. Per-Request Metrics & Usage Tracking

**File:** `src/ollama/metrics.ts`

Ollama returns rich per-request data that enables admin dashboard features. This data must be captured and stored by Steroids since Ollama has no historical usage API.

#### Token Counts

Available from both API surfaces:

**Native API** (`/api/chat`, `/api/generate`) — final streaming chunk where `done: true`:

| Field | Type | Description |
|-------|------|-------------|
| `prompt_eval_count` | integer | Input tokens processed |
| `eval_count` | integer | Output tokens generated |

**OpenAI-compatible** (`/v1/chat/completions`) — standard `usage` object:

| Field | Type | Description |
|-------|------|-------------|
| `usage.prompt_tokens` | integer | Maps from `prompt_eval_count` |
| `usage.completion_tokens` | integer | Maps from `eval_count` |
| `usage.total_tokens` | integer | Sum of both |

#### Timing Metrics (Native API Only)

All values in **nanoseconds**. Not available via `/v1/` endpoints.

| Field | Type | Description |
|-------|------|-------------|
| `total_duration` | integer (ns) | Total wall-clock time for the request |
| `load_duration` | integer (ns) | Time to load model into memory (0 if already loaded) |
| `prompt_eval_duration` | integer (ns) | Time to process input tokens |
| `eval_duration` | integer (ns) | Time to generate output tokens |

**Derived metric:** `tokens_per_second = eval_count / eval_duration × 1e9`

#### VRAM & Runtime Status (`GET /api/ps`)

| Field | Type | Description |
|-------|------|-------------|
| `size` | integer (bytes) | Total model size on disk |
| `size_vram` | integer (bytes) | VRAM usage (if `size_vram == size`, fully GPU-loaded) |
| `context_length` | integer | Active context window for this instance |
| `expires_at` | string (ISO 8601) | When model will auto-unload from memory |

CPU RAM approximation: `size - size_vram` (no explicit field).

#### Model Architecture Details (`POST /api/show`)

Deep metadata per model, useful for the admin panel:

| Field | Type | Description |
|-------|------|-------------|
| `capabilities` | string[] | `["completion", "tools", "vision"]` |
| `model_info.{family}.context_length` | integer | Max context window |
| `model_info.{family}.embedding_length` | integer | Embedding dimensions |
| `model_info.{family}.block_count` | integer | Transformer blocks |
| `model_info.{family}.attention.head_count` | integer | Attention heads |
| `model_info.general.architecture` | string | Architecture identifier |

**Note on `{family}` key:** The `model_info` object uses architecture-specific key prefixes (e.g. `llama.context_length`, `qwen2.context_length`, `deepseek2.context_length`). The `{family}` is not a fixed string — it varies per model. Implementation must iterate `Object.values(model_info)` and pick the first object containing a `context_length` field, falling back to `num_ctx: 32768` if none found. Do not hardcode family names.

#### Steroids-Side Usage Logging

Since Ollama has no usage history API, Steroids must log per-request data locally.

**Storage:** New table in the existing global database (`~/.steroids/global.db`), not a separate database. This enables cross-provider aggregation with HF usage in a single query and avoids the multiple-DB problems (no migration system, `better-sqlite3` blocking).

```sql
CREATE TABLE ollama_usage (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  role TEXT,                         -- 'coder' | 'reviewer' | 'orchestrator' (nullable for legacy rows)
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_duration_ns INTEGER,
  load_duration_ns INTEGER,
  prompt_eval_duration_ns INTEGER,
  eval_duration_ns INTEGER,
  tokens_per_second REAL,
  created_at INTEGER NOT NULL  -- epoch ms
);
```

**Note on timing metrics:** The adapter uses the native `/api/chat` endpoint (not `/v1/chat/completions`) specifically to capture timing fields. If the adapter were to use the `/v1/` endpoint, `total_duration_ns` through `tokens_per_second` would all be NULL — the OpenAI-compat surface strips these fields.

This enables:
- Per-model token usage over time
- Performance trends (tokens/sec per model)
- Cold start tracking (load_duration > 0)
- Total usage aggregation for the admin panel
- Cross-provider aggregation with HF usage

#### Admin Dashboard Display

```
Today's Usage:
  Total tokens: 124,500 (prompt: 98,200 / completion: 26,300)
  Requests: 47
  Avg tokens/sec: 42.3

Per Model (last 7 days):
  deepseek-coder-v2:33b  — 312K tokens, avg 38.1 tok/s
  qwen2.5-coder:32b      — 89K tokens, avg 45.7 tok/s
  llama3.3:70b           — 41K tokens, avg 22.4 tok/s

System:
  Loaded models: 2 (14.3 GB VRAM)
  Model auto-unload: deepseek-coder-v2:33b in 4m 32s
```

### 7. Account & Billing Status

**File:** `src/ollama/account.ts`

#### Local Mode

No billing applies. Display:

```
Mode: Local
Status: Connected
Version: 0.6.2
Loaded Models: 2 (14.3 GB VRAM)
```

Data from `GET /api/version` and `GET /api/ps`.

#### Cloud Mode

Ollama cloud uses subscription tiers, not per-token billing. **No billing API exists** — tier and usage are not queryable.

| Tier | Price | Concurrent Models | Private Models |
|------|-------|-------------------|----------------|
| Free | $0/mo | Limited | 0 |
| Pro | $20/mo | Multiple | Up to 3 |
| Max | $100/mo | 5+ | Up to 5 |

Display what we can detect:

```
Mode: Cloud
Status: Connected
Tier: Unknown (no API available)
Manage billing: https://ollama.com/settings/billing
```

**What we can show:**
- Connection status (health check passes/fails)
- Server version
- Model list (confirms cloud access works)
- Link to billing page (external)

**What we cannot show (no API):**
- Current tier (Free/Pro/Max)
- Usage metrics
- Remaining quota
- Billing history

If Ollama adds billing APIs in the future, the Account page is pre-structured to display that data.

### 8. Web UI Components

**Left sidebar — Ollama section:**

```
[Ollama icon] Ollama
  ├─ Connection       → endpoint config, health status, version
  ├─ Installed Models → models on the instance with size/quantization
  ├─ Model Library    → pull new models (search Ollama registry)
  ├─ Ready to Use     → paired models, editable
  └─ Account          → mode, status, billing link (cloud)
```

**Connection page:**

| Field | Source |
|-------|--------|
| Mode | Local / Cloud toggle |
| Endpoint | Editable URL field |
| Status | Health check result (green/red) |
| Version | `/api/version` |
| Loaded Models | `/api/ps` — model names + VRAM usage |

**Installed Models page:**

| Column | Source |
|--------|--------|
| Model Name | `model.name` |
| Size | `model.size` (formatted: 14.3 GB) |
| Parameters | `model.details.parameter_size` (e.g. 33B) |
| Quantization | `model.details.quantization_level` (e.g. Q4_K_M) |
| Family | `model.details.family` |
| Actions | "Pair with Claude Code" / "Pair with OpenCode" / "Delete" |

**Model Library page (pull new models):**

**Important:** Ollama has no registry search API. The model library at `ollama.com/library` is a web page with no documented API endpoint for browsing or searching.

Approach:
- Maintain a curated local list of popular coding-relevant models (similar to HF's curated list but static, updated with Steroids releases)
- Provide a text field for manual model name entry (user types `deepseek-coder-v2:33b` and clicks Pull)
- Link to `ollama.com/library` for browsing the full catalog in a browser
- Pull progress displayed inline (streamed from `/api/pull`)

**Ready to Use page:**

Identical layout to the Hugging Face "Ready to Use" page:

| Column | Source |
|--------|--------|
| Model Name | paired model name |
| Runtime | Claude Code / OpenCode badge |
| Endpoint | Local / Cloud indicator |
| Actions | Remove, Change runtime |

**Model picker popup (extended):**

Same grouping pattern as Hugging Face:
- "Ollama (Claude Code)" group — paired models with `runtime: 'claude-code'`
- "Ollama (OpenCode)" group — paired models with `runtime: 'opencode'`

### 9. Config Integration

**`'ollama'` is already in `ProviderName`** — no type change needed (unlike HF which requires adding `'hf'`).

**Shared type dependency:** The `model_capability_error` addition to `ProviderErrorType` (defined in HF doc §9, item 5) is a shared change required by both HF and Ollama. Whichever integration lands first must include this type change. The Ollama adapter uses it to classify responses from models that lack tool support (see Edge Cases).

**Config format uses the existing `{ provider, model }` object shape:**

```yaml
# In steroids config.yaml
ai:
  coder:
    provider: ollama
    model: deepseek-coder-v2:33b
  reviewer:
    provider: ollama
    model: qwen2.5-coder:32b
  orchestrator:
    provider: claude
    model: claude-sonnet-4-6         # can mix providers
```

The `model` field is an opaque string passed directly to the Ollama adapter. It includes the tag (`:33b`, `:latest`).

**Environment variable compatibility:**

The existing `STEROIDS_OLLAMA_HOST` and `STEROIDS_OLLAMA_PORT` env vars continue to work. Priority: env vars > file config (`~/.steroids/ollama/config.json`) > defaults.

The `STEROIDS_AI_REVIEWERS` env var parser (`applyEnvOverrides()` in `src/config/loader.ts:252`) has a **pre-existing live bug** — it uses `split(':')` which truncates multi-colon model names like `ollama:deepseek-coder-v2:33b`. **This bug exists in the current codebase and should be fixed independently of the Ollama integration work — it is not gated on any phase.** Fix with first-colon-only split:

```ts
// "ollama:deepseek-coder-v2:33b" → provider="ollama", model="deepseek-coder-v2:33b"
const idx = s.indexOf(':');
const provider = s.slice(0, idx);
const model = s.slice(idx + 1);
```

**Model name sanitization:** Ollama model names contain `:` (e.g. `deepseek-coder-v2:33b`). When deriving cache keys or file paths, replace `:` with `_` to avoid path issues. Never use raw model names as filesystem path components.

**Minimum Ollama version:** Require Ollama 0.1.14+ for `/v1/` endpoint support (used for model listing in the UI). Check via `GET /api/version` at connection time; warn if below minimum.

## API Flow Comparison

### Ollama vs Hugging Face — Side by Side

| Step | Ollama | Hugging Face |
|------|--------|-------------|
| Discovery | `GET /api/tags` (installed models) | `GET /api/models` (Hub catalog) |
| Metadata | `POST /api/show` | `GET /api/models/{id}` |
| Provider info | N/A (Ollama IS the provider) | `GET /api/models/{id}?expand=inferenceProviderMapping` |
| Inference | `POST /api/chat` (native, for timing metrics) | `POST router.huggingface.co/v1/chat/completions` |
| Model install | `POST /api/pull` | N/A (no install, router handles it) |
| Health check | `GET /` | `GET /api/whoami-v2` |
| Billing | No API (subscription, link to web) | No API (credits, link to web) |

### Shared Abstractions (with shared code)

Both providers reuse:
- **`ProviderName` union** — `'hf'` and `'ollama'` in the same type
- **Provider registry** — same `IAIProvider` interface, same `invoke()` contract
- **Config schema** — same `{ provider, model }` object shape for `ai.coder`, `ai.reviewer`, `ai.orchestrator`
- **Global DB usage tables** — `hf_usage` and `ollama_usage` in the same `~/.steroids/global.db`, enabling cross-provider aggregation
- **Model picker grouping** — provider → runtime → model list (same UI component)
- **`getSanitizedCliEnv()`** — both providers' tokens stripped from child env

**UI differences (acceptable):**
- HF has routing policy selector (fastest/cheapest/preferred/specific); Ollama does not (single provider)
- HF has pricing columns; Ollama does not (local is free, cloud is subscription)
- Ollama has VRAM/loaded models display; HF does not (cloud inference)
- Ollama has concurrency semaphore config; HF does not (cloud handles scaling)

## Implementation Order

### Phase 1 — API Client & Connection

1. Create `src/ollama/api-client.ts` — wraps health, tags, show, pull, delete, chat
2. Create `src/ollama/connection.ts` — endpoint config, health check, auth (cloud)
3. Create `src/ollama/model-registry.ts` — cache installed models locally

### Phase 2 — Provider Adapter Refactor

4. Refactor `src/providers/ollama.ts` — add streaming, dual-endpoint (native for metrics, `/v1/` for model listing), concurrency semaphore, cloud auth support
5. Fix `applyEnvOverrides()` colon parsing (split on first colon only) — shared fix with HF, affects all providers
6. Add `OLLAMA_API_KEY` to `keysToStrip` in `getSanitizedCliEnv()`
7. Preserve backward compatibility with `STEROIDS_OLLAMA_HOST`/`STEROIDS_OLLAMA_PORT` env vars

### Phase 3 — Web UI — Sidebar & Pages

8. Add Ollama section to left sidebar navigation
9. Build Connection page (endpoint config, health, version)
10. Build Installed Models page (list from `/api/tags`)
11. Build Model Library page (curated list + manual entry)
12. Build Ready to Use page (paired models management)
13. Build Account page (status, billing link)

### Phase 4 — Model Picker Integration

14. Extend model picker popup to show Ollama model groups
15. Wire paired models into orchestrator/coder/reviewer selection
16. End-to-end test: select Ollama model → run task → get response

### Phase 5 — Usage Tracking & Admin Dashboard

17. Create `src/ollama/metrics.ts` — capture token counts, timing, and tokens/sec per request
18. Add `ollama_usage` and `ollama_paired_models` tables to global DB migration (V20, shared with HF tables)
19. Build admin dashboard widgets (today's usage, per-model breakdown, tokens/sec trends)
20. Display VRAM status and model auto-unload timers

### Phase 6 — Polish

21. Pull progress UI (streamed progress bar)
22. Cold-start timeout handling (local models loading into VRAM)
23. VRAM usage display from `/api/ps`
24. Error UX for connection failures, OOM, model not found

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Ollama not running locally | Health check fails → show "Ollama not detected" with install link |
| Model too large for VRAM | OOM error from Ollama → surface "insufficient memory" in UI, suggest smaller quantization |
| Cold start latency | First inference after model load can take 30-60s → show loading indicator, extend timeout |
| Cloud API key invalid | `/api/tags` returns 401 → clear key, show reconnect prompt |
| Model pulled but incompatible (e.g. embedding-only) | Check `capabilities` from `/api/show`; warn if `"completion"` not present |
| Model lacks tool support | Check `capabilities` from `/api/show` at pairing time. If `"tools"` absent, display warning: "This model does not support tool calling." Do not block pairing but make limitation visible. At invoke time, if response lacks `tool_calls` and prompt included tools, classify as `model_capability_error`. |
| Endpoint URL changed while models paired | Re-validate paired models on connection change; mark unavailable in `ollama_paired_models` table if model not found on new endpoint. **No automatic fallback** — user must re-pair. |
| Local and cloud configured simultaneously | Support one active connection at a time; toggle in Connection page |
| Network loss during model pull | `/api/pull` stream interrupted → show partial progress, allow retry |
| Ollama version too old | Check `/api/version`; require 0.1.14+ for `/v1/` endpoint support. Warn with specific version requirement. |
| Concurrent runners exhaust VRAM | Per-endpoint concurrency semaphore (default: 1 local, 3 cloud). Additional requests queue with timeout. Surface "All Ollama slots busy" in task logs. |
| Mixed config: Anthropic orchestrator + Ollama coder | Fully supported — each role resolves independently through provider registry |
| Model name with `:` in file paths | Ollama model names contain `:` (e.g. `model:tag`). Sanitize to `_` when deriving cache keys or file paths. |
| Disk full during model pull | `/api/pull` will fail mid-stream. Detect incomplete pull state, surface "Insufficient disk space" error, clean up partial download. |

## Non-Goals

- **Model training or fine-tuning** — inference only
- **Modelfile creation/editing** — users manage Modelfiles outside Steroids
- **Multi-instance management** — one Ollama endpoint at a time
- **Embedding generation** — only chat/completion models for coding agents
- **Ollama Spaces or apps** — not relevant to model routing
- **Automatic model recommendations** — user explicitly picks models
- **VRAM optimization or model offloading tuning** — Ollama handles this internally

## Cross-Provider Review (Round 1)

Reviewed by: Claude (`superpowers:code-reviewer`), Claude (`feature-dev:code-reviewer`), Codex (`gpt-5.4`)

See [HF doc Cross-Provider Review](./2026-03-06-huggingface-model-routing.md#cross-provider-review-round-1) for the full 18-finding table. All adopted findings have been incorporated into this document.

Key Ollama-specific fixes applied:
- Acknowledged existing `src/providers/ollama.ts` implementation (§Current Behavior, §4)
- Changed to refactor of existing provider, not new file (§4)
- Added dual-endpoint strategy: native `/api/chat` for metrics, `/v1/models` for UI listing (§4)
- Added concurrency semaphore for parallel runners (§4)
- Increased `num_ctx` default from 2048 to 32768 (§4)
- Moved usage tables to global DB (§6)
- Ollama model library changed to curated list + manual entry (§8)
- Added tool support validation at pairing time (§5)
- Added minimum Ollama version requirement: 0.1.14+ (§9)
- Preserved `STEROIDS_OLLAMA_HOST`/`PORT` env var backward compatibility (§9)
- Added model name sanitization rules for `:` in file paths (§9)

## Cross-Provider Review (Round 2)

Reviewed by: Claude (`superpowers:code-reviewer`), Claude (`feature-dev:code-reviewer`), Codex (`gpt-5.4`)

See [HF doc Cross-Provider Review (Round 2)](./2026-03-06-huggingface-model-routing.md#cross-provider-review-round-2) for the full 6-finding table. All adopted.

Key Ollama-specific fixes applied in round 2:
- Fixed inference endpoint in API flow table: `POST /api/chat` (native), not `/v1/chat/completions`
- Added semaphore invariants: `try/finally` release, held until `done: true` NDJSON chunk, not just connection
- Added `UNIQUE(model_name, runtime, endpoint)` constraint to `ollama_paired_models`
- Added `model_info.{family}` key iteration strategy for context_length lookup
- Fixed implementation phase numbering (no duplicate step numbers)
- Added V20 shared migration note

## Cross-Provider Review (Round 3)

Reviewed by: Claude (`superpowers:code-reviewer`), Claude (`feature-dev:code-reviewer`), Codex (`gpt-5.4`)

See [HF doc Cross-Provider Review (Round 3)](./2026-03-06-huggingface-model-routing.md#cross-provider-review-round-3) for the full 6-finding table. All adopted.

Key Ollama-specific fixes applied in round 3:
- Rewrote stale §1 line 104 — now correctly states `/v1/` is for model listing only, inference uses native `/api/chat`
- Added `available INTEGER DEFAULT 1` column to `ollama_paired_models` table
- Added `role TEXT` nullable column to `ollama_usage` table for per-role dashboard breakdown
- Flagged `applyEnvOverrides` colon parsing as pre-existing live bug, not gated on integration work
- Added `model_capability_error` shared type dependency note to §9
