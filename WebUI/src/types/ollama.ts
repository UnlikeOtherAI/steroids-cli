export type OllamaConnectionMode = 'local' | 'cloud';
export type OllamaRuntime = 'claude-code' | 'opencode';

export interface OllamaLoadedModel {
  name: string;
  sizeVram?: number;
}

export interface OllamaConnectionStatus {
  mode: OllamaConnectionMode;
  endpoint: string;
  connected: boolean;
  version?: string | null;
  loadedModels?: OllamaLoadedModel[];
  cloudTier?: string | null;
}

export interface OllamaInstalledModel {
  name: string;
  size: number;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  digest?: string | null;
  supportsTools?: boolean;
}

export interface OllamaInstalledModelsResponse {
  models: OllamaInstalledModel[];
}

export interface OllamaLibraryModel {
  name: string;
  description: string;
  parameterSize?: string;
  quantization?: string;
}

export interface OllamaLibraryResponse {
  models: OllamaLibraryModel[];
}

export interface OllamaReadyModel {
  modelName: string;
  runtime: OllamaRuntime;
  endpoint: string;
  available: boolean;
  supportsTools: boolean;
}

export interface OllamaReadyModelsResponse {
  models: OllamaReadyModel[];
}
