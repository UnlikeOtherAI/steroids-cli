/**
 * AI Role Settings Component
 * Handles provider and model selection with dynamic model loading
 */

import React, { useEffect, useState, useCallback } from 'react';
import { ArrowPathIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import { aiApi, AIModel, AIProvider, ConfigSchema } from '../../services/api';

// Installation commands for each provider
const INSTALL_COMMANDS: Record<string, { command: string; description: string }> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    description: 'Install the Claude Code CLI to use Anthropic models.',
  },
  gemini: {
    command: 'npm install -g @google/gemini-cli',
    description: 'Install the Gemini CLI to use Google AI models.',
  },
  codex: {
    command: 'npm install -g @openai/codex',
    description: 'Install the Codex CLI to use OpenAI models.',
  },
};

// API key environment variable names
const API_KEY_ENV_VARS: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  codex: 'OPENAI_API_KEY',
};

interface AIRoleSettingsProps {
  role: 'orchestrator' | 'coder' | 'reviewer';
  schema: ConfigSchema;
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  basePath: string;
  scope?: 'global' | 'project';
  globalValues?: Record<string, unknown>;
}

export const AIRoleSettings: React.FC<AIRoleSettingsProps> = ({
  role,
  schema,
  values,
  onChange,
  basePath,
  scope = 'global',
  globalValues,
}) => {
  const [models, setModels] = useState<AIModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSource, setModelSource] = useState<'api' | 'cache' | 'fallback' | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  // Load providers on mount
  useEffect(() => {
    aiApi.getProviders().then(setProviders).catch(() => {});
  }, []);

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

  const currentProvider = (getNestedValue(values, `${basePath}.provider`) as string) || '';
  const currentModel = (getNestedValue(values, `${basePath}.model`) as string) || '';
  const currentCli = (getNestedValue(values, `${basePath}.cli`) as string) || '';

  // Get global/inherited values for project scope
  const globalProvider = globalValues ? (getNestedValue(globalValues, `${basePath}.provider`) as string) || '' : '';
  const globalModel = globalValues ? (getNestedValue(globalValues, `${basePath}.model`) as string) || '' : '';

  // Check if using inherited (no value set at project level)
  const isInherited = scope === 'project' && !currentProvider;

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

  // Load models for active provider (current or inherited)
  const activeProvider = isInherited ? globalProvider : currentProvider;

  useEffect(() => {
    if (activeProvider) {
      loadModels(activeProvider);
    }
  }, [activeProvider, loadModels]);

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

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  // Check if current provider is installed
  const currentProviderInfo = providers.find(p => p.id === currentProvider);
  const isNotInstalled = currentProviderInfo && !currentProviderInfo.installed;
  const needsApiKey = currentProviderInfo?.installed && modelSource === 'fallback';
  const installInfo = INSTALL_COMMANDS[currentProvider];
  const envVar = API_KEY_ENV_VARS[currentProvider];

  return (
    <div className="space-y-4">
      {/* Inherited/Custom Toggle for Project Scope */}
      {scope === 'project' && (
        <div className="flex items-center gap-3 pb-3 border-b border-border">
          <label className="text-sm font-medium text-text-primary">Mode:</label>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => {
                // Switch to inherited - clear project values
                onChange(`${basePath}.provider`, '');
                onChange(`${basePath}.model`, '');
              }}
              className={`px-3 py-1.5 text-sm transition-colors ${
                isInherited
                  ? 'bg-accent text-white'
                  : 'bg-bg-surface text-text-secondary hover:bg-bg-surface2'
              }`}
            >
              Inherited
            </button>
            <button
              type="button"
              onClick={() => {
                // Switch to custom - copy global values as starting point
                if (isInherited && globalProvider) {
                  onChange(`${basePath}.provider`, globalProvider);
                  onChange(`${basePath}.model`, globalModel);
                }
              }}
              className={`px-3 py-1.5 text-sm transition-colors ${
                !isInherited
                  ? 'bg-accent text-white'
                  : 'bg-bg-surface text-text-secondary hover:bg-bg-surface2'
              }`}
            >
              Custom
            </button>
          </div>
          {isInherited && globalProvider && (
            <span className="text-xs text-text-secondary">
              Using global: {formatProviderName(globalProvider)} / {globalModel}
            </span>
          )}
        </div>
      )}

      {/* Provider Selection */}
      <div>
        <label className="block text-sm font-medium text-text-primary mb-1">
          Provider
        </label>
        <select
          value={isInherited ? globalProvider : currentProvider}
          onChange={(e) => {
            onChange(`${basePath}.provider`, e.target.value);
            // Clear model when provider changes
            onChange(`${basePath}.model`, '');
          }}
          disabled={isInherited}
          className={`w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${
            isInherited ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        >
          <option value="">Select provider...</option>
          {providerOptions.map((provider) => {
            const providerInfo = providers.find(p => p.id === provider);
            return (
              <option key={String(provider)} value={String(provider)}>
                {formatProviderName(String(provider))}{providerInfo && !providerInfo.installed ? ' (not installed)' : ''}
              </option>
            );
          })}
        </select>
        <p className="text-xs text-text-muted mt-1">
          AI provider for {formatRoleName(role)} tasks
        </p>
      </div>

      {/* Not Installed Warning */}
      {isNotInstalled && installInfo && (
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg">
          <div className="flex items-start gap-2 text-warning text-sm mb-2">
            <ExclamationCircleIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{installInfo.description}</span>
          </div>
          <div className="relative">
            <code className="block bg-bg-surface text-text-primary text-xs p-2 pr-10 rounded font-mono overflow-x-auto">
              {installInfo.command}
            </code>
            <button
              onClick={() => copyToClipboard(installInfo.command, `${role}-install`)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
              title="Copy to clipboard"
            >
              {copiedCommand === `${role}-install` ? (
                <CheckCircleIcon className="w-4 h-4 text-green-500" />
              ) : (
                <span className="text-xs">Copy</span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Needs API Key Warning */}
      {needsApiKey && envVar && (
        <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <div className="flex items-start gap-2 text-blue-400 text-sm mb-2">
            <ExclamationCircleIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>Set your API key to load models dynamically:</span>
          </div>
          <div className="relative">
            <code className="block bg-bg-surface text-text-primary text-xs p-2 pr-10 rounded font-mono overflow-x-auto">
              export {envVar}="your-api-key-here"
            </code>
            <button
              onClick={() => copyToClipboard(`export ${envVar}="your-api-key-here"`, `${role}-env`)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
              title="Copy to clipboard"
            >
              {copiedCommand === `${role}-env` ? (
                <CheckCircleIcon className="w-4 h-4 text-green-500" />
              ) : (
                <span className="text-xs">Copy</span>
              )}
            </button>
          </div>
          <p className="text-xs text-text-secondary mt-2">
            Add this to your shell profile (~/.zshrc or ~/.bashrc), then restart the API.
          </p>
        </div>
      )}

      {/* Model Selection - only show if provider is installed */}
      {(!currentProviderInfo || currentProviderInfo.installed) && (
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
              {!loadingModels && modelSource === 'cache' && (
                <span className="flex items-center gap-1 text-xs text-green-600">
                  <CheckCircleIcon className="w-3 h-3" />
                  From CLI
                </span>
              )}
              {!loadingModels && modelSource === 'fallback' && (
                <span className="flex items-center gap-1 text-xs text-yellow-600">
                  <ExclamationCircleIcon className="w-3 h-3" />
                  Static
                </span>
              )}
              {!isInherited && (
                <button
                  type="button"
                  onClick={() => loadModels(activeProvider)}
                  disabled={loadingModels}
                  className="text-xs text-accent hover:text-accent/80"
                >
                  Refresh
                </button>
              )}
            </div>
          </div>
          <select
            value={isInherited ? globalModel : currentModel}
            onChange={(e) => onChange(`${basePath}.model`, e.target.value)}
            disabled={isInherited || loadingModels || models.length === 0}
            className={`w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 ${
              isInherited ? 'cursor-not-allowed' : ''
            }`}
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
          {!modelError && modelSource === 'cache' && (
            <p className="text-xs text-text-muted mt-1">
              Models loaded from CLI cache
            </p>
          )}
        </div>
      )}

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
