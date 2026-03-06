export type HFTier = 'free' | 'pro' | 'enterprise';

export interface HFAccountStatus {
  connected: boolean;
  valid?: boolean;
  name?: string | null;
  tier?: HFTier;
  canPay?: boolean;
  hasBroadScopes?: boolean;
  periodEnd?: string | null;
  error?: string;
}

export interface HFCachedModel {
  id: string;
  pipelineTag: string;
  downloads: number;
  likes: number;
  tags: string[];
  providers: string[];
  addedAt: number;
  source: 'curated' | 'search' | 'manual';
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
  routingPolicyOptions: string[];
}

export interface HFReadyModelsResponse {
  models: HFReadyModel[];
}
