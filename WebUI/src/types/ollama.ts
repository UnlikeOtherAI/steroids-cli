export type OllamaConnectionMode = 'local' | 'cloud';

export interface OllamaConnectionConfig {
  endpoint: string;
  mode: OllamaConnectionMode;
  cloudTier: string | null;
}

export interface OllamaConnectionStatus {
  connected: boolean;
  endpoint: string;
  mode: OllamaConnectionMode;
  version?: string;
  minimumVersionMet?: boolean;
  loadedModels?: number;
  error?: string;
}

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

export interface OllamaPairedModel {
  id: number;
  model_name: string;
  runtime: string;
  endpoint: string;
  supports_tools: number;
  available: number;
  added_at: number;
}
