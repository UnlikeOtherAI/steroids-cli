export type HFTier = 'free' | 'pro' | 'enterprise';

export interface HFAccountStatus {
  connected: boolean;
  valid?: boolean;
  name?: string | null;
  tier?: HFTier;
  canPay?: boolean;
  hasBroadScopes?: boolean;
  periodEnd?: string | null;
  rateLimit?: HFHubRateLimit | null;
  error?: string;
}

export interface HFHubRateLimit {
  remaining: number | null;
  limit: number | null;
  resetSeconds: number | null;
  windowSeconds: number | null;
  observedAtMs: number;
}

export interface HFCachedModel {
  id: string;
  pipelineTag: string;
  downloads: number;
  likes: number;
  tags: string[];
  providers: string[];
  providerDetails?: HFProviderDetail[];
  contextLength?: number;
  pricing?: Record<string, { input: number; output: number }>;
  supportsTools?: boolean;
  providerContextLengths?: Record<string, number>;
  addedAt: number;
  source: 'curated' | 'search' | 'manual';
}

export interface HFProviderDetail {
  provider: string;
  contextLength?: number;
  pricing?: { input: number; output: number };
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  isModelAuthor?: boolean;
}

export interface HFModelListResponse {
  source: 'curated' | 'search' | 'search-cache';
  models: HFCachedModel[];
}

export type HFRuntime = 'claude-code' | 'opencode';

export interface HFReadyModel {
  modelId: string;
  runtime: HFRuntime;
  routingPolicy: string;
  supportsTools: boolean;
  available: boolean;
  addedAt: number;
  providers: string[];
  contextLength?: number;
  pricing?: Record<string, { input: number; output: number }>;
  providerContextLengths?: Record<string, number>;
  routingPolicyOptions: string[];
}

export interface HFReadyModelsResponse {
  models: HFReadyModel[];
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

export interface HFUsageDashboardResponse {
  today: HFUsageSummary;
  byModel7d: HFUsageByModel[];
}
