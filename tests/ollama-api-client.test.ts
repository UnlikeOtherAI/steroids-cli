import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OllamaApiClient, OllamaApiError } from '../src/ollama/api-client.js';

describe('OllamaApiClient', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends auth header and calls expected endpoint', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new OllamaApiClient({
      endpoint: 'https://ollama.example.com/',
      apiKey: 'test-key',
    });

    await client.listInstalledModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ollama.example.com/api/tags');
    expect(options.headers instanceof Headers).toBe(true);

    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-key');
    expect(headers.get('Accept')).toBe('application/json');
  });

  it('parses pull progress from NDJSON stream', async () => {
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"status":"pulling manifest"}\n{"status":"downloading","completed":50,"total":100}\n',
          ),
        );
        controller.enqueue(
          encoder.encode('{"status":"success","completed":100,"total":100}\n'),
        );
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
    );

    const client = new OllamaApiClient({ endpoint: 'http://localhost:11434' });
    const seen: string[] = [];

    const updates = await client.pullModel('qwen2.5-coder:32b', (progress) => {
      seen.push(progress.status);
    });

    expect(updates).toHaveLength(3);
    expect(updates[1]).toMatchObject({ status: 'downloading', completed: 50, total: 100 });
    expect(seen).toEqual(['pulling manifest', 'downloading', 'success']);
  });

  it('throws OllamaApiError on non-2xx response', async () => {
    fetchMock.mockResolvedValue(
      new Response('not found', {
        status: 404,
      }),
    );

    const client = new OllamaApiClient({ endpoint: 'http://localhost:11434' });

    await expect(client.getVersion()).rejects.toBeInstanceOf(OllamaApiError);
  });
});
