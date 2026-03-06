import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HuggingFaceHubClient,
  HubAPIError,
  type HFInferenceProviderInfo,
  type HFModel,
  type HFRouterModel,
  type HFRouterProvider,
} from './hub-client.js';

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CURATED_LIMIT = 100;

export type HFModelSource = 'curated' | 'search' | 'manual';

export interface HFCachedModel {
  id: string;
  pipelineTag: string;
  downloads: number;
  likes: number;
  tags: string[];
  providers: string[];
  contextLength?: number;
  pricing?: Record<string, { input: number; output: number }>;
  supportsTools?: boolean;
  providerContextLengths?: Record<string, number>;
  addedAt: number;
  source: HFModelSource;
}

export interface HFModelCache {
  lastUpdated: number;
  models: HFCachedModel[];
}

interface CuratedCandidate {
  model: HFModel;
  firstSeenAt: number;
  inTrending: boolean;
  trendingIndex: number;
}

export class HuggingFaceModelRegistry {
  private readonly client: HuggingFaceHubClient;
  private readonly cacheFilePath: string;
  private readonly cacheTtlMs: number;
  private readonly curatedLimit: number;
  private readonly nowFn: () => number;

  constructor(options: {
    client?: HuggingFaceHubClient;
    cacheFilePath?: string;
    cacheTtlMs?: number;
    curatedLimit?: number;
    nowFn?: () => number;
  } = {}) {
    this.client = options.client ?? new HuggingFaceHubClient();
    this.cacheFilePath = options.cacheFilePath ?? join(homedir(), '.steroids', 'huggingface', 'models.json');
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.curatedLimit = options.curatedLimit ?? DEFAULT_CURATED_LIMIT;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  async getCuratedModels(options: { forceRefresh?: boolean; token?: string } = {}): Promise<HFCachedModel[]> {
    const cache = this.readCache();
    const forceRefresh = options.forceRefresh ?? false;
    const cacheIsFresh = cache && this.nowFn() - cache.lastUpdated < this.cacheTtlMs;

    if (!forceRefresh && cacheIsFresh) {
      return cache.models;
    }

    return this.refreshCuratedModels({ token: options.token });
  }

  async refreshCuratedModels(options: { token?: string } = {}): Promise<HFCachedModel[]> {
    const token = options.token;
    const [downloads, likes, newest] = await Promise.all([
      this.client.listModels({
        sort: 'downloads',
        direction: -1,
        limit: 50,
        token,
      }),
      this.client.listModels({
        sort: 'likes',
        direction: -1,
        limit: 50,
        token,
      }),
      this.client.listModels({
        sort: 'createdAt',
        direction: -1,
        limit: 30,
        token,
      }),
    ]);

    const trending = await this.fetchTrendingList(token);
    const candidates = this.mergeCandidates(downloads, likes, newest, trending);
    const ranked = this.rankCandidates(candidates, Boolean(trending));
    const selected = ranked.slice(0, this.curatedLimit);

    const withProviders = await this.enrichProviders(selected, token, 'curated');
    const existing = this.readCache();
    const carried = (existing?.models ?? []).filter((model) => model.source !== 'curated');
    const byId = new Map<string, HFCachedModel>(withProviders.map((model) => [model.id, model]));
    for (const model of carried) {
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
    const cachePayload: HFModelCache = {
      lastUpdated: this.nowFn(),
      models: Array.from(byId.values()),
    };
    this.writeCache(cachePayload);
    return withProviders;
  }

  async searchModels(query: string, options: { limit?: number; token?: string } = {}): Promise<HFCachedModel[]> {
    const models = await this.client.searchModels(query, {
      limit: options.limit ?? 20,
      token: options.token,
    });
    const enriched = await this.enrichProviders(models, options.token, 'search');
    this.upsertModelsIntoCache(enriched);
    return enriched;
  }

  getCachedModel(modelId: string): HFCachedModel | null {
    const cache = this.readCache();
    if (!cache) return null;
    return cache.models.find((model) => model.id === modelId) ?? null;
  }

  private async fetchTrendingList(token?: string): Promise<HFModel[] | undefined> {
    try {
      return await this.client.listModels({
        sort: 'trendingScore',
        direction: -1,
        limit: 30,
        token,
      });
    } catch (error) {
      if (isUnsupportedTrendingSort(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private mergeCandidates(
    downloads: HFModel[],
    likes: HFModel[],
    newest: HFModel[],
    trending?: HFModel[]
  ): CuratedCandidate[] {
    const byId = new Map<string, CuratedCandidate>();

    const upsert = (models: HFModel[], now: number, inTrending = false) => {
      models.forEach((model, index) => {
        const existing = byId.get(model.id);
        const next: CuratedCandidate = existing ?? {
          model,
          firstSeenAt: now,
          inTrending,
          trendingIndex: index,
        };
        next.model = {
          ...next.model,
          ...model,
        };
        if (inTrending) {
          next.inTrending = true;
          next.trendingIndex = Math.min(next.trendingIndex, index);
        }
        byId.set(model.id, next);
      });
    };

    upsert(downloads, this.nowFn());
    upsert(likes, this.nowFn());
    upsert(newest, this.nowFn());
    if (trending) {
      upsert(trending, this.nowFn(), true);
    }

    return Array.from(byId.values());
  }

  private rankCandidates(candidates: CuratedCandidate[], includeTrending: boolean): HFModel[] {
    const downloads = candidates.map((c) => c.model.downloads ?? 0);
    const likes = candidates.map((c) => c.model.likes ?? 0);
    const recencies = candidates.map((c) => this.toTimestamp(c.model.createdAt) ?? c.firstSeenAt);
    const maxTrendingIndex = Math.max(
      1,
      ...candidates.filter((c) => c.inTrending).map((c) => c.trendingIndex + 1)
    );

    const scored = candidates.map((candidate) => {
      const normDownloads = normalize(candidate.model.downloads ?? 0, downloads);
      const normLikes = normalize(candidate.model.likes ?? 0, likes);
      const normRecency = normalize(this.toTimestamp(candidate.model.createdAt) ?? candidate.firstSeenAt, recencies);
      const trendingScore = candidate.inTrending ? (maxTrendingIndex - candidate.trendingIndex) / maxTrendingIndex : 0;

      const score = includeTrending
        ? (0.4 * normDownloads) + (0.3 * normLikes) + (0.15 * normRecency) + (0.15 * trendingScore)
        : (0.5 * normDownloads) + (0.3 * normLikes) + (0.2 * normRecency);

      return {
        id: candidate.model.id,
        score,
        model: candidate.model,
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });

    return scored.map((entry) => entry.model);
  }

  private async enrichProviders(models: HFModel[], token: string | undefined, source: HFModelSource): Promise<HFCachedModel[]> {
    const routerByModel = await this.getRouterModelMap(token);
    const mapped = await mapWithConcurrency(models, 8, async (model) => {
      const detail = await this.client.getModel(model.id, { token, expandInferenceProviders: true });
      const providers = this.extractProviders(detail.inferenceProviderMapping);
      const providerStats = this.toProviderStats(routerByModel.get(model.id)?.providers);
      return this.toCachedModel(
        { ...model, ...detail },
        providers,
        source,
        providerStats.contextLength,
        providerStats.supportsTools,
        providerStats.pricing,
        providerStats.providerContextLengths
      );
    });

    return mapped;
  }

  private extractProviders(mapping?: Record<string, HFInferenceProviderInfo>): string[] {
    if (!mapping) return [];
    return Object.entries(mapping)
      .filter(([, info]) => info?.status === 'live' || info?.status === undefined)
      .map(([provider]) => provider)
      .sort((a, b) => a.localeCompare(b));
  }

  private toCachedModel(
    model: HFModel,
    providers: string[],
    source: HFModelSource,
    contextLength?: number,
    supportsTools?: boolean,
    pricing?: Record<string, { input: number; output: number }>,
    providerContextLengths?: Record<string, number>
  ): HFCachedModel {
    return {
      id: model.id,
      pipelineTag: model.pipeline_tag ?? 'text-generation',
      downloads: model.downloads ?? 0,
      likes: model.likes ?? 0,
      tags: model.tags ?? [],
      providers,
      contextLength,
      supportsTools,
      pricing,
      providerContextLengths,
      addedAt: this.nowFn(),
      source,
    };
  }

  private async getRouterModelMap(token?: string): Promise<Map<string, HFRouterModel>> {
    try {
      const models = await this.client.listRouterModels(token);
      return new Map(models.map((model) => [model.id, model]));
    } catch {
      return new Map();
    }
  }

  private toProviderStats(providers?: HFRouterProvider[]): {
    contextLength?: number;
    supportsTools?: boolean;
    pricing?: Record<string, { input: number; output: number }>;
    providerContextLengths?: Record<string, number>;
  } {
    if (!providers || providers.length === 0) {
      return {};
    }

    let maxContextLength: number | undefined;
    let supportsTools = false;
    const pricing: Record<string, { input: number; output: number }> = {};
    const providerContextLengths: Record<string, number> = {};

    for (const provider of providers) {
      if (provider.status && provider.status !== 'live') continue;
      const providerName = provider.provider;
      if (!providerName) continue;

      if (typeof provider.context_length === 'number' && Number.isFinite(provider.context_length)) {
        providerContextLengths[providerName] = provider.context_length;
        maxContextLength = maxContextLength === undefined
          ? provider.context_length
          : Math.max(maxContextLength, provider.context_length);
      }

      if (provider.supports_tools) {
        supportsTools = true;
      }

      if (
        typeof provider.pricing?.input === 'number' &&
        Number.isFinite(provider.pricing.input) &&
        typeof provider.pricing?.output === 'number' &&
        Number.isFinite(provider.pricing.output)
      ) {
        pricing[providerName] = {
          input: provider.pricing.input,
          output: provider.pricing.output,
        };
      }
    }

    return {
      contextLength: maxContextLength,
      supportsTools,
      pricing: Object.keys(pricing).length > 0 ? pricing : undefined,
      providerContextLengths: Object.keys(providerContextLengths).length > 0 ? providerContextLengths : undefined,
    };
  }

  private toTimestamp(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private readCache(): HFModelCache | null {
    if (!existsSync(this.cacheFilePath)) return null;
    try {
      const raw = readFileSync(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as HFModelCache;
      if (!parsed || !Array.isArray(parsed.models) || typeof parsed.lastUpdated !== 'number') {
        throw new Error('Invalid cache schema');
      }
      return parsed;
    } catch {
      try {
        rmSync(this.cacheFilePath, { force: true });
      } catch {
        // Ignore cleanup errors on corrupted cache.
      }
      return null;
    }
  }

  private writeCache(cache: HFModelCache): void {
    const parentDir = dirname(this.cacheFilePath);
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.cacheFilePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
  }

  private upsertModelsIntoCache(models: HFCachedModel[]): void {
    if (models.length === 0) return;
    const existing = this.readCache();
    const byId = new Map<string, HFCachedModel>((existing?.models ?? []).map((model) => [model.id, model]));
    for (const model of models) {
      byId.set(model.id, model);
    }
    this.writeCache({
      lastUpdated: existing?.lastUpdated ?? this.nowFn(),
      models: Array.from(byId.values()),
    });
  }
}

function normalize(value: number, values: number[]): number {
  if (values.length === 0) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return max === 0 ? 0 : 1;
  return (value - min) / (max - min);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (items.length === 0) return [];
  const results: U[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function isUnsupportedTrendingSort(error: unknown): boolean {
  if (!(error instanceof HubAPIError)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  return /trending|trendingscore|sort|unsupported|invalid/i.test(error.message);
}
