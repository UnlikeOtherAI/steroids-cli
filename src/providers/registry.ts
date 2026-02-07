/**
 * Provider Registry
 * Manages registration and discovery of AI providers
 */

import type { IAIProvider } from './interface.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';

/**
 * Provider availability status
 */
export interface ProviderStatus {
  /** Provider name */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Whether the provider is available */
  available: boolean;
  /** Path to CLI if available */
  cliPath?: string;
  /** Available models */
  models: string[];
}

/**
 * Provider Registry
 * Central registry for all AI providers
 */
export class ProviderRegistry {
  private providers: Map<string, IAIProvider> = new Map();

  /**
   * Register a provider
   */
  register(provider: IAIProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider '${provider.name}' is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  /**
   * Unregister a provider
   */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /**
   * Get a provider by name
   * @throws Error if provider not found
   */
  get(name: string): IAIProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const available = Array.from(this.providers.keys()).join(', ');
      throw new Error(
        `Provider '${name}' not found. Available providers: ${available || 'none'}`
      );
    }
    return provider;
  }

  /**
   * Try to get a provider by name
   * Returns undefined if not found
   */
  tryGet(name: string): IAIProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Check if a provider is registered
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get all registered provider names
   */
  getNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get all registered providers
   */
  getAll(): IAIProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get status of all providers
   * Checks availability of each provider
   */
  async getStatus(): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = [];

    for (const provider of this.providers.values()) {
      const available = await provider.isAvailable();
      statuses.push({
        name: provider.name,
        displayName: provider.displayName,
        available,
        cliPath: provider.getCliPath(),
        models: provider.listModels(),
      });
    }

    return statuses;
  }

  /**
   * Get only available providers
   */
  async getAvailable(): Promise<IAIProvider[]> {
    const available: IAIProvider[] = [];

    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        available.push(provider);
      }
    }

    return available;
  }

  /**
   * Detect and return status of all providers
   * Useful for setup wizards
   */
  async detect(): Promise<ProviderStatus[]> {
    return this.getStatus();
  }

  /**
   * Validate that a provider and model combination is valid
   */
  validateProviderModel(providerName: string, model: string): void {
    const provider = this.get(providerName);
    const models = provider.listModels();

    if (!models.includes(model)) {
      throw new Error(
        `Model '${model}' not available for provider '${providerName}'. ` +
        `Available models: ${models.join(', ')}`
      );
    }
  }

  /**
   * Get the default provider for a role
   * Returns the first available provider that has a default model for the role
   */
  async getDefaultProvider(
    role: 'orchestrator' | 'coder' | 'reviewer'
  ): Promise<IAIProvider | undefined> {
    const available = await this.getAvailable();

    for (const provider of available) {
      const defaultModel = provider.getDefaultModel(role);
      if (defaultModel) {
        return provider;
      }
    }

    return available[0]; // Fall back to first available
  }
}

/**
 * Create a registry with default providers registered
 */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Register built-in providers
  registry.register(new ClaudeProvider());
  registry.register(new CodexProvider());
  registry.register(new GeminiProvider());
  registry.register(new OpenAIProvider());

  return registry;
}

/**
 * Global singleton registry instance
 */
let globalRegistry: ProviderRegistry | null = null;

/**
 * Get the global provider registry
 * Creates a default registry if none exists
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!globalRegistry) {
    globalRegistry = createDefaultRegistry();
  }
  return globalRegistry;
}

/**
 * Set the global provider registry
 * Useful for testing
 */
export function setProviderRegistry(registry: ProviderRegistry): void {
  globalRegistry = registry;
}

/**
 * Reset the global provider registry
 * Useful for testing
 */
export function resetProviderRegistry(): void {
  globalRegistry = null;
}
