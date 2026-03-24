# HuggingFace Model Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Claude, Codex, and Vibe CLIs to use any HuggingFace model by running a local OpenAI-compatible proxy that translates API formats.

**Architecture:** A lightweight HTTP proxy (`steroids proxy`) that listens locally, accepts OpenAI-format and Anthropic-format requests, and forwards them to the HF Router (`https://router.huggingface.co/v1`). The proxy normalizes the `/v1/models` response to match what each CLI expects and translates between Anthropic Messages API and OpenAI Chat Completions format. Provider implementations inject the proxy URL via env vars (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`) when HF models are configured.

**Tech Stack:** Node.js `http.createServer` (no Express — this is a thin proxy, not a feature-rich API). Streams request/response bodies for chat completions. Part of the steroids-cli package (not the API server).

---

## Problem Statement

CLI tools (Claude, Codex, Vibe) are locked to their native APIs. Users want to run HuggingFace models through these CLIs for cost savings and model diversity. The HF Router exposes an OpenAI-compatible `/v1/chat/completions` endpoint, but:

1. **Codex** fails because HF's `/v1/models` response includes extra fields (`providers`, `architecture`) that Codex's Rust parser rejects (`missing field 'models'`).
2. **Claude CLI** only speaks the Anthropic Messages API format — cannot connect to OpenAI-compatible endpoints.
3. **Vibe CLI** only speaks the Mistral API format — same problem as Claude.
4. `getSanitizedCliEnv()` strips API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) from child processes, so even if the CLI supported it, the keys wouldn't reach it.

## Current Behavior

- OpenCode is the only CLI that natively supports HF models (`huggingface/org/model` format via opencode.json config).
- Claude, Codex, and Vibe providers spawn their CLIs with `getSanitizedCliEnv()` which strips all third-party API keys.
- Each provider passes `{ HOME: isolatedHome }` as env overrides — the only injection point for additional env vars.
- HF Router base URL: `https://router.huggingface.co/v1`, auth: `Bearer hf_...` token.

## Desired Behavior

When a user configures an HF model for any role (e.g., `ai.coder.provider: claude, ai.coder.model: MiniMaxAI/MiniMax-M2.5`), steroids:
1. Starts the local proxy automatically (if not already running).
2. Injects `OPENAI_BASE_URL=http://127.0.0.1:<port>` + `OPENAI_API_KEY=hf-proxy` (or `ANTHROPIC_BASE_URL` for Claude) into the provider's env.
3. The proxy translates requests and forwards them to the HF Router.
4. The CLI tool works as if it's talking to its native API.

## Design

### Proxy Server (`src/proxy/hf-proxy.ts`)

A single-file HTTP server (~250 lines):

```
┌─────────────┐    ┌───────────────────┐    ┌─────────────────────┐
│ Claude CLI   │───▶│ steroids proxy    │───▶│ HF Router           │
│ (Anthropic)  │    │ :3580              │    │ router.hf.co/v1     │
├─────────────┤    │                   │    └─────────────────────┘
│ Codex CLI    │───▶│ Routes:           │
│ (OpenAI)     │    │  /v1/models       │──▶ Normalize HF response
├─────────────┤    │  /v1/chat/complete │──▶ Pass-through to HF
│ Vibe CLI     │    │  /v1/messages     │──▶ Anthropic→OpenAI→HF
│ (Mistral)    │    │                   │
└─────────────┘    └───────────────────┘
```

**Routes:**

| Route | Purpose |
|-------|---------|
| `GET /v1/models` | Fetch from HF, strip extra fields, return OpenAI-compatible schema |
| `POST /v1/chat/completions` | Stream-proxy to HF Router (pass-through, already compatible) |
| `POST /v1/messages` | Translate Anthropic Messages → OpenAI Chat Completions, forward, translate response back |
| `GET /health` | Proxy liveness check |

**Model response normalization** (`GET /v1/models`):

HF returns:
```json
{"object":"list","data":[{"id":"MiniMaxAI/MiniMax-M2.5","providers":[...],"architecture":{...}}]}
```

Proxy returns:
```json
{"object":"list","data":[{"id":"MiniMaxAI/MiniMax-M2.5","object":"model","created":1700000000,"owned_by":"MiniMaxAI"}]}
```

**Anthropic→OpenAI translation** (`POST /v1/messages`):

| Anthropic field | OpenAI field |
|----------------|-------------|
| `messages[].role` | `messages[].role` (same) |
| `messages[].content` (string) | `messages[].content` (string) |
| `messages[].content` (array of blocks) | Flatten text blocks to string |
| `model` | `model` (pass-through) |
| `max_tokens` | `max_tokens` |
| `stream: true` | `stream: true` |
| `system` (top-level string) | `messages[0] = {role:"system", content: system}` |
| `tools` | `tools` (Anthropic→OpenAI tool schema is close enough) |

Response translation (OpenAI→Anthropic):

| OpenAI response | Anthropic response |
|----------------|-------------------|
| `choices[0].message.content` | `content: [{type:"text",text:...}]` |
| `choices[0].message.tool_calls` | `content: [{type:"tool_use",...}]` |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |
| `id` | `id` |
| Streaming: `data: {...}` chunks | Streaming: Anthropic SSE events |

### Proxy Lifecycle (`src/proxy/lifecycle.ts`)

~100 lines. Functions:

- `startProxy(hfToken: string, port?: number): Promise<{ port: number; pid: number }>` — start proxy, write PID file to `~/.steroids/proxy.pid`
- `stopProxy(): void` — read PID file, kill process
- `isProxyRunning(): boolean` — check PID file + process alive
- `ensureProxy(hfToken: string): Promise<number>` — start if not running, return port

### Provider Integration

Each provider's `invokeWithFile()` method calls `getSanitizedCliEnv(overrides)`. The integration point is: when the configured model is an HF model (contains `/` like `MiniMaxAI/MiniMax-M2.5`), inject proxy env vars into the overrides.

This is done in `BaseAIProvider.getSanitizedCliEnv()` itself — add proxy detection after the key stripping:

```typescript
// If model looks like an HF model (org/name format), inject proxy env
if (overrides?.STEROIDS_HF_PROXY_PORT) {
  const proxyUrl = `http://127.0.0.1:${overrides.STEROIDS_HF_PROXY_PORT}`;
  env.OPENAI_BASE_URL = proxyUrl;
  env.OPENAI_API_KEY = 'hf-proxy';
  env.ANTHROPIC_BASE_URL = proxyUrl;
  env.ANTHROPIC_API_KEY = 'hf-proxy';
  delete env.STEROIDS_HF_PROXY_PORT; // Don't leak internal var
}
```

Each provider's `invoke()` calls `ensureProxy()` when it detects an HF model, then passes `STEROIDS_HF_PROXY_PORT` in the overrides.

### CLI Command (`src/commands/ai-proxy.ts`)

Simple subcommand under `steroids ai`:
- `steroids ai proxy start` — start the proxy daemon
- `steroids ai proxy stop` — stop it
- `steroids ai proxy status` — show running/port

The proxy auto-starts when needed (from provider invoke), so the CLI command is mainly for debugging.

### Config

No new config fields needed. The proxy reads:
- HF token from `opencode.json` (`~/.config/opencode/opencode.json` → `provider.huggingface.options.apiKey`) or `HF_TOKEN` env var
- Port defaults to `3580` (configurable via `STEROIDS_PROXY_PORT` env var)

## Implementation Order

### Task 1: Proxy server core — model list normalization

**Files:**
- Create: `src/proxy/hf-proxy.ts`
- Test: `tests/proxy-hf-models.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createHFProxy } from '../src/proxy/hf-proxy.js';

// Mock HF router response
function createMockHFRouter(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'MiniMaxAI/MiniMax-M2.5',
            object: 'model',
            created: 1770876324,
            owned_by: 'MiniMaxAI',
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            providers: [{ provider: 'novita', status: 'live', context_length: 204800 }],
          },
        ],
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}

describe('HF Proxy - model list normalization', () => {
  let mockHF: http.Server;
  let proxy: http.Server;
  let mockPort: number;
  let proxyPort: number;

  beforeAll(async () => {
    mockHF = createMockHFRouter();
    await new Promise<void>((resolve) => mockHF.listen(0, () => resolve()));
    mockPort = (mockHF.address() as any).port;

    proxy = createHFProxy({
      hfBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      hfToken: 'hf_test_token',
    });
    await new Promise<void>((resolve) => proxy.listen(0, () => resolve()));
    proxyPort = (proxy.address() as any).port;
  });

  afterAll(() => {
    proxy.close();
    mockHF.close();
  });

  it('strips extra fields from /v1/models and returns OpenAI-compatible schema', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.object).toBe('list');
    expect(data.data).toHaveLength(1);

    const model = data.data[0];
    expect(model.id).toBe('MiniMaxAI/MiniMax-M2.5');
    expect(model.object).toBe('model');
    // Must NOT have HF-specific fields
    expect(model.providers).toBeUndefined();
    expect(model.architecture).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/proxy-hf-models.test.ts --no-coverage`
Expected: FAIL — `createHFProxy` does not exist

**Step 3: Write minimal implementation**

```typescript
// src/proxy/hf-proxy.ts
import http from 'node:http';

export interface HFProxyOptions {
  hfBaseUrl: string;   // e.g. https://router.huggingface.co/v1
  hfToken: string;     // Bearer token for HF API
}

export function createHFProxy(options: HFProxyOptions): http.Server {
  const { hfBaseUrl, hfToken } = options;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        await handleModels(hfBaseUrl, hfToken, res);
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream error' }));
    }
  });
}

async function handleModels(
  hfBaseUrl: string,
  hfToken: string,
  res: http.ServerResponse
): Promise<void> {
  const upstream = await fetch(`${hfBaseUrl}/models`, {
    headers: { Authorization: `Bearer ${hfToken}` },
  });

  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(await upstream.text());
    return;
  }

  const raw = (await upstream.json()) as any;
  const models = (raw.data ?? raw).map((m: any) => ({
    id: m.id,
    object: 'model',
    created: m.created ?? Math.floor(Date.now() / 1000),
    owned_by: m.owned_by ?? m.id.split('/')[0] ?? 'unknown',
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/proxy-hf-models.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proxy/hf-proxy.ts tests/proxy-hf-models.test.ts
git commit -m "feat: HF proxy — model list normalization for Codex compatibility"
```

---

### Task 2: Chat completions pass-through (streaming)

**Files:**
- Modify: `src/proxy/hf-proxy.ts`
- Test: `tests/proxy-hf-chat.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createHFProxy } from '../src/proxy/hf-proxy.js';

function createMockHFRouter(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-test',
            choices: [{ message: { role: 'assistant', content: 'Hello' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }));
        }
      });
    } else if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

describe('HF Proxy - chat completions pass-through', () => {
  let mockHF: http.Server;
  let proxy: http.Server;
  let mockPort: number;
  let proxyPort: number;

  beforeAll(async () => {
    mockHF = createMockHFRouter();
    await new Promise<void>((resolve) => mockHF.listen(0, () => resolve()));
    mockPort = (mockHF.address() as any).port;
    proxy = createHFProxy({
      hfBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      hfToken: 'hf_test',
    });
    await new Promise<void>((resolve) => proxy.listen(0, () => resolve()));
    proxyPort = (proxy.address() as any).port;
  });

  afterAll(() => { proxy.close(); mockHF.close(); });

  it('forwards non-streaming chat completions', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.choices[0].message.content).toBe('Hello');
  });

  it('streams chat completions via SSE', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"choices"');
    expect(text).toContain('[DONE]');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/proxy-hf-chat.test.ts --no-coverage`
Expected: FAIL — `/v1/chat/completions` returns 404

**Step 3: Implement chat completions proxy**

Add to `src/proxy/hf-proxy.ts` in the `createServer` handler:

```typescript
if (req.method === 'POST' && req.url === '/v1/chat/completions') {
  await handleChatCompletions(req, hfBaseUrl, hfToken, res);
  return;
}
```

Add function:

```typescript
async function handleChatCompletions(
  req: http.IncomingMessage,
  hfBaseUrl: string,
  hfToken: string,
  res: http.ServerResponse
): Promise<void> {
  const body = await readBody(req);

  const upstream = await fetch(`${hfBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  // Stream the response back verbatim
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
  });

  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/proxy-hf-chat.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proxy/hf-proxy.ts tests/proxy-hf-chat.test.ts
git commit -m "feat: HF proxy — streaming chat completions pass-through"
```

---

### Task 3: Anthropic Messages API translation

**Files:**
- Modify: `src/proxy/hf-proxy.ts`
- Test: `tests/proxy-hf-anthropic.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createHFProxy } from '../src/proxy/hf-proxy.js';

function createMockHFRouter(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        // Verify the translation happened: system message should be first
        const hasSystem = parsed.messages[0]?.role === 'system';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{
            message: { role: 'assistant', content: 'Translated response' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
          model: parsed.model,
        }));
      });
    } else if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

describe('HF Proxy - Anthropic Messages API translation', () => {
  let mockHF: http.Server;
  let proxy: http.Server;
  let proxyPort: number;

  beforeAll(async () => {
    mockHF = createMockHFRouter();
    await new Promise<void>((resolve) => mockHF.listen(0, () => resolve()));
    const mockPort = (mockHF.address() as any).port;
    proxy = createHFProxy({
      hfBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      hfToken: 'hf_test',
    });
    await new Promise<void>((resolve) => proxy.listen(0, () => resolve()));
    proxyPort = (proxy.address() as any).port;
  });

  afterAll(() => { proxy.close(); mockHF.close(); });

  it('translates Anthropic Messages request to OpenAI and back', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'hf-proxy',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        max_tokens: 1024,
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;

    // Must return Anthropic-format response
    expect(data.type).toBe('message');
    expect(data.role).toBe('assistant');
    expect(data.content).toEqual([{ type: 'text', text: 'Translated response' }]);
    expect(data.usage.input_tokens).toBe(15);
    expect(data.usage.output_tokens).toBe(8);
    expect(data.stop_reason).toBe('end_turn');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/proxy-hf-anthropic.test.ts --no-coverage`
Expected: FAIL — `/v1/messages` returns 404

**Step 3: Implement Anthropic translation**

Add route to `createHFProxy`:

```typescript
if (req.method === 'POST' && req.url === '/v1/messages') {
  await handleAnthropicMessages(req, hfBaseUrl, hfToken, res);
  return;
}
```

Add translation functions:

```typescript
interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  stream?: boolean;
  tools?: any[];
  temperature?: number;
  top_p?: number;
}

function anthropicToOpenAI(body: AnthropicRequest): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];

  if (body.system) {
    messages.push({ role: 'system', content: body.system });
  }

  for (const msg of body.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
    messages.push({ role: msg.role, content });
  }

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream ?? false,
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { top_p: body.top_p }),
    ...(body.tools && { tools: body.tools.map(anthropicToolToOpenAI) }),
  };
}

function anthropicToolToOpenAI(tool: any): any {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? {},
    },
  };
}

function openAIResponseToAnthropic(oai: any, model: string): Record<string, unknown> {
  const choice = oai.choices?.[0];
  const content: Array<Record<string, unknown>> = [];

  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  const stopReasonMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
  };

  return {
    id: oai.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonMap[choice?.finish_reason] ?? 'end_turn',
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

async function handleAnthropicMessages(
  req: http.IncomingMessage,
  hfBaseUrl: string,
  hfToken: string,
  res: http.ServerResponse
): Promise<void> {
  const rawBody = await readBody(req);
  const anthropicReq = JSON.parse(rawBody) as AnthropicRequest;
  const openaiReq = anthropicToOpenAI(anthropicReq);

  const upstream = await fetch(`${hfBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(openaiReq),
  });

  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(await upstream.text());
    return;
  }

  // Non-streaming: translate the full response
  const oaiResponse = await upstream.json();
  const anthropicResponse = openAIResponseToAnthropic(oaiResponse, anthropicReq.model);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicResponse));
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/proxy-hf-anthropic.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proxy/hf-proxy.ts tests/proxy-hf-anthropic.test.ts
git commit -m "feat: HF proxy — Anthropic Messages API to OpenAI translation"
```

---

### Task 4: Proxy lifecycle (start/stop/ensure)

**Files:**
- Create: `src/proxy/lifecycle.ts`
- Test: `tests/proxy-lifecycle.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from '@jest/globals';
import { startProxy, stopProxy, isProxyRunning } from '../src/proxy/lifecycle.js';

describe('HF Proxy lifecycle', () => {
  afterEach(() => {
    try { stopProxy(); } catch { /* ignore */ }
  });

  it('starts and stops the proxy', async () => {
    const { port, pid } = await startProxy({
      hfToken: 'hf_test',
      hfBaseUrl: 'https://router.huggingface.co/v1',
    });
    expect(port).toBeGreaterThan(0);
    expect(pid).toBeGreaterThan(0);
    expect(isProxyRunning()).toBe(true);

    stopProxy();
    // Give it a moment to shut down
    await new Promise((r) => setTimeout(r, 100));
    expect(isProxyRunning()).toBe(false);
  });

  it('ensureProxy is idempotent', async () => {
    const { ensureProxy } = await import('../src/proxy/lifecycle.js');
    const port1 = await ensureProxy({ hfToken: 'hf_test', hfBaseUrl: 'https://router.huggingface.co/v1' });
    const port2 = await ensureProxy({ hfToken: 'hf_test', hfBaseUrl: 'https://router.huggingface.co/v1' });
    expect(port1).toBe(port2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/proxy-lifecycle.test.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Implement lifecycle**

```typescript
// src/proxy/lifecycle.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHFProxy } from './hf-proxy.js';
import type http from 'node:http';

const PID_FILE = join(homedir(), '.steroids', 'proxy.pid');
const DEFAULT_PORT = 3580;

let serverInstance: http.Server | null = null;

export interface ProxyStartOptions {
  hfToken: string;
  hfBaseUrl?: string;
  port?: number;
}

export async function startProxy(options: ProxyStartOptions): Promise<{ port: number; pid: number }> {
  if (serverInstance) {
    throw new Error('Proxy already running in this process');
  }

  const port = options.port ?? DEFAULT_PORT;
  const hfBaseUrl = options.hfBaseUrl ?? 'https://router.huggingface.co/v1';

  const server = createHFProxy({ hfBaseUrl, hfToken: options.hfToken });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const actualPort = (server.address() as any).port;
  serverInstance = server;

  // Write PID file
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: actualPort }), 'utf-8');

  return { port: actualPort, pid: process.pid };
}

export function stopProxy(): void {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

export function isProxyRunning(): boolean {
  if (serverInstance) return true;
  if (!existsSync(PID_FILE)) return false;

  try {
    const { pid } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return false;
  }
}

export function getProxyPort(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const { port } = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    return port;
  } catch {
    return null;
  }
}

export async function ensureProxy(options: ProxyStartOptions): Promise<number> {
  if (isProxyRunning()) {
    return getProxyPort() ?? DEFAULT_PORT;
  }
  const { port } = await startProxy(options);
  return port;
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/proxy-lifecycle.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proxy/lifecycle.ts tests/proxy-lifecycle.test.ts
git commit -m "feat: HF proxy lifecycle — start/stop/ensure with PID file"
```

---

### Task 5: Provider integration — inject proxy env vars

**Files:**
- Modify: `src/providers/interface.ts` (add HF model detection + proxy env injection in `getSanitizedCliEnv`)
- Create: `src/proxy/hf-token.ts` (resolve HF token from available sources)
- Test: `tests/proxy-provider-integration.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from '@jest/globals';
import { resolveHFToken } from '../src/proxy/hf-token.js';

describe('HF token resolution', () => {
  it('reads from opencode.json', () => {
    // This test uses a fixture; see step 3
    const token = resolveHFToken('/tmp/test-hf-token');
    expect(token).toBeNull(); // No fixture yet, so null
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/proxy-provider-integration.test.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Implement HF token resolver + provider env injection**

Create `src/proxy/hf-token.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve HF token from available sources (in priority order):
 * 1. HF_TOKEN environment variable
 * 2. opencode.json config file
 * 3. ~/.huggingface/token file
 */
export function resolveHFToken(configDir?: string): string | null {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;

  // Try opencode.json
  const opencodeConfigPaths = [
    configDir ? join(configDir, 'opencode.json') : null,
    join(homedir(), '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean) as string[];

  for (const configPath of opencodeConfigPaths) {
    try {
      if (!existsSync(configPath)) continue;
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const token = config?.provider?.huggingface?.options?.apiKey;
      if (token) return token;
    } catch { /* continue */ }
  }

  // Try ~/.huggingface/token
  try {
    const tokenPath = join(homedir(), '.huggingface', 'token');
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, 'utf-8').trim();
      if (token) return token;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Detect if a model ID is a HuggingFace model (contains org/name format).
 * Native provider models don't contain slashes (e.g., claude-sonnet-4-6, gpt-5.3-codex).
 */
export function isHFModel(modelId: string): boolean {
  return modelId.includes('/') && !modelId.startsWith('models/');
}
```

Modify `src/providers/interface.ts` — in `getSanitizedCliEnv`, after the `NODE_OPTIONS` block, add:

```typescript
// HF proxy: if caller signals an HF model, inject proxy URL into provider env vars
// so the CLI connects to the local proxy instead of its native API.
if (overrides?.STEROIDS_HF_PROXY_URL) {
  const proxyUrl = overrides.STEROIDS_HF_PROXY_URL;
  // OpenAI-compatible CLIs (Codex)
  env.OPENAI_BASE_URL = proxyUrl;
  env.OPENAI_API_KEY = 'hf-proxy';
  // Anthropic CLIs (Claude)
  env.ANTHROPIC_BASE_URL = proxyUrl;
  env.ANTHROPIC_API_KEY = 'hf-proxy';
  // Clean up internal signal var
  delete env.STEROIDS_HF_PROXY_URL;
}

// Apply explicit overrides last (they win over everything above)
if (overrides) {
  Object.assign(env, overrides);
}
```

Remove the existing `Object.assign(env, overrides)` at the bottom of the method and replace it with the block above.

**Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/proxy-provider-integration.test.ts --no-coverage`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proxy/hf-token.ts src/providers/interface.ts tests/proxy-provider-integration.test.ts
git commit -m "feat: HF proxy — token resolution and provider env injection"
```

---

### Task 6: Wire proxy into provider invoke paths

**Files:**
- Modify: `src/providers/claude.ts` (detect HF model, ensure proxy, inject env)
- Modify: `src/providers/codex.ts` (same)
- Modify: `src/providers/mistral.ts` (same)

**Step 1: Add HF proxy wiring to each provider**

In each provider's `invokeWithFile()`, before the `spawn()` call where `getSanitizedCliEnv` is called, add:

```typescript
import { isHFModel, resolveHFToken } from '../proxy/hf-token.js';
import { ensureProxy } from '../proxy/lifecycle.js';

// ... inside invokeWithFile, before the spawn:
let proxyOverrides: Record<string, string> = {};
if (isHFModel(model)) {
  const hfToken = resolveHFToken();
  if (hfToken) {
    const proxyPort = await ensureProxy({ hfToken });
    proxyOverrides = { STEROIDS_HF_PROXY_URL: `http://127.0.0.1:${proxyPort}` };
  }
}
```

Then merge `proxyOverrides` into the `getSanitizedCliEnv` call:

```typescript
env: this.getSanitizedCliEnv({
  HOME: isolatedHome,
  ...proxyOverrides,
}),
```

This needs to be done in three files:
- `claude.ts` line ~246 (the `getSanitizedCliEnv({ HOME: isolatedHome })` call)
- `codex.ts` line ~286 (same pattern)
- `mistral.ts` line ~203 (the `getSanitizedCliEnv({ VIBE_HOME: vibeHome, ... })` call)

Note: `invokeWithFile` is currently sync-returning-a-Promise in Claude and Codex. Since `ensureProxy` is async, the HF detection block runs before the `new Promise()` constructor, which is fine since it's already in an async context (`invoke()` is async and calls `invokeWithFile`). For Mistral, `invokeWithFile` returns a Promise directly — the proxy setup needs to happen before the Promise constructor.

**Step 2: Run existing tests**

Run: `npm run build && npm test`
Expected: All existing tests still pass (no behavioral change when model is not HF)

**Step 3: Commit**

```bash
git add src/providers/claude.ts src/providers/codex.ts src/providers/mistral.ts
git commit -m "feat: wire HF proxy into Claude, Codex, and Mistral provider invocations"
```

---

### Task 7: CLI subcommand (`steroids ai proxy`)

**Files:**
- Create: `src/commands/ai-proxy.ts`
- Modify: `src/commands/ai.ts` (add `proxy` subcommand)
- Modify: `src/commands/completion.ts` (add to completions)

**Step 1: Implement the subcommand**

```typescript
// src/commands/ai-proxy.ts
import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';
import { startProxy, stopProxy, isProxyRunning, getProxyPort } from '../proxy/lifecycle.js';
import { resolveHFToken } from '../proxy/hf-token.js';

const HELP = generateHelp({
  command: 'ai proxy',
  description: 'Manage the HuggingFace model proxy',
  usage: ['steroids ai proxy <start|stop|status>'],
  subcommands: [
    { name: 'start', description: 'Start the proxy server' },
    { name: 'stop', description: 'Stop the proxy server' },
    { name: 'status', description: 'Show proxy status' },
  ],
  examples: [
    { command: 'steroids ai proxy start', description: 'Start HF proxy on default port' },
    { command: 'steroids ai proxy status', description: 'Check if proxy is running' },
  ],
  showEnvVars: false,
  showExitCodes: false,
});

export async function proxySubcommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'ai proxy', flags });

  const { positionals } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    allowPositionals: true,
  });

  if (flags.help || positionals.length === 0) {
    out.log(HELP);
    return;
  }

  switch (positionals[0]) {
    case 'start': {
      if (isProxyRunning()) {
        const port = getProxyPort();
        out.log(`Proxy already running on port ${port}`);
        return;
      }
      const token = resolveHFToken();
      if (!token) {
        out.error('CONFIGURATION_ERROR', 'No HuggingFace token found. Set HF_TOKEN or configure opencode.json.');
        process.exit(3);
      }
      const { port } = await startProxy({ hfToken: token });
      out.log(`HF proxy started on http://127.0.0.1:${port}`);
      break;
    }
    case 'stop':
      if (!isProxyRunning()) {
        out.log('Proxy is not running');
        return;
      }
      stopProxy();
      out.log('Proxy stopped');
      break;
    case 'status': {
      const running = isProxyRunning();
      const port = getProxyPort();
      if (flags.json) {
        out.success({ running, port });
      } else {
        out.log(`Proxy: ${running ? `running on port ${port}` : 'stopped'}`);
      }
      break;
    }
    default:
      out.error('INVALID_ARGUMENTS', `Unknown subcommand: ${positionals[0]}`);
      process.exit(2);
  }
}
```

**Step 2: Wire into `ai.ts`**

Add import and case to `src/commands/ai.ts`:

```typescript
import { proxySubcommand } from './ai-proxy.js';
// ... in the switch:
case 'proxy':
  await proxySubcommand(subArgs, flags);
  break;
```

Add to help subcommands and examples.

**Step 3: Wire into `completion.ts`**

Add `'proxy'` to the `ai` completions array.

**Step 4: Run build**

Run: `npm run build`
Expected: Clean compile

**Step 5: Manual smoke test**

```bash
node dist/index.js ai proxy start
node dist/index.js ai proxy status
curl http://127.0.0.1:3580/health
node dist/index.js ai proxy stop
```

**Step 6: Commit**

```bash
git add src/commands/ai-proxy.ts src/commands/ai.ts src/commands/completion.ts
git commit -m "feat: steroids ai proxy — CLI subcommand for HF proxy management"
```

---

### Task 8: End-to-end test — Codex via proxy

**This is a manual integration test, not automated.**

```bash
# Start proxy
node dist/index.js ai proxy start

# Test Codex with HF model via steroids ai run
node dist/index.js ai run coder \
  -p "Read the file greeting.txt and append 'Codex+HF+MiniMax was here.' to the end." \
  --provider codex \
  --model "MiniMaxAI/MiniMax-M2.5" \
  --cwd /tmp/steroids-test-bench \
  -t 5m

# Verify
cat /tmp/steroids-test-bench/greeting.txt

# Stop proxy
node dist/index.js ai proxy stop
```

**Step 1: Run the test, capture result**

**Step 2: If it fails, debug and fix**

**Step 3: Commit any fixes**

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No HF token available | Proxy doesn't start; provider falls through to native API (existing behavior) |
| Proxy port already in use | `startProxy` throws; `ensureProxy` detects via PID and reuses |
| HF Router is down | Proxy returns 502; provider classifies as `network_error` (retryable) |
| Streaming Anthropic requests from Claude | Task 3 covers non-streaming only; streaming Anthropic SSE is a follow-up if needed (Claude CLI uses `stream-json` which may map cleanly) |
| Model ID with `:variant` suffix (e.g. `MiniMaxAI/MiniMax-M2.5:cheapest`) | `isHFModel()` still detects `/`; model ID passed through to HF Router which handles variants |
| Multiple steroids processes | PID file prevents multiple proxy instances; first-writer wins |
| Proxy orphaned (crash without cleanup) | `isProxyRunning()` checks process liveness via `kill(pid, 0)`; stale PID file auto-cleaned |

## Non-Goals

- **Ollama proxying**: Ollama has its own OpenAI-compatible endpoint locally; no proxy needed
- **Streaming Anthropic SSE translation**: Complex; defer until Claude CLI proves it needs streaming through the proxy (it may work with non-streaming `--output-format text` mode)
- **Tool use translation in streaming mode**: Non-trivial; defer
- **Proxy authentication**: The proxy listens on `127.0.0.1` only — no auth needed for local-only access
- **Proxy as a daemon**: Runs in-process for now; daemonization is a follow-up if needed
- **Caching model lists**: The proxy fetches `/v1/models` fresh each time; HF responses are fast enough

## Cross-Provider Review

_To be filled after implementation review._
