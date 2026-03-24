/**
 * Canonical list of CLI-based provider identifiers.
 * This is the single source of truth — schema, API, and WebUI derive from it.
 *
 * Extracted to its own module to avoid circular imports between schema.ts and loader.ts.
 */
export const PROVIDER_NAMES = ['claude', 'gemini', 'codex', 'mistral', 'opencode', 'custom'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
