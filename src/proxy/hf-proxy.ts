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
      const rawUrl = req.url ?? '/';
      // Strip query string for path matching — the Claude CLI appends ?beta=true
      const urlPath = rawUrl.split('?')[0];

      // Model-override route: /model/{encodedModel}/v1/{endpoint}
      // Used by Claude provider to pass the real HF model name without hitting
      // the Claude CLI's local model-name validation (which rejects org/name format).
      const modelOverrideBase = urlPath.match(/^\/model\/([^/]+)\//);
      const modelOverride = modelOverrideBase ? decodeURIComponent(modelOverrideBase[1]) : null;

      if (req.method === 'POST' && modelOverride && urlPath.endsWith('/v1/messages')) {
        await handleAnthropicMessages(req, hfBaseUrl, hfToken, res, modelOverride);
      } else if (req.method === 'GET' && modelOverride && urlPath.endsWith('/v1/models')) {
        // Return a fake models list containing only the Claude placeholder so the CLI
        // passes its model-existence check before making the actual messages request.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'claude-sonnet-4-6', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' }],
        }));
      } else if (req.method === 'GET' && urlPath === '/v1/models') {
        await handleModels(hfBaseUrl, hfToken, res);
      } else if (req.method === 'POST' && urlPath === '/v1/chat/completions') {
        await handleChatCompletions(req, hfBaseUrl, hfToken, res);
      } else if (req.method === 'POST' && urlPath === '/v1/messages') {
        await handleAnthropicMessages(req, hfBaseUrl, hfToken, res);
      } else if (req.method === 'GET' && urlPath === '/health') {
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

type AnthropicContentBlock = { type: string; text?: string; cache_control?: unknown; [key: string]: unknown };

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  // system can be a plain string or an array of content blocks (Anthropic cache-control format)
  system?: string | AnthropicContentBlock[];
  messages: Array<{ role: string; content: string | AnthropicContentBlock[] }>;
  stream?: boolean;
  tools?: any[];
  temperature?: number;
  top_p?: number;
}

function blocksToString(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

function anthropicToOpenAI(body: AnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (body.system) {
    messages.push({ role: 'system', content: blocksToString(body.system) });
  }

  for (const msg of body.messages) {
    const blocks = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }] as AnthropicContentBlock[]
      : msg.content;

    if (msg.role === 'assistant') {
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      if (toolUses.length > 0) {
        // Assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: textParts || null,
          tool_calls: toolUses.map((tu) => ({
            id: tu.id as string,
            type: 'function',
            function: { name: tu.name as string, arguments: JSON.stringify(tu.input ?? {}) },
          })),
        });
      } else {
        messages.push({ role: 'assistant', content: textParts });
      }
    } else if (msg.role === 'user') {
      // User messages may contain text and/or tool_result blocks
      const textParts = blocks.filter((b) => b.type === 'text');
      const toolResults = blocks.filter((b) => b.type === 'tool_result');

      // Emit any text content as a user message
      if (textParts.length > 0) {
        messages.push({ role: 'user', content: textParts.map((b) => b.text ?? '').join('\n') });
      }

      // Emit each tool_result as a separate "tool" role message (OpenAI format)
      for (const tr of toolResults) {
        const resultContent = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? (tr.content as AnthropicContentBlock[]).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('\n')
            : JSON.stringify(tr.content ?? '');
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id as string,
          content: resultContent,
        });
      }

      // If message had only tool_results and no text, we still need to have emitted something
      if (textParts.length === 0 && toolResults.length === 0) {
        messages.push({ role: 'user', content: blocksToString(msg.content) });
      }
    } else {
      messages.push({ role: msg.role, content: blocksToString(msg.content) });
    }
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
  res: http.ServerResponse,
  modelOverride?: string
): Promise<void> {
  const rawBody = await readBody(req);
  const anthropicReq = JSON.parse(rawBody) as AnthropicRequest;
  // Model override from URL path takes precedence over the body's model field.
  // This lets Claude CLI pass a valid placeholder model name while the real
  // HF model is encoded in the proxy URL (e.g. /model/MiniMaxAI%2FMiniMax-M2.5/v1/messages).
  if (modelOverride) anthropicReq.model = modelOverride;
  const wantsStream = !!anthropicReq.stream;

  // Always call HF non-streaming — streaming SSE from HF can't be parsed by
  // upstream.json(). We fake SSE back to the Claude CLI when stream=true.
  const openaiReq = anthropicToOpenAI({ ...anthropicReq, stream: false });

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

  const oaiResponse = await upstream.json() as any;

  if (!wantsStream) {
    const anthropicResponse = openAIResponseToAnthropic(oaiResponse, anthropicReq.model);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(anthropicResponse));
    return;
  }

  // Emit Anthropic SSE format from the non-streaming HF response.
  const choice = oaiResponse.choices?.[0];
  const msgId = oaiResponse.id ?? `msg_${Date.now()}`;
  const inputTokens: number = oaiResponse.usage?.prompt_tokens ?? 0;
  const outputTokens: number = oaiResponse.usage?.completion_tokens ?? 0;
  const stopReasonMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
  };
  const stopReason = stopReasonMap[choice?.finish_reason] ?? 'end_turn';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sse = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sse('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: anthropicReq.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  let blockIndex = 0;

  // Text block
  if (choice?.message?.content) {
    sse('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    sse('ping', { type: 'ping' });
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: choice.message.content },
    });
    sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  // Tool use blocks
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      sse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
      });
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: tc.function.arguments ?? '{}' },
      });
      sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex++;
    }
  }

  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sse('message_stop', { type: 'message_stop' });

  res.end();
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
