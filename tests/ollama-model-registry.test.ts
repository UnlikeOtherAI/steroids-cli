import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { OllamaTagsResponse } from '../src/ollama/api-client.js';
import {
  getInstalledModels,
  loadModelCache,
  markModelAsPulled,
  sanitizeModelNameForPath,
} from '../src/ollama/model-registry.js';

describe('ollama model registry', () => {
  const originalHome = process.env.HOME;
  const originalSteroidsHome = process.env.STEROIDS_HOME;
  let tempHome = '';

  beforeEach(() => {
    tempHome = mkdtempSync(join('/tmp', 'steroids-ollama-model-registry-'));
    process.env.HOME = tempHome;
    process.env.STEROIDS_HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalSteroidsHome === undefined) {
      delete process.env.STEROIDS_HOME;
    } else {
      process.env.STEROIDS_HOME = originalSteroidsHome;
    }

    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('uses cache for cloud mode until TTL expires', async () => {
    const listInstalledModels = jest.fn<() => Promise<OllamaTagsResponse>>();
    listInstalledModels.mockResolvedValue({
      models: [
        {
          name: 'deepseek-coder-v2:33b',
          modified_at: '2026-03-06T10:00:00Z',
          size: 10,
          digest: 'abc',
          details: {
            family: 'deepseek2',
            parameter_size: '33B',
            quantization_level: 'Q4_K_M',
          },
        },
      ],
    });

    const client = {
      listInstalledModels,
    };

    const first = await getInstalledModels({
      client,
      endpoint: 'https://ollama.com',
      mode: 'cloud',
      now: 1000,
    });

    const second = await getInstalledModels({
      client,
      endpoint: 'https://ollama.com',
      mode: 'cloud',
      now: 1500,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(client.listInstalledModels).toHaveBeenCalledTimes(1);
  });

  it('always refreshes for local mode', async () => {
    const listInstalledModels = jest.fn<() => Promise<OllamaTagsResponse>>();
    listInstalledModels.mockResolvedValue({
      models: [
        {
          name: 'qwen2.5-coder:32b',
          modified_at: '2026-03-06T10:00:00Z',
          size: 11,
          digest: 'xyz',
          details: {
            family: 'qwen2',
            parameter_size: '32B',
            quantization_level: 'Q4_0',
          },
        },
      ],
    });

    const client = {
      listInstalledModels,
    };

    await getInstalledModels({
      client,
      endpoint: 'http://localhost:11434',
      mode: 'local',
      now: 1000,
    });

    await getInstalledModels({
      client,
      endpoint: 'http://localhost:11434',
      mode: 'local',
      now: 1500,
    });

    expect(client.listInstalledModels).toHaveBeenCalledTimes(2);
  });

  it('marks an existing cached model as pulled', async () => {
    const listInstalledModels = jest.fn<() => Promise<OllamaTagsResponse>>();
    listInstalledModels.mockResolvedValue({
      models: [
        {
          name: 'codestral:22b',
          modified_at: '2026-03-06T10:00:00Z',
          size: 12,
          digest: 'k99',
          details: {
            family: 'mistral',
            parameter_size: '22B',
            quantization_level: 'Q5_K_M',
          },
        },
      ],
    });

    const client = {
      listInstalledModels,
    };

    await getInstalledModels({
      client,
      endpoint: 'http://localhost:11434',
      mode: 'local',
      now: 1000,
    });

    markModelAsPulled('codestral:22b', 'http://localhost:11434', 1200);

    const cache = loadModelCache();
    expect(cache?.models[0].source).toBe('pulled');
    expect(cache?.lastUpdated).toBe(1200);
  });

  it('sanitizes model names for path-safe keys', () => {
    expect(sanitizeModelNameForPath('deepseek-coder-v2:33b')).toBe('deepseek-coder-v2_33b');
  });
});
