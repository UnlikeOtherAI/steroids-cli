/**
 * Model usage API types
 */

export interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  totalTokens: number;
  invocations: number;
}

export interface ModelUsageByModel extends ModelUsageStats {
  provider: string;
  model: string;
}

export interface ModelUsageByProject extends ModelUsageStats {
  project_path: string;
  project_name: string | null;
}

export interface ModelUsageResponse {
  success: boolean;
  hours: number;
  stats: ModelUsageStats;
  by_model: ModelUsageByModel[];
  by_project: ModelUsageByProject[];
}
