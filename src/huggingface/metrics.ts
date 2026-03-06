import type { TokenUsage } from '../providers/interface.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import { HuggingFaceModelRegistry, type HFCachedModel } from './model-registry.js';

const BASE_ROUTING_POLICIES = new Set(['fastest', 'cheapest', 'preferred']);

export interface HFRouteSelection {
  baseModel: string;
  routingPolicy: string;
  explicitProvider: string | null;
}

export interface HFHubRateLimitSnapshot {
  remaining: number | null;
  limit: number | null;
  resetSeconds: number | null;
  windowSeconds: number | null;
  observedAtMs: number;
}

export interface HFUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCostUsd: number;
}

export interface HFUsageByModel {
  model: string;
  provider: string | null;
  routingPolicy: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  estimatedCostUsd: number;
}

export interface HFUsageDashboard {
  today: HFUsageSummary;
  byModel7d: HFUsageByModel[];
}

interface HFUsageRow {
  model: string;
  provider: string | null;
  routing_policy: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: number | null;
  requests: number | null;
}

export function parseRoutedModel(model: string): HFRouteSelection {
  const trimmed = model.trim();
  if (!trimmed) {
    return {
      baseModel: '',
      routingPolicy: 'fastest',
      explicitProvider: null,
    };
  }

  const suffixIndex = trimmed.lastIndexOf(':');
  if (suffixIndex <= 0) {
    return {
      baseModel: trimmed,
      routingPolicy: 'fastest',
      explicitProvider: null,
    };
  }

  const baseModel = trimmed.slice(0, suffixIndex).trim();
  const suffix = trimmed.slice(suffixIndex + 1).trim();
  if (!suffix) {
    return {
      baseModel,
      routingPolicy: 'fastest',
      explicitProvider: null,
    };
  }

  const routingPolicy = suffix.toLowerCase();
  const explicitProvider = BASE_ROUTING_POLICIES.has(routingPolicy) ? null : routingPolicy;

  return {
    baseModel,
    routingPolicy,
    explicitProvider,
  };
}

export function parseHubRateLimitHeaders(
  headers:
    | Headers
    | {
      rateLimit?: string | null;
      rateLimitPolicy?: string | null;
    },
  nowMs = Date.now()
): HFHubRateLimitSnapshot | null {
  const rateLimit = getHeaderValue(headers, 'ratelimit');
  const rateLimitPolicy = getHeaderValue(headers, 'ratelimit-policy');

  if (!rateLimit && !rateLimitPolicy) {
    return null;
  }

  return {
    remaining: parseHeaderMetric(rateLimit, 'r'),
    limit: parseHeaderMetric(rateLimitPolicy, 'q'),
    resetSeconds: parseHeaderMetric(rateLimit, 't'),
    windowSeconds: parseHeaderMetric(rateLimitPolicy, 'w'),
    observedAtMs: nowMs,
  };
}

export function extractInferenceProviderFromHeaders(headers: Headers): string | null {
  const candidates = [
    'x-hf-inference-provider',
    'x-inference-provider',
    'x-provider',
    'huggingface-inference-provider',
  ];

  for (const key of candidates) {
    const value = headers.get(key);
    if (!value) continue;
    const provider = value.trim().toLowerCase();
    if (provider) return provider;
  }

  return null;
}

export class HuggingFaceUsageMetrics {
  private readonly registry: Pick<HuggingFaceModelRegistry, 'getCachedModel'>;

  constructor(options: { registry?: Pick<HuggingFaceModelRegistry, 'getCachedModel'> } = {}) {
    this.registry = options.registry ?? new HuggingFaceModelRegistry();
  }

  recordInvocationUsage(input: {
    requestedModel: string;
    role?: 'orchestrator' | 'coder' | 'reviewer';
    tokenUsage?: TokenUsage;
    providerHint?: string | null;
    createdAtMs?: number;
  }): void {
    const usage = input.tokenUsage;
    if (!usage) return;

    const promptTokens = toSafeInt(usage.inputTokens);
    const completionTokens = toSafeInt(usage.outputTokens);
    if (promptTokens === null || completionTokens === null) return;

    const route = parseRoutedModel(input.requestedModel);
    if (!route.baseModel) return;

    const model = this.registry.getCachedModel(route.baseModel);
    const pricingSelection = selectPricing(model, route.routingPolicy, route.explicitProvider, input.providerHint);
    const estimatedCostUsd = pricingSelection.pricing
      ? estimateCostUsd(promptTokens, completionTokens, pricingSelection.pricing.input, pricingSelection.pricing.output)
      : null;

    const { db, close } = openGlobalDatabase();
    try {
      db.prepare(
        `INSERT INTO hf_usage (
          model, provider, routing_policy, role, prompt_tokens, completion_tokens, estimated_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        route.baseModel,
        pricingSelection.provider,
        route.routingPolicy,
        input.role ?? null,
        promptTokens,
        completionTokens,
        estimatedCostUsd,
        input.createdAtMs ?? Date.now()
      );
    } finally {
      close();
    }
  }

  getDashboardUsage(): HFUsageDashboard {
    return {
      today: this.getUsageSummary(24),
      byModel7d: this.getUsageByModel(24 * 7, 8),
    };
  }

  getUsageSummary(hours: number): HFUsageSummary {
    const sinceMs = Date.now() - (Math.max(1, hours) * 60 * 60 * 1000);
    const { db, close } = openGlobalDatabase();
    try {
      const row = db.prepare(
        `SELECT
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COUNT(*) AS requests,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
         FROM hf_usage
         WHERE created_at >= ?`
      ).get(sinceMs) as HFUsageRow;

      const promptTokens = row.prompt_tokens ?? 0;
      const completionTokens = row.completion_tokens ?? 0;
      return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        requests: row.requests ?? 0,
        estimatedCostUsd: row.estimated_cost_usd ?? 0,
      };
    } finally {
      close();
    }
  }

  getUsageByModel(hours: number, limit = 8): HFUsageByModel[] {
    const sinceMs = Date.now() - (Math.max(1, hours) * 60 * 60 * 1000);
    const cappedLimit = Math.max(1, Math.min(50, limit));
    const { db, close } = openGlobalDatabase();
    try {
      const rows = db.prepare(
        `SELECT
           model,
           provider,
           COALESCE(routing_policy, 'fastest') AS routing_policy,
           COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COUNT(*) AS requests,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
         FROM hf_usage
         WHERE created_at >= ?
         GROUP BY model, provider, routing_policy
         ORDER BY (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0)) DESC,
                  COUNT(*) DESC,
                  model ASC
         LIMIT ?`
      ).all(sinceMs, cappedLimit) as HFUsageRow[];

      return rows.map((row) => {
        const promptTokens = row.prompt_tokens ?? 0;
        const completionTokens = row.completion_tokens ?? 0;
        return {
          model: row.model,
          provider: row.provider,
          routingPolicy: row.routing_policy ?? 'fastest',
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          requests: row.requests ?? 0,
          estimatedCostUsd: row.estimated_cost_usd ?? 0,
        };
      });
    } finally {
      close();
    }
  }
}

function getHeaderValue(
  headers:
    | Headers
    | {
      rateLimit?: string | null;
      rateLimitPolicy?: string | null;
    },
  key: 'ratelimit' | 'ratelimit-policy'
): string | null {
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  if (key === 'ratelimit') return headers.rateLimit ?? null;
  return headers.rateLimitPolicy ?? null;
}

function parseHeaderMetric(raw: string | null, token: 'r' | 't' | 'q' | 'w'): number | null {
  if (!raw) return null;
  const match = raw.match(new RegExp(`(?:^|[;,\\s])${token}=(\\d+)`, 'i'));
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSafeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.round(value);
  return normalized >= 0 ? normalized : null;
}

function estimateCostUsd(
  promptTokens: number,
  completionTokens: number,
  inputPerMillion: number,
  outputPerMillion: number
): number {
  return (promptTokens * inputPerMillion / 1_000_000) + (completionTokens * outputPerMillion / 1_000_000);
}

function selectPricing(
  model: HFCachedModel | null,
  routingPolicy: string,
  explicitProvider: string | null,
  providerHint?: string | null
): {
  provider: string | null;
  pricing: { input: number; output: number } | null;
} {
  const pricing = model?.pricing;
  if (!pricing || Object.keys(pricing).length === 0) {
    return { provider: explicitProvider ?? providerHint ?? null, pricing: null };
  }

  const providerMap = normalizeProviderMap(pricing);
  const selectedByHint = providerHint ? providerMap.get(providerHint.toLowerCase()) : undefined;
  if (selectedByHint) {
    return {
      provider: selectedByHint.provider,
      pricing: selectedByHint.pricing,
    };
  }

  if (explicitProvider) {
    const byExplicitProvider = providerMap.get(explicitProvider.toLowerCase());
    if (byExplicitProvider) {
      return {
        provider: byExplicitProvider.provider,
        pricing: byExplicitProvider.pricing,
      };
    }
  }

  if (routingPolicy === 'cheapest') {
    const cheapest = Array.from(providerMap.values()).sort((a, b) => {
      const aCost = a.pricing.input + a.pricing.output;
      const bCost = b.pricing.input + b.pricing.output;
      return aCost - bCost || a.provider.localeCompare(b.provider);
    })[0];

    if (cheapest) {
      return {
        provider: cheapest.provider,
        pricing: cheapest.pricing,
      };
    }
  }

  const prices = Array.from(providerMap.values());
  if (prices.length === 0) {
    return { provider: explicitProvider ?? providerHint ?? null, pricing: null };
  }

  const avgInput = prices.reduce((sum, p) => sum + p.pricing.input, 0) / prices.length;
  const avgOutput = prices.reduce((sum, p) => sum + p.pricing.output, 0) / prices.length;

  return {
    provider: explicitProvider ?? providerHint ?? null,
    pricing: {
      input: avgInput,
      output: avgOutput,
    },
  };
}

function normalizeProviderMap(
  pricing: Record<string, { input: number; output: number }>
): Map<string, { provider: string; pricing: { input: number; output: number } }> {
  const result = new Map<string, { provider: string; pricing: { input: number; output: number } }>();

  for (const [provider, rate] of Object.entries(pricing)) {
    if (
      typeof rate.input !== 'number' ||
      typeof rate.output !== 'number' ||
      !Number.isFinite(rate.input) ||
      !Number.isFinite(rate.output)
    ) {
      continue;
    }
    result.set(provider.toLowerCase(), {
      provider,
      pricing: {
        input: rate.input,
        output: rate.output,
      },
    });
  }

  return result;
}
