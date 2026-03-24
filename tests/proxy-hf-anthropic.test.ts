import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createHFProxy } from '../src/proxy/hf-proxy.js';

function createMockHFRouter(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body);

        // Verify the proxy translated Anthropic → OpenAI correctly
        const hasSystemMsg = parsed.messages?.[0]?.role === 'system';

        if (parsed.tools && parsed.tools.length > 0) {
          // Tool use response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"London"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          }));
        } else {
          // Plain text response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-2',
            object: 'chat.completion',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: hasSystemMsg ? 'I got the system prompt' : 'No system prompt',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
          }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not found');
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
      hfToken: 'hf_test_token',
    });
    await new Promise<void>((resolve) => proxy.listen(0, () => resolve()));
    proxyPort = (proxy.address() as any).port;
  });

  afterAll(() => {
    proxy.close();
    mockHF.close();
  });

  it('translates Anthropic Messages request with system prompt to OpenAI and back', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        max_tokens: 1024,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Anthropic response format
    expect(data.type).toBe('message');
    expect(data.role).toBe('assistant');
    expect(data.content).toHaveLength(1);
    expect(data.content[0].type).toBe('text');
    expect(data.content[0].text).toBe('I got the system prompt');
    expect(data.stop_reason).toBe('end_turn');
    expect(data.usage.input_tokens).toBe(15);
    expect(data.usage.output_tokens).toBe(5);
  });

  it('translates Anthropic content blocks (array format)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        }],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.content[0].text).toBe('No system prompt');
  });

  it('translates tool use requests and responses', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'What is the weather in London?' }],
        tools: [{
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        }],
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.stop_reason).toBe('tool_use');
    const toolBlock = data.content.find((b: any) => b.type === 'tool_use');
    expect(toolBlock).toBeDefined();
    expect(toolBlock.name).toBe('get_weather');
    expect(toolBlock.input).toEqual({ location: 'London' });
  });
});
