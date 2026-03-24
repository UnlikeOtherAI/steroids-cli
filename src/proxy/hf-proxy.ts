/**
 * HuggingFace Model Proxy
 *
 * Local HTTP server that translates between provider-native API formats
 * and the HF Router's OpenAI-compatible endpoint. Enables Claude (Anthropic),
 * Codex (OpenAI), and Vibe (Mistral) CLIs to use any HuggingFace model.
 */

import http from 'node:http';

export interface HFProxyOptions {
  /** HF Router base URL, e.g. https://router.huggingface.co/v1 */
  hfBaseUrl: string;
  /** Bearer token for HF API */
  hfToken: string;
}

export function createHFProxy(options: HFProxyOptions): http.Server {
  const { hfBaseUrl, hfToken } = options;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        await handleModels(hfBaseUrl, hfToken, res);
      } else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        await handleChatCompletions(req, hfBaseUrl, hfToken, res);
      } else if (req.method === 'POST' && req.url === '/v1/messages') {
        await handleAnthropicMessages(req, hfBaseUrl, hfToken, res);
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream error' }));
    }
  });
}

// ---------------------------------------------------------------------------
// GET /v1/models — normalize HF response to pure OpenAI schema
// ---------------------------------------------------------------------------

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
  const rawModels = Array.isArray(raw) ? raw : (raw.data ?? []);
  const models = rawModels.map((m: any) => ({
    id: m.id,
    object: 'model',
    created: m.created ?? Math.floor(Date.now() / 1000),
    owned_by: m.owned_by ?? m.id.split('/')[0] ?? 'unknown',
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — stream-proxy to HF (pass-through)
// ---------------------------------------------------------------------------

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
      Authorization: `Bearer ${hfToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });

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

// ---------------------------------------------------------------------------
// POST /v1/messages — Anthropic Messages API → OpenAI → HF → Anthropic
// ---------------------------------------------------------------------------

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
    const content =
      typeof msg.content === 'string'
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
      Authorization: `Bearer ${hfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(openaiReq),
  });

  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(await upstream.text());
    return;
  }

  const oaiResponse = await upstream.json();
  const anthropicResponse = openAIResponseToAnthropic(oaiResponse, anthropicReq.model);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicResponse));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
