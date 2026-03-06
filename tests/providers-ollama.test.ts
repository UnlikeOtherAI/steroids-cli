import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setCloudConnection, setLocalConnection } from '../src/ollama/connection.js';
import { OllamaProvider } from '../src/providers/ollama.js';

describe('OllamaProvider', () => {
  const originalFetch = global.fetch;
  const originalHome = process.env.HOME;
  const originalSteroidsHome = process.env.STEROIDS_HOME;
  const originalHost = process.env.STEROIDS_OLLAMA_HOST;
  const originalPort = process.env.STEROIDS_OLLAMA_PORT;
  const originalApiKey = process.env.OLLAMA_API_KEY;
  const originalMaxConcurrent = process.env.STEROIDS_OLLAMA_MAX_CONCURRENT;
  const originalQueueTimeout = process.env.STEROIDS_OLLAMA_QUEUE_TIMEOUT_MS;

  let tempHome = '';
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    tempHome = mkdtempSync(join('/tmp', 'steroids-provider-ollama-'));
    process.env.HOME = tempHome;
    process.env.STEROIDS_HOME = tempHome;
    delete process.env.STEROIDS_OLLAMA_HOST;
    delete process.env.STEROIDS_OLLAMA_PORT;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.STEROIDS_OLLAMA_MAX_CONCURRENT;
    delete process.env.STEROIDS_OLLAMA_QUEUE_TIMEOUT_MS;
    fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;
    OllamaProvider.resetSemaphoresForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.HOME = originalHome;

    if (originalSteroidsHome === undefined) delete process.env.STEROIDS_HOME;
    else process.env.STEROIDS_HOME = originalSteroidsHome;

    if (originalHost === undefined) delete process.env.STEROIDS_OLLAMA_HOST;
    else process.env.STEROIDS_OLLAMA_HOST = originalHost;

    if (originalPort === undefined) delete process.env.STEROIDS_OLLAMA_PORT;
    else process.env.STEROIDS_OLLAMA_PORT = originalPort;

    if (originalApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalApiKey;

    if (originalMaxConcurrent === undefined) delete process.env.STEROIDS_OLLAMA_MAX_CONCURRENT;
    else process.env.STEROIDS_OLLAMA_MAX_CONCURRENT = originalMaxConcurrent;

    if (originalQueueTimeout === undefined) delete process.env.STEROIDS_OLLAMA_QUEUE_TIMEOUT_MS;
    else process.env.STEROIDS_OLLAMA_QUEUE_TIMEOUT_MS = originalQueueTimeout;

    OllamaProvider.resetSemaphoresForTests();
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('fetches models from /v1/models', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'qwen2.5-coder:32b', object: 'model', created: 1, owned_by: 'ollama' },
            { id: 'llama3.3:70b', object: 'model', created: 1, owned_by: 'ollama' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const provider = new OllamaProvider();
    await provider.fetchModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/models');
    expect(provider.listModels()).toContain('qwen2.5-coder:32b');
  });

  it('uses cloud bearer token for model listing', async () => {
    setCloudConnection('cloud-token', 'https://ollama.com');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OllamaProvider();
    await provider.fetchModels();

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer cloud-token');
  });

  it('streams NDJSON from /api/chat and maps token usage', async () => {
    setLocalConnection('http://localhost:11434');

    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            model_info: {
              llama: { context_length: 16384 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/chat')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('{"message":{"content":"hello "},"done":false}\n'),
            );
            controller.enqueue(
              encoder.encode('{"message":{"content":"world"},"done":true,"prompt_eval_count":12,"eval_count":4}\n'),
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new OllamaProvider();
    const events: unknown[] = [];
    const result = await provider.invoke('print hello', {
      model: 'qwen2.5-coder:32b',
      onActivity: (activity) => events.push(activity),
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello world');
    expect(result.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(events.length).toBeGreaterThan(0);

    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/chat'));
    expect(chatCall).toBeDefined();
    const payload = JSON.parse(String((chatCall as [string, RequestInit])[1].body));
    expect(payload.stream).toBe(true);
    expect(payload.options.num_ctx).toBe(16384);
  });

  it('times out queued requests when semaphore slots are exhausted', async () => {
    setLocalConnection('http://localhost:11434');
    process.env.STEROIDS_OLLAMA_MAX_CONCURRENT = '1';
    process.env.STEROIDS_OLLAMA_QUEUE_TIMEOUT_MS = '30';

    const encoder = new TextEncoder();
    let chatCalls = 0;

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            model_info: {
              qwen2: { context_length: 8192 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/chat')) {
        chatCalls += 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(
                encoder.encode('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n'),
              );
              controller.close();
            }, 120);
          },
        });

        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new OllamaProvider();
    const first = provider.invoke('first', { model: 'qwen2.5-coder:32b' });
    const second = provider.invoke('second', { model: 'qwen2.5-coder:32b' });

    const secondResult = await second;
    const firstResult = await first;

    expect(secondResult.success).toBe(false);
    expect(secondResult.timedOut).toBe(true);
    expect(secondResult.stderr).toContain('All Ollama slots busy');
    expect(firstResult.success).toBe(true);
    expect(chatCalls).toBe(1);
  });

  it('fails invocation when stream closes before done:true final chunk', async () => {
    setLocalConnection('http://localhost:11434');

    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({
            model_info: {
              qwen2: { context_length: 8192 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/chat')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('{"message":{"content":"partial"},"done":false}\n'),
            );
            controller.close();
          },
        });

        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new OllamaProvider();
    const result = await provider.invoke('incomplete stream', { model: 'qwen2.5-coder:32b' });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('done:true');
  });
});
