import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createHFProxy } from '../src/proxy/hf-proxy.js';

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

  it('strips extra fields from /v1/models and returns OpenAI-compatible schema', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.object).toBe('list');
    expect(data.data).toHaveLength(1);

    const model = data.data[0];
    expect(model.id).toBe('MiniMaxAI/MiniMax-M2.5');
    expect(model.object).toBe('model');
    expect(model.providers).toBeUndefined();
    expect(model.architecture).toBeUndefined();
  });

  it('returns health check', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('ok');
  });
});
