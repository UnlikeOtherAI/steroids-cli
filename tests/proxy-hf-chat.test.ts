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
        const isStream = parsed.stream === true;

        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n');
          res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Hello world' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}

describe('HF Proxy - chat completions pass-through', () => {
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

  it('proxies non-streaming chat completion', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.choices[0].message.content).toBe('Hello world');
    expect(data.usage.prompt_tokens).toBe(10);
  });

  it('proxies streaming chat completion', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMaxAI/MiniMax-M2.5',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: {');
    expect(text).toContain('"Hello"');
    expect(text).toContain('[DONE]');
  });
});
