import React, { useEffect, useState } from 'react';
import { aiApi, configApi, AIProvider, AIModel } from '../../services/api';

interface AISetupModalProps {
  onComplete: () => void;
}

interface RoleConfig {
  provider: string;
  model: string;
}

export const AISetupModal: React.FC<AISetupModalProps> = ({ onComplete }) => {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<Record<string, AIModel[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      for (const provider of providerList) {
        if (provider.installed) {
          try {
            const response = await aiApi.getModels(provider.id);
            modelsMap[provider.id] = response.models;
          } catch {
            modelsMap[provider.id] = [];
          }
        }
      }
      setModels(modelsMap);
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
      } catch {
        setModels(prev => ({ ...prev, [providerId]: [] }));
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

  const unavailableProviders = providers.filter(p => !p.installed);

  const renderRoleSelector = (
    label: string,
    icon: string,
    config: RoleConfig,
    setConfig: (role: 'orchestrator' | 'coder' | 'reviewer', provider: string) => void,
    setModel: React.Dispatch<React.SetStateAction<RoleConfig>>,
    role: 'orchestrator' | 'coder' | 'reviewer'
  ) => (
    <div className="bg-bg-base rounded-lg p-4 border border-border">
      <div className="flex items-center gap-2 mb-3">
        <i className={`fa-solid ${icon} text-accent`}></i>
        <span className="font-medium text-text-primary">{label}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Provider</label>
          <select
            value={config.provider}
            onChange={(e) => setConfig(role, e.target.value)}
            className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
          >
            <option value="">Select provider...</option>
            {providers.map(p => (
              <option key={p.id} value={p.id} disabled={!p.installed}>
                {p.name}{!p.installed ? ' (not installed)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Model</label>
          <select
            value={config.model}
            onChange={(e) => setModel(prev => ({ ...prev, model: e.target.value }))}
            disabled={!config.provider}
            className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">Select model...</option>
            {(models[config.provider] || []).map(m => (
              <option key={m.id} value={m.id}>{m.name || m.id}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop with slight blur */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />

      {/* Modal */}
      <div className="relative bg-bg-shell rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <i className="fa-solid fa-robot text-accent"></i>
            AI Configuration Required
          </h2>
          <p className="text-sm text-text-muted mt-1">
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
              {/* Unavailable providers notice */}
              {unavailableProviders.length > 0 && (
                <div className="mb-4 p-3 bg-bg-base border border-border rounded-lg">
                  <div className="flex items-start gap-2 text-text-muted text-sm">
                    <i className="fa-solid fa-info-circle mt-0.5"></i>
                    <div>
                      <span>Not available: {unavailableProviders.map(p => p.name).join(', ')}</span>
                      <div className="text-xs mt-1">
                        Install the required CLI tools to use these providers.
                      </div>
                    </div>
                  </div>
                </div>
              )}

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
            disabled={saving}
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
        </div>
      </div>
    </div>
  );
};
