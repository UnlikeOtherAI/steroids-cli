import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { HuggingFaceHubClient, HubAPIError } from '../src/huggingface/hub-client.js';

type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function createResponse(payload: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

describe('HuggingFaceHubClient', () => {
  const fetchMock = jest.fn<(input: string, init?: RequestInit) => Promise<Response>>();
  let client: HuggingFaceHubClient;

  beforeEach(() => {
    fetchMock.mockReset();
    client = new HuggingFaceHubClient({
      hubBaseUrl: 'https://example.hf',
      fetchImpl: (input, init) => fetchMock(input, init),
    });
  });

  it('builds list models query and auth header', async () => {
    fetchMock.mockResolvedValueOnce(createResponse([{ id: 'a' }]) as unknown as Response);

    await client.listModels({
      sort: 'downloads',
      direction: -1,
      limit: 50,
      token: 'token-123',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.hf/api/models?pipeline_tag=text-generation&inference_provider=all&direction=-1&limit=50&sort=downloads',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer token-123',
        }),
      })
    );
  });

  it('encodes model id and expands provider mapping', async () => {
    fetchMock.mockResolvedValueOnce(createResponse({ id: 'deepseek-ai/DeepSeek-V3' }) as unknown as Response);

    await client.getModel('deepseek-ai/DeepSeek-V3', {
      expandInferenceProviders: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.hf/api/models/deepseek-ai%2FDeepSeek-V3?expand=inferenceProviderMapping',
      expect.any(Object)
    );
  });

  it('returns empty search results for blank query without fetch', async () => {
    const results = await client.searchModels('   ');
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws HubAPIError with status on http failure', async () => {
    fetchMock.mockResolvedValueOnce(createResponse({ error: 'bad' }, 400) as unknown as Response);

    await expect(client.listModels()).rejects.toEqual(
      expect.objectContaining({
        name: 'HubAPIError',
        status: 400,
      })
    );
  });

  it('throws HubAPIError on invalid json payload', async () => {
    const invalidJsonResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('invalid json');
      },
      text: async () => '',
    };
    fetchMock.mockResolvedValueOnce(invalidJsonResponse as unknown as Response);

    const call = client.listModels();
    await expect(call).rejects.toThrow(HubAPIError);
    await expect(call).rejects.toThrow('invalid JSON');
  });
});
