import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HuggingFaceModelRegistry } from '../src/huggingface/model-registry.js';
import { HubAPIError, type HFModel } from '../src/huggingface/hub-client.js';

describe('HuggingFaceModelRegistry', () => {
  const now = new Date('2026-03-06T12:00:00.000Z').getTime();
  const downloadFirst: HFModel[] = [
    { id: 'org/a', downloads: 1000, likes: 10, createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'org/b', downloads: 900, likes: 500, createdAt: '2026-03-01T00:00:00.000Z' },
  ];
  const likesFirst: HFModel[] = [
    { id: 'org/c', downloads: 100, likes: 1000, createdAt: '2025-09-01T00:00:00.000Z' },
    { id: 'org/b', downloads: 900, likes: 500, createdAt: '2026-03-01T00:00:00.000Z' },
  ];
  const newestFirst: HFModel[] = [
    { id: 'org/b', downloads: 900, likes: 500, createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'org/d', downloads: 50, likes: 50, createdAt: '2026-03-05T00:00:00.000Z' },
  ];

  const listModels = jest.fn<(options?: Record<string, unknown>) => Promise<HFModel[]>>();
  const getModel = jest.fn<(modelId: string) => Promise<HFModel>>();
  const listRouterModels = jest.fn<(token: string) => Promise<Array<Record<string, unknown>>>>();
  let cacheDir: string;

  beforeEach(() => {
    listModels.mockReset();
    getModel.mockReset();
    listRouterModels.mockReset();
    cacheDir = mkdtempSync(join(tmpdir(), 'hf-registry-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('refreshes curated models, dedupes, and falls back when trending sort is unsupported', async () => {
    listModels.mockImplementation(async (options?: Record<string, unknown>) => {
      switch (options?.sort) {
        case 'downloads':
          return downloadFirst;
        case 'likes':
          return likesFirst;
        case 'createdAt':
          return newestFirst;
        case 'trendingScore':
          throw new HubAPIError('unsupported sort', 400);
        default:
          return [];
      }
    });
    getModel.mockImplementation(async (modelId: string) => ({
      id: modelId,
      inferenceProviderMapping: {
        together: { status: 'live' },
        groq: { status: 'staging' },
      },
    }));
    listRouterModels.mockResolvedValue([
      {
        id: 'org/b',
        providers: [
          { provider: 'together', status: 'live', context_length: 131072, supports_tools: true, pricing: { input: 0.15, output: 0.75 } },
        ],
      },
    ]);

    const registry = new HuggingFaceModelRegistry({
      client: {
        listModels,
        getModel,
        searchModels: jest.fn(),
        getWhoAmI: jest.fn(),
        listRouterModels,
      } as any,
      cacheFilePath: join(cacheDir, 'models.json'),
      curatedLimit: 3,
      nowFn: () => now,
    });

    const models = await registry.refreshCuratedModels();

    expect(models.map((m) => m.id)).toEqual(['org/b', 'org/a', 'org/c']);
    expect(models[0].providers).toEqual(['together']);
    expect(models[0].source).toBe('curated');
    expect(models[0].contextLength).toBe(131072);
    expect(models[0].supportsTools).toBe(true);
    expect(models[0].pricing).toEqual({ together: { input: 0.15, output: 0.75 } });
    expect(models[0].providerDetails).toEqual([
      {
        provider: 'together',
        contextLength: 131072,
        pricing: { input: 0.15, output: 0.75 },
        supportsTools: true,
        supportsStructuredOutput: undefined,
        isModelAuthor: undefined,
      },
    ]);
    expect(listModels).toHaveBeenCalledTimes(4);
    expect(getModel).toHaveBeenCalledTimes(3);
    expect(listRouterModels).toHaveBeenCalledTimes(1);
  });

  it('uses fresh cache instead of refetching', async () => {
    const cachePath = join(cacheDir, 'models.json');
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastUpdated: now,
        models: [{ id: 'org/cached', pipelineTag: 'text-generation', downloads: 1, likes: 1, tags: [], providers: [], addedAt: now, source: 'curated' }],
      }),
      'utf-8'
    );

    const registry = new HuggingFaceModelRegistry({
      client: {
        listModels,
        getModel,
        searchModels: jest.fn(),
        getWhoAmI: jest.fn(),
        listRouterModels,
      } as any,
      cacheFilePath: cachePath,
      nowFn: () => now + 1000,
    });

    const models = await registry.getCuratedModels();
    expect(models.map((m) => m.id)).toEqual(['org/cached']);
    expect(listModels).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
  });

  it('auto-refreshes cache when older than 24 hours', async () => {
    const cachePath = join(cacheDir, 'models.json');
    const twentyFourHoursAndOneMs = (24 * 60 * 60 * 1000) + 1;
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastUpdated: now,
        models: [{ id: 'org/cached', pipelineTag: 'text-generation', downloads: 1, likes: 1, tags: [], providers: [], addedAt: now, source: 'curated' }],
      }),
      'utf-8'
    );

    listModels.mockResolvedValue([]);

    const registry = new HuggingFaceModelRegistry({
      client: {
        listModels,
        getModel,
        searchModels: jest.fn(),
        getWhoAmI: jest.fn(),
        listRouterModels,
      } as any,
      cacheFilePath: cachePath,
      nowFn: () => now + twentyFourHoursAndOneMs,
    });

    await registry.getCuratedModels();
    expect(listModels).toHaveBeenCalled();
  });

  it('deletes corrupted cache and rebuilds on demand', async () => {
    const cachePath = join(cacheDir, 'models.json');
    writeFileSync(cachePath, '{invalid json', 'utf-8');
    listModels.mockResolvedValue([]);

    const registry = new HuggingFaceModelRegistry({
      client: {
        listModels,
        getModel,
        searchModels: jest.fn(),
        getWhoAmI: jest.fn(),
        listRouterModels,
      } as any,
      cacheFilePath: cachePath,
      nowFn: () => now,
    });

    await registry.getCuratedModels();
    const rebuilt = JSON.parse(readFileSync(cachePath, 'utf-8')) as { models: unknown[] };
    expect(Array.isArray(rebuilt.models)).toBe(true);
  });

  it('propagates trending query failures that are not unsupported-sort errors', async () => {
    listModels.mockImplementation(async (options?: Record<string, unknown>) => {
      switch (options?.sort) {
        case 'downloads':
          return downloadFirst;
        case 'likes':
          return likesFirst;
        case 'createdAt':
          return newestFirst;
        case 'trendingScore':
          throw new HubAPIError('Unauthorized', 401);
        default:
          return [];
      }
    });

    const registry = new HuggingFaceModelRegistry({
      client: {
        listModels,
        getModel,
        searchModels: jest.fn(),
        getWhoAmI: jest.fn(),
        listRouterModels,
      } as any,
      cacheFilePath: join(cacheDir, 'models.json'),
      nowFn: () => now,
    });

    await expect(registry.refreshCuratedModels()).rejects.toEqual(
      expect.objectContaining({ status: 401 })
    );
  });
});
