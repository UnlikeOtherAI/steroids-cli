/**
 * Provider Model Discovery
 * Fetches available models from providers (via CLI or API)
 */

import { getProviderRegistry, type ProviderStatus } from './registry.js';
import type { ModelInfo } from './interface.js';

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
  provider: 'claude' | 'openai' | 'gemini' | 'codex' | 'mistral'
): Promise<ProviderStatus> {
  const registry = getProviderRegistry();
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
export function getModelsForProvider(
  provider: 'claude' | 'openai' | 'gemini' | 'codex' | 'mistral'
): ProviderModel[] {
  const registry = getProviderRegistry();
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
export function getDefaultModel(
  provider: 'claude' | 'openai' | 'gemini' | 'codex' | 'mistral',
  role: 'orchestrator' | 'coder' | 'reviewer'
): string | undefined {
  const registry = getProviderRegistry();
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
 * Uses ANTHROPIC_API_KEY environment variable
 */
export async function fetchClaudeModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      models: [],
      error: 'ANTHROPIC_API_KEY not set',
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
 * Fetch models from OpenAI API
 * Uses OPENAI_API_KEY environment variable
 */
export async function fetchOpenAIModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      models: [],
      error: 'OPENAI_API_KEY not set',
    };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
        created?: number;
        owned_by?: string;
      }>;
    };

    // Filter to chat models (gpt-4, gpt-3.5, o1, etc.)
    const chatModels = data.data.filter(
      (m) =>
        m.id.startsWith('gpt-4') ||
        m.id.startsWith('gpt-3.5') ||
        m.id.startsWith('o1') ||
        m.id.startsWith('o3')
    );

    const models: APIModel[] = chatModels.map((m) => ({
      id: m.id,
      name: formatOpenAIModelName(m.id),
      created: m.created ? new Date(m.created * 1000) : undefined,
    }));

    // Sort by model family and version
    models.sort((a, b) => {
      const aScore = getOpenAIModelScore(a.id);
      const bScore = getOpenAIModelScore(b.id);
      if (aScore !== bScore) return aScore - bScore;
      return a.id.localeCompare(b.id);
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

function formatOpenAIModelName(id: string): string {
  if (id.startsWith('gpt-4o')) return `GPT-4o ${id.replace('gpt-4o', '').replace(/-/g, ' ').trim()}`.trim();
  if (id.startsWith('gpt-4-turbo')) return 'GPT-4 Turbo';
  if (id.startsWith('gpt-4')) return `GPT-4 ${id.replace('gpt-4', '').replace(/-/g, ' ').trim()}`.trim();
  if (id.startsWith('gpt-3.5-turbo')) return 'GPT-3.5 Turbo';
  if (id.startsWith('o1')) return `O1 ${id.replace('o1', '').replace(/-/g, ' ').trim()}`.trim();
  if (id.startsWith('o3')) return `O3 ${id.replace('o3', '').replace(/-/g, ' ').trim()}`.trim();
  return id;
}

function getOpenAIModelScore(id: string): number {
  if (id.startsWith('o3')) return 0;
  if (id.startsWith('o1')) return 1;
  if (id.startsWith('gpt-4o')) return 2;
  if (id.startsWith('gpt-4-turbo')) return 3;
  if (id.startsWith('gpt-4')) return 4;
  if (id.startsWith('gpt-3.5')) return 5;
  return 6;
}

/**
 * Fetch models from Google AI (Gemini) API
 * Uses GOOGLE_API_KEY or GEMINI_API_KEY environment variable
 */
export async function fetchGeminiModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      models: [],
      error: 'GOOGLE_API_KEY or GEMINI_API_KEY not set',
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
 * Uses MISTRAL_API_KEY environment variable
 */
export async function fetchMistralModels(): Promise<FetchModelsResult> {
  const apiKey = process.env.MISTRAL_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      models: [],
      error: 'MISTRAL_API_KEY not set',
    };
  }

  try {
    const response = await fetch('https://api.mistral.ai/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

    const data = (await response.json()) as
      | Array<{
        id: string;
        name?: string;
        description?: string;
        created?: number;
        max_context_length?: number;
      }>
      | {
        data?: Array<{
          id: string;
          name?: string;
          description?: string;
          created?: number;
          max_context_length?: number;
        }>;
      };

    const rawModels = Array.isArray(data) ? data : (data.data ?? []);

    const models: APIModel[] = rawModels.map((m) => ({
      id: m.id,
      name: m.name ?? formatMistralModelName(m.id),
      description: m.description,
      created: m.created ? new Date(m.created * 1000) : undefined,
      contextWindow: m.max_context_length,
    }));

    models.sort((a, b) => {
      const aScore = getMistralModelScore(a.id);
      const bScore = getMistralModelScore(b.id);
      if (aScore !== bScore) return aScore - bScore;
      return a.id.localeCompare(b.id);
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

function formatMistralModelName(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getMistralModelScore(id: string): number {
  if (id.includes('codestral')) return 0;
  if (id.includes('mistral-large')) return 1;
  if (id.includes('mistral-medium')) return 2;
  if (id.includes('mistral-small')) return 3;
  if (id.includes('ministral')) return 4;
  return 5;
}

/**
 * Fetch models for a specific provider
 */
export async function fetchModelsForProvider(
  provider: 'claude' | 'openai' | 'gemini' | 'mistral'
): Promise<FetchModelsResult> {
  switch (provider) {
    case 'claude':
      return fetchClaudeModels();
    case 'openai':
      return fetchOpenAIModels();
    case 'gemini':
      return fetchGeminiModels();
    case 'mistral':
      return fetchMistralModels();
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
export function getApiKeyEnvVar(provider: 'claude' | 'openai' | 'gemini' | 'mistral'): string {
  switch (provider) {
    case 'claude':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'gemini':
      return 'GOOGLE_API_KEY';
    case 'mistral':
      return 'MISTRAL_API_KEY';
  }
}

/**
 * Check if API key is set for a provider
 */
export function hasApiKey(provider: 'claude' | 'openai' | 'gemini' | 'mistral'): boolean {
  switch (provider) {
    case 'claude':
      return !!process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return !!process.env.OPENAI_API_KEY;
    case 'gemini':
      return !!(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
    case 'mistral':
      return !!process.env.MISTRAL_API_KEY;
  }
}
