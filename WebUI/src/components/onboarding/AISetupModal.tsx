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
  const [reviewers, setReviewers] = useState<RoleConfig[]>([]);
  const [useMultiReview, setUseMultiReview] = useState(false);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      setLoading(true);
      const [providerList, globalConfig] = await Promise.all([
        aiApi.getProviders(),
        configApi.getConfig('global'),
      ]);
      setProviders(providerList);

      // Pre-fill from existing config
      const ai = globalConfig.ai as any;
      if (ai) {
        if (ai.orchestrator?.provider) setOrchestrator({ provider: ai.orchestrator.provider, model: ai.orchestrator.model || '' });
        if (ai.coder?.provider) setCoder({ provider: ai.coder.provider, model: ai.coder.model || '' });
        
        if (ai.reviewers && Array.isArray(ai.reviewers) && ai.reviewers.length > 0) {
          setUseMultiReview(true);
          setReviewers(ai.reviewers.map((r: any) => ({ provider: r.provider || '', model: r.model || '' })));
          setReviewer({ provider: ai.reviewers[0].provider || '', model: ai.reviewers[0].model || '' });
        } else if (ai.reviewer?.provider) {
          setReviewer({ provider: ai.reviewer.provider, model: ai.reviewer.model || '' });
        }
      }

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

  const handleProviderChange = async (role: 'orchestrator' | 'coder' | 'reviewer' | number, providerId: string) => {
    if (typeof role === 'number') {
      const next = [...reviewers];
      next[role] = { ...next[role], provider: providerId, model: '' };
      setReviewers(next);
    } else {
      const setter = role === 'orchestrator' ? setOrchestrator : role === 'coder' ? setCoder : setReviewer;
      setter({ provider: providerId, model: '' });
    }

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
        !coder.provider || !coder.model) {
      setError('Please configure orchestrator and coder roles');
      return;
    }

    if (useMultiReview && (reviewers.length < 2 || reviewers.some(r => !r.provider || !r.model))) {
      setError('Please configure at least 2 reviewers for multi-review mode');
      return;
    }

    if (!useMultiReview && (!reviewer.provider || !reviewer.model)) {
      setError('Please configure the reviewer role');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const updates: Record<string, any> = {
        'ai.orchestrator.provider': orchestrator.provider,
        'ai.orchestrator.model': orchestrator.model,
        'ai.coder.provider': coder.provider,
        'ai.coder.model': coder.model,
      };

      if (useMultiReview) {
        updates['ai.reviewers'] = reviewers;
        updates['ai.reviewer.provider'] = reviewers[0].provider;
        updates['ai.reviewer.model'] = reviewers[0].model;
      } else {
        updates['ai.reviewer.provider'] = reviewer.provider;
        updates['ai.reviewer.model'] = reviewer.model;
        updates['ai.reviewers'] = [];
      }

      await configApi.setConfig(updates, 'global');

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
    (useMultiReview ? 
      (reviewers.length >= 2 && reviewers.every(r => r.provider && r.model)) : 
      (reviewer.provider && reviewer.model));

  const renderRoleSelector = (
    label: string,
    icon: string,
    config: RoleConfig,
    onProviderChange: (role: any, provider: string) => void,
    onModelChange: (val: any) => void,
    role: any
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

        {/* Provider and Model Selection */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Provider</label>
            <select
              value={config.provider}
              onChange={(e) => onProviderChange(role, e.target.value)}
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
              onChange={(e) => onModelChange(e.target.value)}
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

        {/* Not Installed Warning */}
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
                onClick={() => copyToClipboard(installInfo.command, `${label}-install`)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-accent transition-colors"
              >
                <i className={`fa-solid ${copiedCommand === `${label}-install` ? 'fa-check text-success' : 'fa-copy'}`}></i>
              </button>
            </div>
          </div>
        )}

        {/* Needs API Key Warning */}
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
                onClick={() => copyToClipboard(`export ${envVar}="your-api-key"`, `${label}-env`)}
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative bg-bg-shell rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-start justify-between">
            <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
              <i className="fa-solid fa-robot text-accent"></i>
              AI Configuration Required
            </h2>
            {onClose && (
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-bg-surface2 text-text-muted hover:text-text-primary transition-colors">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-1">Configure models for each role</p>
        </div>

        <div className="px-6 py-4 max-h-[65vh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-8">
              <i className="fa-solid fa-spinner fa-spin text-2xl text-accent mb-3"></i>
              <p className="text-text-muted">Loading providers...</p>
            </div>
          ) : (
            <div className="space-y-4">
              {renderRoleSelector('Orchestrator', 'fa-sitemap', orchestrator, handleProviderChange, (m) => setOrchestrator(prev => ({...prev, model: m})), 'orchestrator')}
              {renderRoleSelector('Coder', 'fa-code', coder, handleProviderChange, (m) => setCoder(prev => ({...prev, model: m})), 'coder')}
              
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <i className="fa-solid fa-magnifying-glass text-accent"></i>
                    <span className="font-medium text-text-primary text-sm uppercase tracking-wider">Reviewers</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={useMultiReview} 
                      onChange={(e) => {
                        setUseMultiReview(e.target.checked);
                        if (e.target.checked && reviewers.length === 0) {
                          setReviewers([{...reviewer}, {provider: 'claude', model: 'claude-sonnet-4'}]);
                        }
                      }}
                      className="w-4 h-4 rounded border-border text-accent focus:ring-accent" 
                    />
                    <span className="text-xs text-text-secondary">Multi-Review Mode</span>
                  </label>
                </div>

                {useMultiReview ? (
                  <div className="space-y-3">
                    {reviewers.map((r, i) => (
                      <div key={i} className="relative">
                        {renderRoleSelector(`Reviewer ${i+1}`, 'fa-user-check', r, handleProviderChange, (m) => {
                          const next = [...reviewers];
                          next[i].model = m;
                          setReviewers(next);
                        }, i)}
                        {reviewers.length > 2 && (
                          <button 
                            onClick={() => setReviewers(reviewers.filter((_, idx) => idx !== i))}
                            className="absolute top-4 right-4 text-text-muted hover:text-danger transition-colors"
                          >
                            <i className="fa-solid fa-trash-can text-xs"></i>
                          </button>
                        )}
                      </div>
                    ))}
                    <button 
                      onClick={() => setReviewers([...reviewers, {provider: 'claude', model: 'claude-sonnet-4'}])}
                      className="w-full py-2 border border-dashed border-border rounded-lg text-xs text-text-muted hover:text-accent hover:border-accent transition-colors"
                    >
                      <i className="fa-solid fa-plus mr-1"></i> Add Reviewer
                    </button>
                  </div>
                ) : (
                  renderRoleSelector('Reviewer', 'fa-magnifying-glass', reviewer, handleProviderChange, (m) => setReviewer(prev => ({...prev, model: m})), 'reviewer')
                )}
              </div>

              {error && (
                <div className="p-3 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                  <i className="fa-solid fa-exclamation-circle mr-2"></i>{error}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border bg-bg-base">
          <button
            onClick={handleSave}
            disabled={saving || !isFormComplete}
            className="w-full px-4 py-3 bg-accent hover:bg-accent/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <><i className="fa-solid fa-spinner fa-spin"></i>Saving...</> : <><i className="fa-solid fa-check"></i>Save & Continue</>}
          </button>
        </div>
      </div>
    </div>
  );
};
