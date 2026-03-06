# Hugging Face Model Routing

> **Status:** Draft
> **Date:** 2026-03-06
> **Author:** Human (requirements), Claude (design)
> **Related:** [Ollama Model Routing](./2026-03-06-ollama-model-routing.md) — sibling integration, same UI patterns

## Problem Statement

Steroids currently only supports Anthropic models (Sonnet, Opus, Haiku) for orchestrator, coder, and reviewer roles. Users who want to run cheaper or experimental models — DeepSeek-V3, Qwen-Coder, Mixtral, Llama — have no path to do so within the existing UI or provider system.

Hugging Face operates an inference router (`router.huggingface.co`) that fronts dozens of GPU providers (Together, Fireworks, Groq, Cerebras, etc.) behind an OpenAI-compatible API. By integrating this router as a provider, Steroids can offer hundreds of models without managing individual provider credentials.

## Current Behavior

- Model selection happens in the web UI popup for orchestrator/coder/reviewer roles
- Available models are hardcoded to the Anthropic family: `sonnet`, `opus`, `haiku`
- Provider adapters live in `src/providers/` with a registry pattern
- The left sidebar has no Hugging Face section
- No model discovery, caching, or search exists

## Desired Behavior

### Web UI — Left Sidebar

A new **Hugging Face** section in the left menu with:

1. **Account connection** — link/unlink HF account (API token)
2. **Curated models** — pre-populated list of ~100 high-quality text-generation models
3. **Model search** — search across all HF models with inference provider support
4. **Ready to use** — column showing models paired with a runtime (Claude Code or OpenCode)

### Model Selection Popup

The existing orchestrator/coder/reviewer model picker expands from:

```
Claude Code (Anthropic)
  ├─ Sonnet
  ├─ Opus
  └─ Haiku
```

To:

```
Claude Code (Anthropic)
  ├─ Sonnet
  ├─ Opus
  └─ Haiku

Claude Code (Hugging Face)
  ├─ deepseek-ai/DeepSeek-V3
  ├─ Qwen/Qwen2.5-Coder-32B-Instruct
  ├─ mistralai/Mixtral-8x22B-Instruct-v0.1
  ├─ meta-llama/Llama-3.3-70B-Instruct
  └─ ... (from curated list + user additions)

OpenCode (Hugging Face)
  ├─ deepseek-ai/DeepSeek-V3
  ├─ Qwen/Qwen2.5-Coder-32B-Instruct
  └─ ...
```

Models in "Ready to use" are those the user has explicitly paired with a runtime.

## Design

### 1. Hugging Face Hub Client

A new module that wraps the four required Hub API endpoints.

**File:** `src/huggingface/hub-client.ts`

```
Endpoints used:
  GET /api/models                                    → list/search models
  GET /api/models/{id}                               → single model metadata
  GET /api/models/{id}?expand=inferenceProviderMapping → provider availability
  POST https://router.huggingface.co/v1/chat/completions → inference
```

**List models (discovery):**

```
GET https://huggingface.co/api/models
  ?pipeline_tag=text-generation
  &inference_provider=all
  &sort=downloads
  &direction=-1
  &limit=100
```

Returns: `id`, `downloads`, `likes`, `tags`, `pipeline_tag`, `config`.

**Model detail + providers:**

```
GET https://huggingface.co/api/models/{model_id}?expand=inferenceProviderMapping
```

Returns provider mapping array:
```json
{
  "inferenceProviderMapping": {
    "together": { "providerId": "deepseek-ai/DeepSeek-V3", "status": "live" },
    "fireworks": { "providerId": "...", "status": "live" }
  }
}
```

**Search (arbitrary query):**

```
GET https://huggingface.co/api/models
  ?search={query}
  &pipeline_tag=text-generation
  &inference_provider=all
  &limit=20
```

### 2. Model Registry & Cache

**File:** `src/huggingface/model-registry.ts`

The registry maintains a local cache of curated models, refreshed every 24 hours.

**Cache location:** `~/.steroids/huggingface/models.json`

**Cache schema:**

```ts
interface HFModelCache {
  lastUpdated: number;          // epoch ms
  models: HFCachedModel[];
}

interface HFCachedModel {
  id: string;                   // e.g. "deepseek-ai/DeepSeek-V3"
  pipelineTag: string;          // "text-generation"
  downloads: number;
  likes: number;
  tags: string[];
  providers: string[];          // ["together", "fireworks", "groq"]
  addedAt: number;              // epoch ms
  source: 'curated' | 'search' | 'manual';
}
```

**Curated list generation:**

The registry fetches four sorted lists and merges them:

| Query | Sort | Purpose |
|-------|------|---------|
| `sort=downloads&direction=-1&limit=50` | Most downloaded | Proven models |
| `sort=likes&direction=-1&limit=50` | Most liked | Community favorites |
| `sort=createdAt&direction=-1&limit=30` | Newest | Fresh releases |
| `sort=trendingScore&direction=-1&limit=30` | Trending | Current momentum |

**Note:** The `trendingScore` sort parameter needs verification against the live API during implementation. If not supported, drop the trending query and use three lists instead.

Duplicates removed by model ID. Final list trimmed to ~100 models.

**Ranking score:**

```
score = (0.4 × norm_downloads) + (0.3 × norm_likes) + (0.15 × norm_recency) + (0.15 × position_in_trending)
```

If the trending query is unavailable, simplify to:
```
score = (0.5 × norm_downloads) + (0.3 × norm_likes) + (0.2 × norm_recency)
```

Models sorted by score descending in the UI.

### 3. Authentication

**File:** `src/huggingface/auth.ts`

**Storage:** `~/.steroids/huggingface/token` (file, `0600` permissions, parent directory `0700`)

The HF API token is required for:
- Higher rate limits on Hub API
- Access to gated models
- Inference router authentication

**Token scope requirement:** Users should create a **fine-grained token** with only `inference` and `read` scopes. Broad tokens (`write`, `admin`) grant unnecessary access. The Account page should display a warning if the token has write/admin scopes (detectable from `/api/whoami-v2` response).

**Token security:**
- Never echo token in logs, crash reports, or error messages
- Add `HF_TOKEN` to `keysToStrip` in `getSanitizedCliEnv()` (`src/providers/interface.ts`)
- Redact `Authorization` header from any logged HTTP requests
- Token stored with `0600` permissions in a directory with `0700` permissions

The web UI provides a connect/disconnect flow:
1. User pastes HF API token in settings
2. Token validated via `GET /api/whoami-v2` (single endpoint for both validation and account info)
3. Stored locally, never committed

### 4. Provider Adapter

**File:** `src/providers/huggingface.ts`

A new provider adapter registered in the provider registry. Implements the same interface as the Anthropic adapter.

**Inference endpoint:**

```
POST https://router.huggingface.co/v1/chat/completions
Authorization: Bearer {hf_token}
Content-Type: application/json

{
  "model": "deepseek-ai/DeepSeek-V3",
  "messages": [...],
  "stream": true
}
```

The router API is OpenAI-compatible. The adapter:
- Translates Steroids' internal prompt format to OpenAI chat format
- Handles streaming responses
- Maps errors to Steroids' error types
- Appends routing suffix to model ID (see Routing Policies below)

#### Routing Policies

Provider selection is controlled by appending a colon-separated suffix to the model ID in the request body:

```
{org}/{model-name}:{policy_or_provider}
```

| Suffix | Behavior |
|--------|----------|
| `:fastest` | Highest throughput (tokens/s). **Reported as default when no suffix given; verify at implementation time as HF docs are inconsistent on whether omission means fastest or preference-ordered.** |
| `:cheapest` | Lowest price per output token |
| `:preferred` | First available from user's preference order at `hf.co/settings/inference-providers` |
| `:{provider-name}` | Force a specific provider (e.g. `:groq`, `:together`, `:sambanova`, `:fireworks-ai`, `:novita`, `:cerebras`) |

**Examples:**

```json
{"model": "meta-llama/Llama-3.3-70B-Instruct"}           // default = :fastest
{"model": "meta-llama/Llama-3.3-70B-Instruct:cheapest"}   // cheapest provider
{"model": "meta-llama/Llama-3.3-70B-Instruct:groq"}       // force Groq
```

#### Per-Provider Pricing & Capabilities

The router exposes per-provider data via:

```
GET https://router.huggingface.co/v1/models
Authorization: Bearer {hf_token}
```

Returns a `providers` array per model:

```json
{
  "id": "meta-llama/Llama-3.3-70B-Instruct",
  "providers": [
    {
      "provider": "groq",
      "status": "live",
      "context_length": 131072,
      "pricing": {
        "input": 0.15,
        "output": 0.75
      },
      "supports_tools": true,
      "supports_structured_output": false,
      "is_model_author": false
    },
    {
      "provider": "novita",
      "status": "live",
      "context_length": 131072,
      "pricing": {
        "input": 0.05,
        "output": 0.25
      },
      "supports_tools": true,
      "supports_structured_output": true,
      "is_model_author": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Provider slug |
| `status` | string | `"live"` or `"staging"` |
| `context_length` | number | Max context window (tokens) — not always present |
| `pricing.input` | number | USD per million input tokens — not always present |
| `pricing.output` | number | USD per million output tokens — not always present |
| `supports_tools` | boolean | Function/tool calling support |
| `supports_structured_output` | boolean | JSON mode / structured output support |
| `is_model_author` | boolean | Provider is the model's original author |

HF has zero markup — prices are provider pass-through. Some providers (e.g. `scaleway`, `featherless-ai`) don't expose pricing.

**Implementation note:** The `/v1/models` pricing schema was reported from live API testing but is not in official HF documentation. During implementation, verify this endpoint returns the `providers` array with `pricing` fields. If not available, fall back to the Hub API's `inferenceProviderMapping` (which lacks pricing) and maintain a local pricing lookup table.

**Latency data**: Not available via API. The router uses throughput metrics internally for `:fastest` but does not expose them.

### 5. Runtime Pairing

Each HF model can be paired with a runtime. "Runtime" refers to which CLI tool Steroids spawns as the agent subprocess — the HF model replaces the default model inside that runtime's invocation.

| Runtime | Mechanism |
|---------|-----------|
| **Claude Code** | Steroids spawns `claude` CLI but overrides the model endpoint to `router.huggingface.co/v1` via the HF provider adapter. The adapter translates Steroids' prompt format to the OpenAI-compatible chat format the router expects. Claude Code itself is not involved in inference — Steroids calls the HF router directly. |
| **OpenCode** | Steroids spawns `opencode` CLI configured to use the HF router as its OpenAI-compatible backend. |

**Important:** The runtime label in the UI is a user-facing concept for grouping. Under the hood, both runtimes invoke the same HF provider adapter (`src/providers/huggingface.ts`). The adapter calls `router.huggingface.co/v1/chat/completions` directly — it does not proxy through Claude Code or OpenCode CLIs.

**Tool support validation:** At pairing time, check whether the model/provider combination supports tool calling (`supports_tools` from `/v1/models`). If not, display a warning: "This model does not support tool calling. Agent tasks requiring file edits and bash execution will fail." Do not block pairing — the user may want the model for non-agent use — but make the limitation visible.

Paired models are stored in the global Steroids database (see §7 Usage Tracking).

The `routingPolicy` is appended as a suffix when making inference requests:
- `"fastest"` → `"deepseek-ai/DeepSeek-V3:fastest"` (default)
- `"cheapest"` → `"deepseek-ai/DeepSeek-V3:cheapest"`
- `"groq"` → `"deepseek-ai/DeepSeek-V3:groq"` (specific provider)

### 6. Account & Billing Status

**File:** `src/huggingface/account.ts`

#### Account Info (available via API)

```
GET https://huggingface.co/api/whoami-v2
Authorization: Bearer {hf_token}
```

Returns:

| Field | Description |
|-------|-------------|
| `name` | Username |
| `type` | Account type (`"user"`) |
| `isPro` | Boolean — PRO subscription active |
| `canPay` | Boolean — payment method configured |
| `periodEnd` | Subscription period expiration |
| `orgs[].canPay` | Org payment status |
| `orgs[].isEnterprise` | Org Enterprise plan status |

#### Credit Tiers (determined from `isPro`)

| Account Type | Monthly Inference Credits |
|--------------|--------------------------|
| Free | $0.10 |
| PRO | $2.00 |
| Enterprise org | $2.00/seat |

#### Billing API Limitations

**No billing/credits API exists.** Hugging Face does not expose endpoints for:
- Current credit balance or remaining credits
- Usage/consumption history
- Per-request cost

The only programmatic signals available:
- **`isPro` from `/api/whoami-v2`** — determines credit tier
- **`402` HTTP error at inference time** — credits exhausted
- **Hub API rate limit headers** — `RateLimit` and `RateLimit-Policy` (request-count based, not credit-based)

#### Hub API Rate Limits (from response headers)

Headers follow the IETF draft standard:

```
RateLimit: "api";r=489;t=189
RateLimit-Policy: "fixed window";"api";q=500;w=300
```

| Plan | Requests per 5 min |
|------|--------------------|
| Anonymous | 500 |
| Free user | 1,000 |
| PRO user | 2,500 |
| Enterprise org | 6,000 |

#### Account Page Display

```
Username: {name}
Tier: Free / PRO / Enterprise
Payment: Configured / Not configured
Credits: ~$0.10/mo (Free) or ~$2.00/mo (PRO)
Status: Active / Credits exhausted (402 detected)
Manage billing: https://huggingface.co/settings/billing
Usage dashboard: https://huggingface.co/settings/inference-providers/overview
```

**What we can show:**
- Username, tier (`isPro`), payment method status (`canPay`)
- Estimated credit tier amount (static lookup from tier)
- Credit exhaustion detection (402 error flag)
- Hub API rate limit consumption (from response headers)
- Links to billing and usage dashboards (external)

**What we cannot show (no API):**
- Exact remaining credit balance
- Per-model or per-request costs
- Historical usage breakdown
- Spending trends

#### Org Billing (Deferred)

HF supports `X-HF-Bill-To: {org-name}` header for org billing. The `/api/whoami-v2` response includes `orgs[].canPay` and `orgs[].isEnterprise` data. However, implementing an org selector in the UI adds complexity with limited value for v1. **Deferred to a future version.** When implemented, add an org dropdown to the Account page and include the header on inference requests.

### 7. Per-Request Metrics & Usage Tracking

**File:** `src/huggingface/metrics.ts`

The HF router returns OpenAI-compatible responses including token usage. Like Ollama, HF has no historical usage API, so Steroids must log data locally.

#### Token Counts (from inference response)

The router response includes the standard `usage` object:

| Field | Type | Description |
|-------|------|-------------|
| `usage.prompt_tokens` | integer | Input tokens processed |
| `usage.completion_tokens` | integer | Output tokens generated |
| `usage.total_tokens` | integer | Sum of both |

#### Cost Estimation

Since the router exposes per-provider pricing via `GET /v1/models`, Steroids can calculate estimated cost per request:

```
estimated_cost = (prompt_tokens × pricing.input / 1_000_000)
               + (completion_tokens × pricing.output / 1_000_000)
```

This is an estimate — actual billing may differ slightly due to HF's internal metering.

#### Steroids-Side Usage Logging

**Storage:** New tables in the existing global database (`~/.steroids/global.db`), not a separate database. This avoids the multiple-DB problems (no cross-provider JOIN, no migration system, concurrent access issues with `better-sqlite3` blocking the event loop).

```sql
CREATE TABLE hf_usage (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  provider TEXT,                    -- which provider served the request (nullable for auto-routed)
  routing_policy TEXT,              -- fastest/cheapest/preferred/{provider}
  role TEXT,                        -- 'coder' | 'reviewer' | 'orchestrator' (nullable for legacy rows)
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated_cost_usd REAL,          -- computed from cached pricing
  created_at INTEGER NOT NULL       -- epoch ms
);

CREATE TABLE hf_paired_models (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,           -- "deepseek-ai/DeepSeek-V3"
  runtime TEXT NOT NULL,            -- 'claude-code' | 'opencode'
  routing_policy TEXT DEFAULT 'fastest',
  supports_tools INTEGER DEFAULT 0, -- cached from /v1/models
  available INTEGER DEFAULT 1,      -- 0 if model removed from Hub or providers gone
  added_at INTEGER NOT NULL,
  UNIQUE(model_id, runtime)         -- prevent duplicate pairings; upsert on conflict
);
```

**Provider identity for auto-routed requests:** When using `:fastest` or `:cheapest`, the HF router selects the provider server-side. The response may not include which provider was used. The `provider` column is nullable — populated only when a specific provider was requested or when the response includes provider info in headers. Per-provider cost breakdowns are approximate for auto-routed requests.

This enables:
- Per-model token usage over time
- Cost tracking per model (approximate for auto-routed requests)
- Routing policy effectiveness comparison
- Total spend estimation for the admin panel
- Cross-provider aggregation with Ollama usage in a single query

#### Admin Dashboard Display

```
Today's Usage:
  Total tokens: 87,200 (prompt: 71,400 / completion: 15,800)
  Requests: 32
  Estimated cost: $0.04

Per Model (last 7 days):
  deepseek-ai/DeepSeek-V3     — 201K tokens, ~$0.12, via Novita (cheapest)
  Qwen/Qwen2.5-Coder-32B      — 94K tokens, ~$0.08, via Together (fastest)

Account:
  Tier: PRO ($2.00/mo credits)
  Status: Active
  Hub API rate: 2,418/2,500 remaining (resets in 3m 12s)
```

### 8. Web UI Components

**Left sidebar — Hugging Face section:**

```
[HF icon] Hugging Face
  ├─ Account          → connect/disconnect, username, tier, billing link
  ├─ Model Library    → curated list with search
  └─ Ready to Use     → paired models, editable
```

**Model Library page:**

| Column | Source |
|--------|--------|
| Model ID | `model.id` |
| Downloads | `model.downloads` (formatted: 1.2M) |
| Likes | `model.likes` |
| Providers | Badge list with pricing: "Groq $0.15/$0.75", "Novita $0.05/$0.25" |
| Context | Max context length across providers |
| Tool Support | Checkmark if any provider supports tools |
| Actions | "Pair with Claude Code" / "Pair with OpenCode" |

Provider data sourced from `GET router.huggingface.co/v1/models` — cached alongside model registry.

Search bar filters the cached curated list first (client-side). If no match, falls back to Hub API search (debounced 500ms, results cached for 5 minutes). This avoids burning Hub API rate limits on keystroke-by-keystroke searches.

**Ready to Use page:**

| Column | Source |
|--------|--------|
| Model ID | paired model ID |
| Runtime | Claude Code / OpenCode badge |
| Routing Policy | Dropdown: Fastest / Cheapest / Preferred / {specific provider} |
| Price Indicator | Input/output price from selected provider or range if auto |
| Context Length | From provider data |
| Available | Green/red indicator from `available` column |
| Actions | Remove, Change runtime, Change routing |

**Pricing & context data strategy:** The Ready to Use page displays pricing and context length sourced from the in-memory model registry cache (populated from `GET /v1/models`). These values are **not stored in the `hf_paired_models` table** — they are looked up at render time from the cached registry. If the cache is stale or model data is missing, columns show "—" with a "Refresh" action. This avoids duplicating volatile pricing data into SQLite.

**Provider detail panel (expandable per model):**

When a user clicks a model row, show a provider comparison panel:

| Provider | Input $/M | Output $/M | Context | Tools | Structured Output | Author |
|----------|-----------|------------|---------|-------|--------------------|--------|
| Groq | $0.15 | $0.75 | 131K | Yes | No | No |
| Novita | $0.05 | $0.25 | 131K | Yes | Yes | No |
| Together | $0.18 | $0.88 | 131K | Yes | Yes | No |

User can select a specific provider from this panel or choose a routing policy (Fastest/Cheapest/Preferred).

**Model picker popup (existing, extended):**

Groups models by provider:
- "Anthropic" group — existing hardcoded models
- "Hugging Face (Claude Code)" group — paired models with `runtime: 'claude-code'`
- "Hugging Face (OpenCode)" group — paired models with `runtime: 'opencode'`

### 9. Config Integration

**Required codebase changes:**

1. Add `'hf'` to `ProviderName` union in `src/config/loader.ts`:
   ```ts
   export type ProviderName = 'claude' | 'gemini' | 'openai' | 'codex' | 'mistral' | 'minimax' | 'ollama' | 'hf';
   ```

2. Add `'hf'` to `CONFIG_SCHEMA._options` arrays in `src/config/schema.ts`

3. Register `HuggingFaceProvider` in `createDefaultRegistry()` in `src/providers/registry.ts`

4. Add `'HF_TOKEN'` to `keysToStrip` in `getSanitizedCliEnv()` in `src/providers/interface.ts`

5. Add `'model_capability_error'` to `ProviderErrorType` union in `src/providers/interface.ts` with `retryable: false` in `classifyError()` — shared change for both HF and Ollama. This prevents the orchestrator from retrying tasks that fail due to missing tool support (which would create a soft death spiral).

**Config format uses the existing `{ provider, model }` object shape** — not a `"hf:model"` prefix string. The existing config schema already defines `ai.coder`, `ai.reviewer`, `ai.orchestrator` as objects with `provider` and `model` fields. We use this format:

```yaml
# In steroids config.yaml
ai:
  coder:
    provider: hf
    model: deepseek-ai/DeepSeek-V3
  reviewer:
    provider: hf
    model: Qwen/Qwen2.5-Coder-32B-Instruct
  orchestrator:
    provider: claude
    model: claude-sonnet-4-6
```

The `model` field is an opaque string passed directly to the provider adapter. For HF, it's the full `org/model` ID. The routing policy suffix (`:cheapest`, `:groq`) is appended by the adapter at inference time based on the paired model's `routing_policy` setting, not stored in the config model string.

**Environment variable override fix (pre-existing live bug):** The existing `STEROIDS_AI_REVIEWERS` parser in `applyEnvOverrides()` (`src/config/loader.ts:252`) uses `split(':')` which truncates multi-colon model names. **This bug exists in the current codebase and affects any provider with multi-colon model names (e.g. `ollama:deepseek-coder-v2:33b`).** It should be fixed independently of the HF/Ollama integration work — it is not gated on either phase. Fix: split on first colon only:

```ts
// Before (broken for multi-colon model names):
const [provider, model] = s.split(':');

// After:
const idx = s.indexOf(':');
const provider = s.slice(0, idx);
const model = s.slice(idx + 1);
```

Example: `STEROIDS_AI_REVIEWERS="hf:deepseek-ai/DeepSeek-V3"` → `{ provider: 'hf', model: 'deepseek-ai/DeepSeek-V3' }`

**Model ID sanitization:** HF model IDs contain `/` (e.g. `deepseek-ai/DeepSeek-V3`). When deriving cache keys or file paths from model IDs, replace `/` with `--` to avoid path traversal. Never use raw model IDs as filesystem path components.

## Implementation Order

### Phase 1 — Hub Client & Registry

1. Create `src/huggingface/hub-client.ts` — API wrapper (list, detail, search)
2. Create `src/huggingface/model-registry.ts` — cache, curated list generation, ranking
3. Create `src/huggingface/auth.ts` — token storage and validation
4. Add refresh command: `steroids hf refresh` (manual cache rebuild)

### Phase 2 — Provider Adapter & Config Changes

5. Add `'hf'` to `ProviderName` union, `CONFIG_SCHEMA`, and `getSanitizedCliEnv()` key strip list
6. Fix `applyEnvOverrides()` colon parsing (split on first colon only) — affects all providers with multi-colon model names
7. Create `src/providers/huggingface.ts` — OpenAI-compatible adapter with SSE error event parsing
8. Register `HuggingFaceProvider` in `createDefaultRegistry()`

### Phase 3 — Web UI — Sidebar & Model Library

9. Add Hugging Face section to left sidebar navigation
10. Build Account page (connect/disconnect)
11. Build Model Library page (curated list + search)
12. Build Ready to Use page (paired models management)

### Phase 4 — Model Picker Integration

13. Extend model picker popup to show HF model groups
14. Wire paired models into orchestrator/coder/reviewer selection
15. End-to-end test: select HF model → run task → get response

### Phase 5 — Usage Tracking & Admin Dashboard

16. Create `src/huggingface/metrics.ts` — capture token counts and cost per request
17. Add `hf_usage` and `hf_paired_models` tables to global DB migration (V20, shared with Ollama tables)
18. Build admin dashboard widgets (today's usage, per-model breakdown, cost estimates)
19. Display Hub API rate limit status from response headers

### Phase 6 — Polish

20. Add 24h auto-refresh for curated list
21. Add routing policy selection UI (Fastest/Cheapest/Preferred/specific provider)
22. Provider comparison panel per model (pricing, context, capabilities)
23. Error handling for rate limits, gated models, provider outages

## Edge Cases

| Scenario | Handling |
|----------|----------|
| HF token expired or revoked | `/api/whoami-v2` returns 401 → clear token, show reconnect prompt |
| Model removed from Hub | Registry refresh removes it from cache. Paired models table marks as "unavailable" on next page load. Task invocations with a missing model fail with `model_not_found` — **no automatic fallback** (determinism policy). User must re-pair or remove. |
| No inference providers for model | Don't show in curated list; search results show "No providers" badge, disable pairing |
| Router returns 429 (rate limit) | Exponential backoff, surface in task logs |
| Router returns 503 (provider down) | Mark task as failed with clear error. **No silent retry with different routing policy** — if user chose a specific provider, respect that choice. Nondeterministic fallback chains violate repo policy (AGENTS.md §Determinism First). |
| Credits exhausted mid-stream (SSE) | HF sends HTTP 200 then streams tokens via SSE. If credits exhaust mid-response, an `event: error` chunk arrives (not HTTP 402). The adapter must parse SSE events, detect error events, and classify as `credit_exhaustion` with `success: false`. Do not treat truncated output as a valid response — the agent will act on incomplete code edits. |
| Credits exhausted pre-stream (HTTP) | Router returns HTTP 402 before streaming starts — standard error path, surface "Credits exhausted" in UI |
| Model lacks tool support | Agent sends tool-calling messages but model returns plain text instead of structured tool calls. Adapter must detect: if response lacks `tool_calls` and the prompt included tools, classify as `model_capability_error`. Surface: "Model does not support tool calling — select a model with tool support for agent tasks." |
| Cache file corrupted | Delete and rebuild on next access |
| User pairs model then loses network | Cached model metadata still works; inference fails at runtime with network error |
| Hub API pagination needed | Follow `Link` header for curated list build; search limited to 20 results |
| Mixed provider config (Anthropic orchestrator + HF coder) | Fully supported — each role resolves independently through provider registry |
| Model ID with special characters in file paths | HF model IDs contain `/`. Sanitize to `--` when deriving cache keys or file paths. Never use raw model IDs as path components. |

## Non-Goals

- **Running local/self-hosted models** — this integration is for HF router-served models only
- **Fine-tuning or training** — out of scope; this is inference only
- **HF Spaces integration** — no plan to embed or launch Spaces
- **Dataset browsing** — not relevant to model selection
- **Multi-tenant token management** — single user, single token
- **Per-request cost metering** — HF handles billing via prepaid credits; Steroids shows tier/status but doesn't meter individual requests
- **Automatic model selection** — user explicitly picks models; no AI-driven recommendation

## API Flow Comparison — Hugging Face vs Ollama

| Step | Hugging Face | Ollama |
|------|-------------|--------|
| Discovery | `GET huggingface.co/api/models` (Hub catalog) | `GET /api/tags` (installed models) |
| Metadata | `GET /api/models/{id}` | `POST /api/show` |
| Provider info | `GET /api/models/{id}?expand=inferenceProviderMapping` | N/A (Ollama IS the provider) |
| Inference | `POST router.huggingface.co/v1/chat/completions` | `POST /api/chat` (native, for timing metrics) |
| Model install | N/A (router handles it) | `POST /api/pull` |
| Health check | `GET /api/whoami-v2` | `GET /` |
| Account info | `GET /api/whoami-v2` (tier, payment) | No API |
| Billing | No balance API; 402 on exhaustion; prepaid credits with auto top-up | No API; subscription tiers ($0/$20/$100) |

### Shared Abstractions (with shared code)

Both providers reuse:
- **`ProviderName` union** — `'hf'` and `'ollama'` in the same type
- **Provider registry** — same `IAIProvider` interface, same `invoke()` contract
- **Config schema** — same `{ provider, model }` object shape for `ai.coder`, `ai.reviewer`, `ai.orchestrator`
- **Global DB usage tables** — `hf_usage` and `ollama_usage` in the same `~/.steroids/global.db`, enabling cross-provider aggregation
- **Model picker grouping** — provider → runtime → model list (same UI component)
- **OpenAI-compatible inference** — both use `/v1/chat/completions` format
- **`getSanitizedCliEnv()`** — both providers' tokens stripped from child env

**UI differences (acceptable):**
- HF has routing policy selector (fastest/cheapest/preferred/specific); Ollama does not (single provider)
- HF has pricing columns; Ollama does not (local is free, cloud is subscription)
- Ollama has VRAM/loaded models display; HF does not (cloud inference)

## Cross-Provider Review (Round 1)

Reviewed by: Claude (`superpowers:code-reviewer`), Claude (`feature-dev:code-reviewer`), Codex (`gpt-5.4`)

**18 findings across 3 reviewers (deduplicated). All adopted findings have been incorporated into this document.**

| # | Theme | Severity | Decision |
|---|-------|----------|----------|
| 1 | Config schema mismatch — string prefix vs `{ provider, model }` object | Critical | **Adopted** — fixed §9 to use existing object schema |
| 2 | Model ID colon parsing — `split(':')` truncates multi-colon IDs | Critical | **Adopted** — specified first-colon-only parsing in §9 |
| 3 | Existing `src/providers/ollama.ts` ignored (Ollama doc) | High | **Adopted** — Ollama doc now acknowledges existing impl |
| 4 | `/v1/` vs native API contradiction for Ollama metrics | High | **Adopted** — Ollama doc specifies dual-endpoint strategy |
| 5 | Runtime pairing mechanism was vague hand-wave | Critical | **Adopted** — clarified in §5 that adapter calls HF router directly |
| 6 | HF `/v1/models` pricing schema unverified | High | **Deferred** — added verification note in §4 |
| 7 | Separate SQLite databases per provider | Medium | **Adopted** — moved to global DB tables in §7 |
| 8 | Silent 503 fallback violates determinism policy | High | **Adopted** — removed in edge cases table |
| 9 | HF 402 mid-stream as SSE error event | High | **Adopted** — added SSE error handling to edge cases |
| 10 | Ollama concurrent VRAM exhaustion | Medium | **Adopted** — added concurrency semaphore in Ollama §4 |
| 11 | Tool support validation at pairing time | Medium | **Adopted** — added to §5 in both docs |
| 12 | Token security — scope minimization, redaction | High | **Adopted** — expanded §3 with scope requirements |
| 13 | `whoami` vs `whoami-v2` inconsistency | Medium | **Adopted** — consolidated to `whoami-v2` only |
| 14 | `num_ctx: 2048` too small for coding tasks | Medium | **Adopted** — changed to 32768 with auto-detect |
| 15 | `sort=trending` may not be valid API param | Low | **Adopted** — added verification note, fallback formula |
| 16 | Ollama model library search has no API | Medium | **Adopted** — changed to curated list + manual entry |
| 17 | HF provider identity unknown in auto-routed requests | Medium | **Adopted** — `provider` column marked nullable in §7 |
| 18 | Model ID characters in filenames/cache keys | Low | **Adopted** — added sanitization rules in §9 |

## Cross-Provider Review (Round 2)

Reviewed by: Claude (`superpowers:code-reviewer`), Claude (`feature-dev:code-reviewer`), Codex (`gpt-5.4`)

**6 new findings across 3 reviewers (all convergent). All adopted.**

| # | Theme | Severity | Decision |
|---|-------|----------|----------|
| R2-1 | Ollama API flow table still said `/v1/chat/completions` for inference, contradicting §4 dual-endpoint | High | **Adopted** — fixed both comparison tables |
| R2-2 | `model_capability_error` not in `ProviderErrorType` — falls through to `unknown` (retryable), causing retry loop | High | **Adopted** — added to required type changes in §9 |
| R2-3 | Semaphore slot leak on request error — no `finally`-guarded release | High | **Adopted** — added invariants + pseudocode in Ollama §4 |
| R2-4 | Semaphore held until connection, not stream completion — bypasses maxConcurrent | High | **Adopted** — specified "held until `done: true`" in Ollama §4 |
| R2-5 | No UNIQUE constraint on paired model tables — duplicate rows possible | Medium | **Adopted** — added `UNIQUE` constraints in §7 |
| R2-6 | `model_info.{family}` key is architecture-specific, not fixed — context_length lookup undefined | Medium | **Adopted** — added iteration strategy in Ollama §6 |

Implementation phase numbering corrected across both docs. Migration version note added (V20 shared).

## Cross-Provider Review (Round 3)

Reviewed by: Claude (`superpowers:code-reviewer`), Claude (`feature-dev:code-reviewer`), Codex (`gpt-5.4`)

**6 new findings across 3 reviewers. All adopted.**

| # | Theme | Severity | Decision |
|---|-------|----------|----------|
| R3-1 | Ollama §1 line 104 still says "defaults to `/v1/` for inference" — contradicts §4 dual-endpoint strategy | Important | **Adopted** — rewritten to clarify `/v1/` is model listing only |
| R3-2 | No `available` column in paired-model tables — edge case "mark unavailable" has no column to set | Medium | **Adopted** — added `available INTEGER DEFAULT 1` to both tables |
| R3-3 | No `role` column in usage tables — can't break down usage by coder/reviewer/orchestrator in admin dashboard | Medium | **Adopted** — added `role TEXT` nullable column to both usage tables |
| R3-4 | `hf_paired_models` missing Price/Context columns for Ready to Use page display | Medium | **Adopted** — documented cache-only strategy: pricing/context read from in-memory registry, not stored in SQLite |
| R3-5 | `applyEnvOverrides` colon parsing fix should be flagged as pre-existing live bug independent of phase work | Important | **Adopted** — both docs now flag it as pre-existing bug, not gated on integration phases |
| R3-6 | Ollama doc doesn't mention `model_capability_error` type change dependency on HF doc §9 | Medium | **Adopted** — added shared type dependency note to Ollama §9 |
