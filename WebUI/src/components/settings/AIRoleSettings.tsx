/**
 * AI Role Settings Component
 * Handles provider and model selection with dynamic model loading
 * Supports multi-reviewer management
 */

import React, { useEffect, useState, useCallback } from 'react';
import { 
  ArrowPathIcon, 
  CheckCircleIcon, 
  ExclamationCircleIcon,
  TrashIcon,
  PlusIcon
} from '@heroicons/react/24/outline';
import { aiApi, AIModel, AIProvider, ConfigSchema } from '../../services/api';

// Installation commands for each provider
const INSTALL_COMMANDS: Record<string, { command: string; description: string }> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    description: 'Install the Claude CLI to use Anthropic models.',
  },
  gemini: {
    command: 'npm install -g @google/gemini-cli',
    description: 'Install the Gemini CLI to use Google models.',
  },
  codex: {
    command: 'npm install -g @openai/codex',
    description: 'Install the Codex CLI to use OpenAI models.',
  },
  mistral: {
    command: 'uv tool install mistral-vibe',
    description: 'Install the Vibe CLI to use Mistral models.',
  },
};

// API key environment variable names
const API_KEY_ENV_VARS: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  codex: 'OPENAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

interface AIRoleSettingsProps {
  role: 'orchestrator' | 'coder' | 'reviewer' | 'reviewers';
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
  const [providers, setProviders] = useState<AIProvider[]>([]);

  // Load providers on mount
  useEffect(() => {
    aiApi.getProviders().then(setProviders).catch(() => {});
  }, []);

  const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
    const keys = path.split('.');
    let current: unknown = obj;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };

  // If role is 'reviewers' (plural), render the multi-reviewer manager
  if (role === 'reviewers') {
    const reviewers = (getNestedValue(values, basePath) as any[]) || [];
    const globalReviewers = globalValues ? (getNestedValue(globalValues, basePath) as any[]) || [] : [];
    const isInherited = scope === 'project' && reviewers.length === 0;
    const activeReviewers = isInherited ? globalReviewers : reviewers;

    return (
      <div className="space-y-4">
        {scope === 'project' && (
          <div className="flex items-center gap-3 pb-3 border-b border-border">
            <label className="text-sm font-medium text-text-primary">Mode:</label>
            <div className="flex rounded-lg border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => onChange(basePath, [])}
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
                  if (isInherited && globalReviewers.length > 0) {
                    onChange(basePath, JSON.parse(JSON.stringify(globalReviewers)));
                  } else if (isInherited) {
                    onChange(basePath, [{ provider: 'claude', model: 'claude-sonnet-4' }]);
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
          </div>
        )}

        <div className="space-y-3">
          {activeReviewers.map((r, index) => (
            <div key={index} className="border border-border rounded-lg p-3 bg-bg-surface2">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold text-text-muted uppercase tracking-wider">
                  Reviewer {index + 1} {index === 0 ? '(Primary for style)' : ''}
                </span>
                {!isInherited && activeReviewers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...reviewers];
                      next.splice(index, 1);
                      onChange(basePath, next);
                    }}
                    className="text-text-muted hover:text-red-500 transition-colors"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
              <AIRoleSettingsSingle
                role="reviewer"
                schema={schema.items || { type: 'object' }}
                values={values}
                onChange={(path, val) => {
                  if (isInherited) return;
                  const next = JSON.parse(JSON.stringify(reviewers));
                  const subPath = path.replace(`${basePath}.${index}.`, '');
                  const keys = subPath.split('.');
                  let current: any = next[index];
                  for (let i = 0; i < keys.length - 1; i++) {
                    if (!current[keys[i]]) current[keys[i]] = {};
                    current = current[keys[i]];
                  }
                  current[keys[keys.length - 1]] = val;
                  onChange(basePath, next);
                }}
                basePath={`${basePath}.${index}`}
                scope="global"
                providers={providers}
              />
            </div>
          ))}
          
          {!isInherited && (
            <button
              type="button"
              onClick={() => {
                const next = [...reviewers, { provider: 'claude', model: 'claude-sonnet-4' }];
                onChange(basePath, next);
              }}
              className="w-full py-2 border-2 border-dashed border-border rounded-lg text-text-muted hover:text-accent hover:border-accent transition-all flex items-center justify-center gap-2 text-sm font-medium"
            >
              <PlusIcon className="w-4 h-4" />
              Add Reviewer
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <AIRoleSettingsSingle
      role={role as any}
      schema={schema}
      values={values}
      onChange={onChange}
      basePath={basePath}
      scope={scope}
      globalValues={globalValues}
      providers={providers}
    />
  );
};

interface AIRoleSettingsSingleProps extends AIRoleSettingsProps {
  providers: AIProvider[];
}

const AIRoleSettingsSingle: React.FC<AIRoleSettingsSingleProps> = ({
  role,
  schema,
  values,
  onChange,
  basePath,
  scope = 'global',
  globalValues,
  providers,
}) => {
  const [models, setModels] = useState<AIModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSource, setModelSource] = useState<'api' | 'cache' | 'fallback' | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

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

  // Format display names
  const formatProviderName = (id: string): string => {
    switch (id) {
      case 'claude': return 'Anthropic (claude)';
      case 'openai': return 'OpenAI API';
      case 'gemini': return 'Google (gemini)';
      case 'codex': return 'OpenAI (codex)';
      case 'mistral': return 'Mistral (vibe)';
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

  const providerOptions = schema.properties?.provider?.enum || ['claude', 'openai', 'gemini', 'mistral', 'codex'];

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
            onChange(`${basePath}.model`, '');
          }}
          disabled={isInherited}
          className={`w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent ${
            isInherited ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        >
          <option value="">Select provider...</option>
          {providerOptions.map((provider) => {
            const providerInfo = providers.find(p => p.id === String(provider));
            return (
              <option key={String(provider)} value={String(provider)}>
                {formatProviderName(String(provider))}{providerInfo && !providerInfo.installed ? ' (not installed)' : ''}
              </option>
            );
          })}
        </select>
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
              onClick={() => copyToClipboard(installInfo.command, `${basePath}-install`)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
            >
              {copiedCommand === `${basePath}-install` ? (
                <CheckCircleIcon className="w-4 h-4 text-green-500" />
              ) : (
                <span className="text-xs">Copy</span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Model Selection */}
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
        </div>
      )}

      {/* CLI Path (optional) */}
      {!role.endsWith('s') && (
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            CLI Path
            <span className="text-text-muted font-normal ml-1">(optional)</span>
          </label>
          <input
            type="text"
            value={currentCli}
            onChange={(e) => onChange(`${basePath}.cli`, e.target.value)}
            placeholder={`Default: ${currentProvider}`}
            className="w-full px-3 py-2 bg-bg-surface2 border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      )}
    </div>
  );
};
