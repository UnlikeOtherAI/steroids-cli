/**
 * AI Providers Module
 * Exports all provider-related types and implementations
 */

// Interface and base class
export {
  type InvokeOptions,
  type InvokeResult,
  type ProviderErrorType,
  type ProviderError,
  type ModelInfo,
  type IAIProvider,
  BaseAIProvider,
} from './interface.js';

// Claude provider
export { ClaudeProvider, createClaudeProvider } from './claude.js';

// Codex provider
export { CodexProvider, createCodexProvider } from './codex.js';

// Gemini provider
export { GeminiProvider, createGeminiProvider } from './gemini.js';

// OpenAI provider
export { OpenAIProvider, createOpenAIProvider } from './openai.js';

// Registry
export {
  type ProviderStatus,
  ProviderRegistry,
  createDefaultRegistry,
  getProviderRegistry,
  setProviderRegistry,
  resetProviderRegistry,
} from './registry.js';

// API model fetching
export {
  type APIModel,
  type FetchModelsResult,
  fetchClaudeModels,
  fetchOpenAIModels,
  fetchGeminiModels,
  fetchModelsForProvider,
  getApiKeyEnvVar,
  hasApiKey,
} from './api-models.js';

// Invocation logging
export {
  type InvocationLogEntry,
  type InvocationLoggerConfig,
  InvocationLogger,
  getInvocationLogger,
  setInvocationLogger,
  resetInvocationLogger,
  logInvocation,
} from './invocation-logger.js';
