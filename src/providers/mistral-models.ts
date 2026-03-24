/**
 * Mistral API model discovery
 *
 * Fetches and filters the available model list from the Mistral API.
 * Used by MistralProvider.initialize() to populate the model catalog at startup.
 */

import type { ModelInfo } from './interface.js';

/**
 * Fallback model list used when the Mistral API is unreachable.
 * IDs MUST be real Mistral API model identifiers (not vibe aliases).
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'mistral-vibe-cli-latest',
    name: 'Devstral (Vibe CLI)',
    recommendedFor: ['orchestrator', 'coder', 'reviewer'],
    supportsStreaming: true,
    contextWindow: 262144,
  },
  {
    id: 'codestral-latest',
    name: 'Codestral (latest)',
    recommendedFor: ['coder'],
    supportsStreaming: true,
    contextWindow: 256000,
  },
  {
    id: 'mistral-large-latest',
    name: 'Mistral Large (latest)',
    recommendedFor: [],
    supportsStreaming: true,
    contextWindow: 262144,
  },
  {
    id: 'mistral-medium-latest',
    name: 'Mistral Medium (latest)',
    recommendedFor: [],
    supportsStreaming: true,
    contextWindow: 131072,
  },
  {
    id: 'mistral-small-latest',
    name: 'Mistral Small (latest)',
    recommendedFor: [],
    supportsStreaming: true,
    contextWindow: 262144,
  },
  {
    id: 'magistral-medium-latest',
    name: 'Magistral Medium (reasoning)',
    recommendedFor: [],
    supportsStreaming: true,
    contextWindow: 131072,
  },
];

interface MistralAPIModel {
  id: string;
  name: string; // underlying model name (e.g. "devstral-2512")
  description?: string;
  max_context_length?: number;
  capabilities?: {
    completion_chat?: boolean;
    function_calling?: boolean;
    reasoning?: boolean;
    completion_fim?: boolean;
  };
  deprecation?: string | null;
  aliases?: string[];
}

/**
 * Fetch available models from the Mistral API.
 * Returns null if the API is unreachable or no key is available.
 */
export async function fetchMistralModelList(): Promise<ModelInfo[] | null> {
  const apiKey = process.env.STEROIDS_MISTRAL || process.env.MISTRAL_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://api.mistral.ai/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: MistralAPIModel[];
    } | MistralAPIModel[];

    const raw: MistralAPIModel[] = Array.isArray(data) ? data : (data.data ?? []);

    // Keep only chat + function_calling models (no embeds, OCR, moderation, audio-only)
    const chatModels = raw.filter(
      (m) => m.capabilities?.completion_chat && m.capabilities?.function_calling
    );

    // Prefer -latest aliases — group by underlying model name, keep best ID
    const byUnderlying = new Map<string, MistralAPIModel>();
    for (const m of chatModels) {
      const key = m.name; // underlying model name (e.g. "devstral-2512")
      const existing = byUnderlying.get(key);
      if (!existing || preferLatest(m, existing)) {
        byUnderlying.set(key, m);
      }
    }

    const models: ModelInfo[] = [...byUnderlying.values()].map((m) => ({
      id: m.id,
      name: m.description || formatModelName(m.id),
      recommendedFor: inferRecommendation(m),
      supportsStreaming: true,
      contextWindow: m.max_context_length,
    }));

    // Sort: vibe/devstral first, then codestral, large, medium, small, others
    models.sort((a, b) => modelSortScore(a.id) - modelSortScore(b.id));

    return models;
  } catch {
    return null; // Network error / timeout
  }
}

function preferLatest(candidate: MistralAPIModel, existing: MistralAPIModel): boolean {
  const score = (m: MistralAPIModel) => {
    if (m.id.endsWith('-latest')) return 10;
    if (m.id.includes('vibe-cli')) return 8;
    return 0;
  };
  return score(candidate) > score(existing);
}

function formatModelName(id: string): string {
  return id
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function inferRecommendation(m: MistralAPIModel): ('orchestrator' | 'coder' | 'reviewer')[] {
  if (m.id.includes('vibe-cli') || m.id.includes('devstral') || m.id.includes('codestral')) {
    return ['coder', 'reviewer', 'orchestrator'];
  }
  return [];
}

function modelSortScore(id: string): number {
  if (id.includes('vibe-cli')) return 0;
  if (id.includes('devstral')) return 1;
  if (id.includes('codestral')) return 2;
  if (id.includes('mistral-large')) return 3;
  if (id.includes('mistral-medium')) return 4;
  if (id.includes('mistral-small')) return 5;
  if (id.includes('magistral')) return 6;
  return 10;
}
