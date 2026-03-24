/**
 * Provider Model Discovery
 * Fetches available models from providers (via CLI or API)
 */

import { getProviderRegistry, type ProviderStatus } from './registry.js';
import type { ModelInfo } from './interface.js';
import type { ProviderName } from '../config/loader.js';

export interface APIModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  created?: Date;
}

export interface ProviderModel {
  id: string;
  name: string;
  recommendedFor?: ('orchestrator' | 'coder' | 'reviewer')[];
  supportsStreaming?: boolean;
}

/**
 * Check if provider CLI is available
 * Uses the provider registry to verify CLI availability
 */
export async function checkProviderCLI(
  provider: ProviderName
): Promise<ProviderStatus> {
  const registry = await getProviderRegistry();
  const providerInstance = registry.tryGet(provider);

  if (!providerInstance) {
    return {
      name: provider,
      displayName: provider,
      available: false,
      models: [],
    };
  }

  const available = await providerInstance.isAvailable();
  return {
    name: providerInstance.name,
    displayName: providerInstance.displayName,
    available,
    cliPath: providerInstance.getCliPath(),
    models: providerInstance.listModels(),
  };
}

/**
 * Get models for a provider from the registry (CLI-based)
 * Does not require API keys - uses hardcoded model lists from provider implementations
 */
export async function getModelsForProvider(
  provider: ProviderName
): Promise<ProviderModel[]> {
  const registry = await getProviderRegistry();
  const providerInstance = registry.tryGet(provider);

  if (!providerInstance) {
    return [];
  }

  const modelInfo = providerInstance.getModelInfo();
  return modelInfo.map((m: ModelInfo) => ({
    id: m.id,
    name: m.name,
    recommendedFor: m.recommendedFor,
    supportsStreaming: m.supportsStreaming,
  }));
}

/**
 * Get the default model for a provider and role
 */
export async function getDefaultModel(
  provider: ProviderName,
  role: 'orchestrator' | 'coder' | 'reviewer'
): Promise<string | undefined> {
  const registry = await getProviderRegistry();
  const providerInstance = registry.tryGet(provider);
  return providerInstance?.getDefaultModel(role);
}

export interface FetchModelsResult {
  success: boolean;
  models: APIModel[];
  error?: string;
}

/**
 * Fetch models from Anthropic API
 * Uses STEROIDS_ANTHROPIC environment variable
 */
export async function fetchClaudeModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.STEROIDS_ANTHROPIC;

  if (!apiKey) {
    return {
      success: false,
      models: [],
      error: 'STEROIDS_ANTHROPIC not set',
    };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        models: [],
        error: `API error: ${response.status} - ${text}`,
      };
    }

    const data = (await response.json()) as {
      data: Array<{
        id: string;
        display_name?: string;
        created_at?: string;
      }>;
    };

    const models: APIModel[] = data.data.map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      created: m.created_at ? new Date(m.created_at) : undefined,
    }));

    // Sort by name, putting claude-3.5 and claude-4 first
    models.sort((a, b) => {
      const aScore = a.id.includes('claude-4') ? 0 : a.id.includes('claude-3-5') ? 1 : 2;
      const bScore = b.id.includes('claude-4') ? 0 : b.id.includes('claude-3-5') ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return a.name.localeCompare(b.name);
    });

    return { success: true, models };
  } catch (error) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Fetch models from Google AI (Gemini) API
 * Uses STEROIDS_GOOGLE environment variable
 */
export async function fetchGeminiModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.STEROIDS_GOOGLE;

  if (!apiKey) {
    return {
      success: false,
      models: [],
      error: 'STEROIDS_GOOGLE not set',
    };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        models: [],
        error: `API error: ${response.status} - ${text}`,
      };
    }

    const data = (await response.json()) as {
      models: Array<{
        name: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };

    // Filter to generative models that support generateContent
    const generativeModels = data.models.filter(
      (m) =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        m.name.includes('gemini')
    );

    const models: APIModel[] = generativeModels.map((m) => {
      // Extract model ID from full name (models/gemini-pro -> gemini-pro)
      const id = m.name.replace('models/', '');
      return {
        id,
        name: m.displayName ?? id,
        description: m.description,
        contextWindow: m.inputTokenLimit,
      };
    });

    // Sort by model tier
    models.sort((a, b) => {
      const aScore = getGeminiModelScore(a.id);
      const bScore = getGeminiModelScore(b.id);
      if (aScore !== bScore) return aScore - bScore;
      return a.name.localeCompare(b.name);
    });

    return { success: true, models };
  } catch (error) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function getGeminiModelScore(id: string): number {
  if (id.includes('ultra')) return 0;
  if (id.includes('pro')) return 1;
  if (id.includes('flash')) return 2;
  return 3;
}

/**
 * Fetch models from Mistral API
 *
 * Uses the provider's already-fetched model list (populated by initialize()
 * from the Mistral API using STEROIDS_MISTRAL or MISTRAL_API_KEY).
 * This ensures the setup wizard shows the same filtered, deduplicated list
 * as `steroids ai providers`.
 */
export async function fetchMistralModels(): Promise<FetchModelsResult> {
  const models = (await getModelsForProvider('mistral')).map((m) => ({
    id: m.id,
    name: m.name,
  }));

  return { success: true, models };
}


/**
 * Fetch models for a specific provider
 */
export async function fetchModelsForProvider(
  provider: ProviderName
): Promise<FetchModelsResult> {
  switch (provider) {
    case 'claude':
      return fetchClaudeModels();
    case 'gemini':
      return fetchGeminiModels();
    case 'mistral':
      return fetchMistralModels();
    case 'codex':
      return {
        success: true,
        models: (await getModelsForProvider('codex')).map(m => ({
          id: m.id,
          name: m.name,
        })),
      };
    case 'opencode':
      return { success: true, models: [] }; // Models come from paired tables, not provider
    default:
      return {
        success: false,
        models: [],
        error: `Unknown provider: ${provider}`,
      };
  }
}

/**
 * Get the environment variable name for a provider's API key
 */
export function getApiKeyEnvVar(provider: ProviderName): string {
  switch (provider) {
    case 'claude':
      return 'STEROIDS_ANTHROPIC';
    case 'gemini':
      return 'STEROIDS_GOOGLE';
    case 'mistral':
      return 'STEROIDS_MISTRAL';
    case 'codex':
      return 'STEROIDS_OPENAI';
    case 'opencode':
      return ''; // No API key needed
  }
}

/**
 * Check if API key is set for a provider
 */
export function hasApiKey(provider: ProviderName): boolean {
  if (provider === 'codex') return true;
  if (provider === 'opencode') return true; // Uses own auth via opencode.json
  if (provider === 'mistral') return true; // Vibe CLI can operate with local auth and does not require API key
  switch (provider) {
    case 'claude':
      return !!process.env.STEROIDS_ANTHROPIC;
    case 'gemini':
      return !!process.env.STEROIDS_GOOGLE;
    default:
      return false;
  }
}
