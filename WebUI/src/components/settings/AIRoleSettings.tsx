/**
 * AI Role Settings Component
 * Handles provider and model selection with dynamic model loading
 */

import React, { useEffect, useState, useCallback } from 'react';
import { ArrowPathIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import { aiApi, AIModel, ConfigSchema } from '../../services/api';

interface AIRoleSettingsProps {
  role: 'orchestrator' | 'coder' | 'reviewer';
  schema: ConfigSchema;
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  basePath: string;
}

export const AIRoleSettings: React.FC<AIRoleSettingsProps> = ({
  role,
  schema,
  values,
  onChange,
  basePath,
}) => {
  const [models, setModels] = useState<AIModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSource, setModelSource] = useState<'api' | 'fallback' | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  // Get current values
  const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
    const keys = path.split('.');
    let current: unknown = obj;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };

  const currentProvider = (getNestedValue(values, `${basePath}.provider`) as string) || 'claude';
  const currentModel = (getNestedValue(values, `${basePath}.model`) as string) || '';
  const currentCli = (getNestedValue(values, `${basePath}.cli`) as string) || '';

  // Load models when provider changes
  const loadModels = useCallback(async (provider: string) => {
    setLoadingModels(true);
    setModelError(null);
    try {
      const response = await aiApi.getModels(provider);
      setModels(response.models);
      setModelSource(response.source);
      if (response.error) {
        setModelError(response.error);
      }
    } catch (err) {
      setModelError(err instanceof Error ? err.message : 'Failed to load models');
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadModels(currentProvider);
  }, [currentProvider, loadModels]);

  // Get provider options from schema
  const providerSchema = schema.properties?.provider;
  const providerOptions = providerSchema?.enum || ['claude', 'openai', 'gemini'];

  // Format display names
  const formatProviderName = (id: string): string => {
    switch (id) {
      case 'claude': return 'Claude (Anthropic)';
      case 'openai': return 'OpenAI';
      case 'gemini': return 'Gemini (Google)';
      case 'codex': return 'Codex';
      default: return id;
    }
  };

  const formatRoleName = (r: string): string => {
    return r.charAt(0).toUpperCase() + r.slice(1);
  };

  return (
    <div className="space-y-4">
      {/* Provider Selection */}
      <div>
        <label className="block text-sm font-medium text-text-primary mb-1">
          Provider
        </label>
        <select
          value={currentProvider}
          onChange={(e) => {
            onChange(`${basePath}.provider`, e.target.value);
            // Clear model when provider changes
            onChange(`${basePath}.model`, '');
          }}
          className="w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {providerOptions.map((provider) => (
            <option key={String(provider)} value={String(provider)}>
              {formatProviderName(String(provider))}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted mt-1">
          AI provider for {formatRoleName(role)} tasks
        </p>
      </div>

      {/* Model Selection */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-text-primary">
            Model
          </label>
          <div className="flex items-center gap-2">
            {loadingModels && (
              <ArrowPathIcon className="w-4 h-4 animate-spin text-text-muted" />
            )}
            {!loadingModels && modelSource === 'api' && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircleIcon className="w-3 h-3" />
                Live
              </span>
            )}
            {!loadingModels && modelSource === 'fallback' && (
              <span className="flex items-center gap-1 text-xs text-yellow-600">
                <ExclamationCircleIcon className="w-3 h-3" />
                Cached
              </span>
            )}
            <button
              type="button"
              onClick={() => loadModels(currentProvider)}
              disabled={loadingModels}
              className="text-xs text-accent hover:text-accent/80"
            >
              Refresh
            </button>
          </div>
        </div>
        <select
          value={currentModel}
          onChange={(e) => onChange(`${basePath}.model`, e.target.value)}
          disabled={loadingModels || models.length === 0}
          className="w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        >
          <option value="">Select a model...</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        {modelError && (
          <p className="text-xs text-yellow-600 mt-1">
            {modelError} - showing cached models
          </p>
        )}
        {!modelError && modelSource === 'api' && (
          <p className="text-xs text-text-muted mt-1">
            Models fetched from {formatProviderName(currentProvider)} API
          </p>
        )}
      </div>

      {/* CLI Path (optional) */}
      <div>
        <label className="block text-sm font-medium text-text-primary mb-1">
          CLI Path
          <span className="text-text-muted font-normal ml-1">(optional)</span>
        </label>
        <input
          type="text"
          value={currentCli}
          onChange={(e) => onChange(`${basePath}.cli`, e.target.value)}
          placeholder={`Default: ${currentProvider === 'claude' ? 'claude' : currentProvider === 'openai' ? 'codex' : currentProvider}`}
          className="w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <p className="text-xs text-text-muted mt-1">
          Custom path to the provider CLI executable
        </p>
      </div>
    </div>
  );
};
