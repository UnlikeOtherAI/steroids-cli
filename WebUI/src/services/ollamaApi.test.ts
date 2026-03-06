import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from './api';
import { ollamaApi } from './ollamaApi';

describe('ollamaApi.pullModel', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses pull SSE contract and streams progress callbacks', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"status":"pulling","percent":25}\n\n'));
        controller.enqueue(encoder.encode('data: {"status":"success","percent":100,"done":true}\n\n'));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body,
    });

    const seen: Array<{ status: string; percent?: number; done?: boolean }> = [];
    await ollamaApi.pullModel('  llama3  ', (progress) => {
      seen.push({
        status: progress.status,
        percent: progress.percent ?? undefined,
        done: progress.done,
      });
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/ollama/pull`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }),
        body: JSON.stringify({ model: 'llama3' }),
      }),
    );

    expect(seen).toEqual([
      { status: 'pulling', percent: 25, done: undefined },
      { status: 'success', percent: 100, done: true },
    ]);
  });
});
