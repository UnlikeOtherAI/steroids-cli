import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from './api';
import { modelUsageApi } from './modelUsageApi';

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

describe('modelUsageApi', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests /api/model-usage with default hours', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        success: true,
        hours: 24,
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          totalTokens: 0,
          invocations: 0,
        },
        by_model: [],
        by_project: [],
      })
    );

    await modelUsageApi.getUsage();

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/model-usage?hours=24`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('includes encoded project path and custom hours', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        success: true,
        hours: 1,
        stats: {
          inputTokens: 12,
          outputTokens: 4,
          cachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0.1,
          totalTokens: 16,
          invocations: 1,
        },
        by_model: [],
        by_project: [],
      })
    );

    const projectPath = '/path/with spaces & chars';
    await modelUsageApi.getUsage(1, projectPath);

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/model-usage?hours=1&project=${encodeURIComponent(projectPath)}`,
      expect.anything()
    );
  });

  it('streams pull progress updates from SSE endpoint', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"status":"pulling","phase":"downloading","percent":10}\n\n'));
        controller.enqueue(encoder.encode('data: {"status":"success","phase":"complete","percent":100,"done":true}\n\n'));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body,
    });

    const seen: Array<{ status: string; percent?: number; done?: boolean }> = [];
    await modelUsageApi.pullModel('qwen2.5-coder:32b', (progress) => {
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
      }),
    );
    expect(seen).toEqual([
      { status: 'pulling', percent: 10, done: undefined },
      { status: 'success', percent: 100, done: true },
    ]);
  });
});
