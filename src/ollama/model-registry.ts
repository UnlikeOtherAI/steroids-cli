import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalSteroidsDir } from '../runners/global-db-connection.js';
import type { OllamaApiClient, OllamaTagModel } from './api-client.js';
import type { OllamaConnectionMode } from './connection.js';

const CLOUD_CACHE_TTL_MS = 5 * 60 * 1000;

export interface OllamaCachedModel {
  name: string;
  size: number;
  parameterSize: string;
  family: string;
  quantization: string;
  digest: string;
  modifiedAt: string;
  source: 'installed' | 'pulled';
}

export interface OllamaModelCache {
  lastUpdated: number;
  endpoint: string;
  models: OllamaCachedModel[];
}

export interface GetInstalledModelsOptions {
  client: Pick<OllamaApiClient, 'listInstalledModels'>;
  endpoint: string;
  mode: OllamaConnectionMode;
  now?: number;
  forceRefresh?: boolean;
  cloudTtlMs?: number;
}

export function getOllamaModelsCachePath(): string {
  return join(getGlobalSteroidsDir(), 'ollama', 'models.json');
}

export function loadModelCache(): OllamaModelCache | null {
  const cachePath = getOllamaModelsCachePath();
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<OllamaModelCache>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return {
      lastUpdated: Number(parsed.lastUpdated) || 0,
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      models: Array.isArray(parsed.models)
        ? parsed.models.filter(isCachedModel)
        : [],
    };
  } catch {
    return null;
  }
}

export function saveModelCache(cache: OllamaModelCache): void {
  const cachePath = getOllamaModelsCachePath();
  const cacheDir = join(getGlobalSteroidsDir(), 'ollama');

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

export async function refreshInstalledModels(options: GetInstalledModelsOptions): Promise<OllamaCachedModel[]> {
  const response = await options.client.listInstalledModels();
  const models = response.models.map((model) => toCachedModel(model, 'installed'));

  saveModelCache({
    lastUpdated: options.now ?? Date.now(),
    endpoint: normalizeEndpoint(options.endpoint),
    models,
  });

  return models;
}

export async function getInstalledModels(options: GetInstalledModelsOptions): Promise<OllamaCachedModel[]> {
  const now = options.now ?? Date.now();
  const cache = loadModelCache();
  const endpoint = normalizeEndpoint(options.endpoint);

  if (!options.forceRefresh && cache && cache.endpoint === endpoint) {
    const maxAgeMs = options.mode === 'cloud' ? (options.cloudTtlMs ?? CLOUD_CACHE_TTL_MS) : 0;
    const ageMs = now - cache.lastUpdated;

    if (ageMs >= 0 && ageMs <= maxAgeMs) {
      return cache.models;
    }
  }

  return refreshInstalledModels({ ...options, now });
}

export function markModelAsPulled(name: string, endpoint: string, now: number = Date.now()): void {
  const cache = loadModelCache();
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  if (!cache || cache.endpoint !== normalizedEndpoint) {
    return;
  }

  const modelName = name.trim();
  const model = cache.models.find((entry) => entry.name === modelName);
  if (!model) {
    return;
  }

  model.source = 'pulled';
  cache.lastUpdated = now;
  saveModelCache(cache);
}

export function sanitizeModelNameForPath(modelName: string): string {
  return modelName.replace(/:/g, '_');
}

function toCachedModel(model: OllamaTagModel, source: 'installed' | 'pulled'): OllamaCachedModel {
  return {
    name: model.name,
    size: model.size,
    parameterSize: model.details?.parameter_size ?? '',
    family: model.details?.family ?? '',
    quantization: model.details?.quantization_level ?? '',
    digest: model.digest,
    modifiedAt: model.modified_at,
    source,
  };
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function isCachedModel(value: unknown): value is OllamaCachedModel {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;

  return (
    typeof entry.name === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.parameterSize === 'string' &&
    typeof entry.family === 'string' &&
    typeof entry.quantization === 'string' &&
    typeof entry.digest === 'string' &&
    typeof entry.modifiedAt === 'string' &&
    (entry.source === 'installed' || entry.source === 'pulled')
  );
}
