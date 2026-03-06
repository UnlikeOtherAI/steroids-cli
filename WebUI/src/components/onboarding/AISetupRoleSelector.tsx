import React from 'react';
import type { AIModel, AIProvider } from '../../services/api';

interface RoleConfig {
  provider: string;
  model: string;
}

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
  claude: 'STEROIDS_ANTHROPIC',
  gemini: 'STEROIDS_GOOGLE',
  codex: 'STEROIDS_OPENAI',
  mistral: 'STEROIDS_MISTRAL',
};

interface AISetupRoleSelectorProps {
  label: string;
  icon: string;
  config: RoleConfig;
  providers: AIProvider[];
  modelsByProvider: Record<string, AIModel[]>;
  modelSources: Record<string, string>;
  copiedCommand: string | null;
  refreshingProvider: string | null;
  isProjectLevel: boolean;
  isInherited: boolean;
  inheritedModel?: string;
  onProviderChange: (providerId: string) => void;
  onModelChange: (modelId: string) => void;
  onRefreshModels: (providerId: string) => void;
  onCopyToClipboard: (text: string, id: string) => void;
}

function getGroupedModels(models: AIModel[]): Array<{ label: string; items: AIModel[] }> {
  const grouped = new Map<string, AIModel[]>();

  for (const model of models) {
    const label = ((model as AIModel & { groupLabel?: string }).groupLabel)?.trim();
    if (!label) continue;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(model);
  }

  return [...grouped.entries()].map(([label, items]) => ({ label, items }));
}

export const AISetupRoleSelector: React.FC<AISetupRoleSelectorProps> = ({
  label,
  icon,
  config,
  providers,
  modelsByProvider,
  modelSources,
  copiedCommand,
  refreshingProvider,
  isProjectLevel,
  isInherited,
  inheritedModel,
  onProviderChange,
  onModelChange,
  onRefreshModels,
  onCopyToClipboard,
}) => {
  const selectedProvider = providers.find((p) => p.id === config.provider);
  const isNotInstalled = selectedProvider && !selectedProvider.installed;
  const needsApiKey = selectedProvider?.installed && modelSources[config.provider] === 'fallback';
  const installInfo = INSTALL_COMMANDS[config.provider];
  const envVar = API_KEY_ENV_VARS[config.provider];
  const providerModels = modelsByProvider[config.provider] || [];
  const groupedModels = getGroupedModels(providerModels);
  const showGroupedHFModels = config.provider === 'hf' && groupedModels.length > 0;

  return (
    <div className={`bg-bg-base rounded-lg p-4 border border-border ${isInherited ? 'opacity-75 relative' : ''}`}>
      <div className="flex items-center gap-2 mb-3">
        <i className={`fa-solid ${icon} text-accent`}></i>
        <span className="font-medium text-text-primary">{label}</span>
        {isInherited && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-info-soft text-info border border-info/30">
            Inherited
          </span>
        )}
        {isProjectLevel && !isInherited && config.provider && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-soft text-success border border-success/30">
            Project Override
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-text-secondary mb-1">Provider</label>
          <select
            value={config.provider}
            onChange={(e) => onProviderChange(e.target.value)}
            className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
          >
            {isInherited ? (
              <option value="">(Inherited)</option>
            ) : (
              <option value="">Select provider...</option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{!p.installed ? ' (not installed)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-text-secondary">
              Model
              {modelSources[config.provider] && (
                <span className="ml-1 text-text-secondary/60">
                  ({modelSources[config.provider] === 'cache' ? 'CLI' :
                    modelSources[config.provider] === 'api' ? 'API' :
                    modelSources[config.provider] === 'ready-models' ? 'Ready' : 'static'})
                </span>
              )}
            </label>
            {config.provider && !isNotInstalled && modelSources[config.provider] !== 'fallback' && (
              <button
                onClick={() => onRefreshModels(config.provider)}
                disabled={refreshingProvider === config.provider}
                className="p-1 text-text-muted hover:text-accent disabled:opacity-50 transition-colors"
                title="Refresh models"
              >
                <i className={`fa-solid fa-arrows-rotate ${refreshingProvider === config.provider ? 'animate-spin' : ''}`}></i>
              </button>
            )}
          </div>
          <select
            value={isInherited ? inheritedModel || '' : config.model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={isInherited}
            className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isInherited ? (
              <option value={inheritedModel || ''}>{inheritedModel || '(inherited from global)'}</option>
            ) : (
              <>
                <option value="">Select model...</option>
                {showGroupedHFModels
                  ? groupedModels.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.items.map((m) => (
                          <option key={`${group.label}:${m.id}`} value={m.id}>{m.name || m.id}</option>
                        ))}
                      </optgroup>
                    ))
                  : providerModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name || m.id}</option>
                    ))}
              </>
            )}
          </select>
        </div>
      </div>

      {isNotInstalled && installInfo && (
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg">
          <div className="flex items-start gap-2 text-warning text-sm mb-2">
            <i className="fa-solid fa-triangle-exclamation mt-0.5"></i>
            <span>{installInfo.description}</span>
          </div>
          <div className="relative">
            <code className="block bg-bg-surface text-text-primary text-xs p-2 pr-10 rounded font-mono overflow-x-auto">
              {installInfo.command}
            </code>
            <button
              onClick={() => onCopyToClipboard(installInfo.command, `${label}-install`)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
            >
              <i className={`fa-solid ${copiedCommand === `${label}-install` ? 'fa-check text-success' : 'fa-copy'}`}></i>
            </button>
          </div>
        </div>
      )}

      {needsApiKey && envVar && (
        <div className="p-3 bg-info/10 border border-info/30 rounded-lg">
          <div className="flex items-start gap-2 text-info text-sm mb-2">
            <i className="fa-solid fa-key mt-0.5"></i>
            <span>Set API key for dynamic models:</span>
          </div>
          <div className="relative">
            <code className="block bg-bg-surface text-text-primary text-xs p-2 pr-10 rounded font-mono overflow-x-auto">
              export {envVar}="your-api-key"
            </code>
            <button
              onClick={() => onCopyToClipboard(`export ${envVar}="your-api-key"`, `${label}-env`)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
            >
              <i className={`fa-solid ${copiedCommand === `${label}-env` ? 'fa-check text-success' : 'fa-copy'}`}></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
