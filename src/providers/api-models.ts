/**
 * API Model Fetching
 * Fetches available models from provider APIs
 */

export interface APIModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  created?: Date;
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
 * Fetch models for a specific provider
 */
export async function fetchModelsForProvider(
  provider: 'claude' | 'openai' | 'gemini'
): Promise<FetchModelsResult> {
  switch (provider) {
    case 'claude':
      return fetchClaudeModels();
    case 'openai':
      return fetchOpenAIModels();
    case 'gemini':
      return fetchGeminiModels();
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
export function getApiKeyEnvVar(provider: 'claude' | 'openai' | 'gemini'): string {
  switch (provider) {
    case 'claude':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'gemini':
      return 'GOOGLE_API_KEY';
  }
}

/**
 * Check if API key is set for a provider
 */
export function hasApiKey(provider: 'claude' | 'openai' | 'gemini'): boolean {
  switch (provider) {
    case 'claude':
      return !!process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return !!process.env.OPENAI_API_KEY;
    case 'gemini':
      return !!(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
  }
}
