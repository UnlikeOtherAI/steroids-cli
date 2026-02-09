import React, { useEffect, useState } from 'react';
import { aiApi, configApi, AIProvider, AIModel } from '../../services/api';

interface AISetupModalProps {
  onComplete: () => void;
  onClose?: () => void;
}

interface RoleConfig {
  provider: string;
  model: string;
}

// Installation commands for each provider
const INSTALL_COMMANDS: Record<string, { command: string; description: string }> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    description: 'Install the Claude Code CLI to use Anthropic models.',
  },
  gemini: {
    command: 'npm install -g @anthropic-ai/gemini-cli',
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

export const AISetupModal: React.FC<AISetupModalProps> = ({ onComplete, onClose }) => {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<Record<string, AIModel[]>>({});
  const [modelSources, setModelSources] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  // Role configurations
  const [orchestrator, setOrchestrator] = useState<RoleConfig>({ provider: '', model: '' });
  const [coder, setCoder] = useState<RoleConfig>({ provider: '', model: '' });
  const [reviewer, setReviewer] = useState<RoleConfig>({ provider: '', model: '' });

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      setLoading(true);
      const providerList = await aiApi.getProviders();
      setProviders(providerList);

      // Load models for installed providers
      const modelsMap: Record<string, AIModel[]> = {};
      const sourcesMap: Record<string, string> = {};
      for (const provider of providerList) {
        if (provider.installed) {
          try {
            const response = await aiApi.getModels(provider.id);
            modelsMap[provider.id] = response.models;
            sourcesMap[provider.id] = response.source;
          } catch {
            modelsMap[provider.id] = [];
            sourcesMap[provider.id] = 'fallback';
          }
        }
      }
      setModels(modelsMap);
      setModelSources(sourcesMap);
    } catch (err) {
      setError('Failed to load AI providers');
    } finally {
      setLoading(false);
    }
  };

  const handleProviderChange = async (role: 'orchestrator' | 'coder' | 'reviewer', providerId: string) => {
    const setter = role === 'orchestrator' ? setOrchestrator : role === 'coder' ? setCoder : setReviewer;
    setter({ provider: providerId, model: '' });

    // Load models if not already loaded
    if (providerId && !models[providerId]) {
      try {
        const response = await aiApi.getModels(providerId);
        setModels(prev => ({ ...prev, [providerId]: response.models }));
        setModelSources(prev => ({ ...prev, [providerId]: response.source }));
      } catch {
        setModels(prev => ({ ...prev, [providerId]: [] }));
        setModelSources(prev => ({ ...prev, [providerId]: 'fallback' }));
      }
    }
  };

  const handleSave = async () => {
    if (!orchestrator.provider || !orchestrator.model ||
        !coder.provider || !coder.model ||
        !reviewer.provider || !reviewer.model) {
      setError('Please configure all three roles');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await configApi.setConfig({
        'ai.orchestrator.provider': orchestrator.provider,
        'ai.orchestrator.model': orchestrator.model,
        'ai.coder.provider': coder.provider,
        'ai.coder.model': coder.model,
        'ai.reviewer.provider': reviewer.provider,
        'ai.reviewer.model': reviewer.model,
      }, 'global');

      onComplete();
    } catch (err) {
      setError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  const getProviderById = (id: string) => providers.find(p => p.id === id);

  // Check if all fields are complete for validation
  const isFormComplete =
    orchestrator.provider && orchestrator.model &&
    coder.provider && coder.model &&
    reviewer.provider && reviewer.model;

  const renderRoleSelector = (
    label: string,
    icon: string,
    config: RoleConfig,
    setConfig: (role: 'orchestrator' | 'coder' | 'reviewer', provider: string) => void,
    setModel: React.Dispatch<React.SetStateAction<RoleConfig>>,
    role: 'orchestrator' | 'coder' | 'reviewer'
  ) => {
    const selectedProvider = getProviderById(config.provider);
    const isNotInstalled = selectedProvider && !selectedProvider.installed;
    const needsApiKey = selectedProvider?.installed && modelSources[config.provider] === 'fallback';
    const installInfo = INSTALL_COMMANDS[config.provider];
    const envVar = API_KEY_ENV_VARS[config.provider];

    return (
      <div className="bg-bg-base rounded-lg p-4 border border-border">
        <div className="flex items-center gap-2 mb-3">
          <i className={`fa-solid ${icon} text-accent`}></i>
          <span className="font-medium text-text-primary">{label}</span>
        </div>

        {/* Provider and Model Selection - always visible side by side */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Provider</label>
            <select
              value={config.provider}
              onChange={(e) => setConfig(role, e.target.value)}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
            >
              <option value="">Select provider...</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{!p.installed ? ' (not installed)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              Model
              {modelSources[config.provider] && (
                <span className="ml-1 text-text-secondary/60">
                  ({modelSources[config.provider] === 'cache' ? 'CLI' :
                    modelSources[config.provider] === 'api' ? 'API' : 'static'})
                </span>
              )}
            </label>
            <select
              value={config.model}
              onChange={(e) => setModel(prev => ({ ...prev, model: e.target.value }))}
              disabled={!config.provider || isNotInstalled}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="">Select model...</option>
              {(models[config.provider] || []).map(m => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Not Installed Warning - shown below provider/model */}
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
                onClick={() => copyToClipboard(installInfo.command, `${role}-install`)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
                title="Copy to clipboard"
              >
                <i className={`fa-solid ${copiedCommand === `${role}-install` ? 'fa-check text-success' : 'fa-copy'}`}></i>
              </button>
            </div>
          </div>
        )}

        {/* Needs API Key Warning - shown below provider/model */}
        {needsApiKey && envVar && (
          <div className="p-3 bg-info/10 border border-info/30 rounded-lg">
            <div className="flex items-start gap-2 text-info text-sm mb-2">
              <i className="fa-solid fa-key mt-0.5"></i>
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
                <i className={`fa-solid ${copiedCommand === `${role}-env` ? 'fa-check text-success' : 'fa-copy'}`}></i>
              </button>
            </div>
            <p className="text-xs text-text-secondary mt-2">
              Add this to your shell profile (~/.zshrc or ~/.bashrc), then restart the API.
            </p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop with slight blur */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />

      {/* Modal */}
      <div className="relative bg-bg-shell rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-start justify-between">
            <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
              <i className="fa-solid fa-robot text-accent"></i>
              AI Configuration Required
            </h2>
            {onClose && (
              <button
                onClick={onClose}
                className="p-1 rounded-lg hover:bg-bg-surface2 text-text-muted hover:text-text-primary transition-colors"
                title="Close"
              >
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-1">
            Configure the AI models for each role before using Steroids
          </p>
        </div>

        {/* Content */}
        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-8">
              <i className="fa-solid fa-spinner fa-spin text-2xl text-accent mb-3"></i>
              <p className="text-text-muted">Discovering available providers...</p>
            </div>
          ) : (
            <>
              {/* Setup info message */}
              <div className="mb-4 p-3 bg-bg-base border border-border rounded-lg">
                <p className="text-sm text-text-primary">
                  <i className="fa-solid fa-circle-info text-accent mr-2"></i>
                  Select AI providers that are already installed and configured on your system.
                  Steroids will use them with your existing credentials, just like you would from the command line.
                </p>
              </div>

              <div className="space-y-4">
                {renderRoleSelector('Orchestrator', 'fa-sitemap', orchestrator, handleProviderChange, setOrchestrator, 'orchestrator')}
                {renderRoleSelector('Coder', 'fa-code', coder, handleProviderChange, setCoder, 'coder')}
                {renderRoleSelector('Reviewer', 'fa-magnifying-glass', reviewer, handleProviderChange, setReviewer, 'reviewer')}
              </div>

              {error && (
                <div className="mt-4 p-3 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                  <i className="fa-solid fa-exclamation-circle mr-2"></i>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border bg-bg-base">
          <button
            onClick={handleSave}
            disabled={saving || !isFormComplete}
            className="w-full px-4 py-3 bg-accent hover:bg-accent/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <i className="fa-solid fa-spinner fa-spin"></i>
                Saving...
              </>
            ) : (
              <>
                <i className="fa-solid fa-check"></i>
                Save & Continue
              </>
            )}
          </button>
          {!isFormComplete && (
            <p className="text-xs text-text-secondary text-center mt-2">
              Please select a provider and model for all three roles
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
