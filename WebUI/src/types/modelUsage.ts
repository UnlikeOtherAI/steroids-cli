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
  ollama?: {
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      requests: number;
      avg_tokens_per_second: number | null;
    };
    by_model: Array<{
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      requests: number;
      avg_tokens_per_second: number | null;
    }>;
    runtime: {
      connected: boolean;
      endpoint: string;
      mode: 'local' | 'cloud';
      loaded_models: number;
      total_vram_bytes: number;
      total_ram_bytes: number;
      models: Array<{
        name: string;
        size_bytes: number;
        vram_bytes: number;
        ram_bytes: number;
        context_length: number | null;
        expires_at: string | null;
        unload_in_seconds: number | null;
      }>;
      error?: string;
    };
  };
}
