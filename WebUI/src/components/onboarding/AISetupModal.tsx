import React, { useEffect, useState } from 'react';
import { aiApi, configApi, AIProvider, AIModel } from '../../services/api';
import { AISetupRoleSelector } from './AISetupRoleSelector';

interface AISetupModalProps {
  onComplete: () => void;
  onClose?: () => void;
  isProjectLevel?: boolean;
  projectPath?: string;
  inheritedConfig?: Record<string, any>;
}

interface RoleConfig {
  provider: string;
  model: string;
}

type RoleKey = 'orchestrator' | 'coder' | 'reviewer';

interface InheritedRoleConfig {
  provider?: string;
  model?: string;
}

function hasProviderAndModel(value: unknown): value is Required<InheritedRoleConfig> {
  if (!value || typeof value !== 'object') return false;
  const role = value as InheritedRoleConfig;
  return Boolean(role.provider && role.model);
}

export const AISetupModal: React.FC<AISetupModalProps> = ({
  onComplete,
  onClose,
  isProjectLevel = false,
  projectPath,
  inheritedConfig,
}) => {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<Record<string, AIModel[]>>({});
  const [modelSources, setModelSources] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

  // Role configurations
  const [orchestrator, setOrchestrator] = useState<RoleConfig>({ provider: '', model: '' });
  const [coder, setCoder] = useState<RoleConfig>({ provider: '', model: '' });
  const [reviewer, setReviewer] = useState<RoleConfig>({ provider: '', model: '' });
  const [reviewers, setReviewers] = useState<RoleConfig[]>([]);
  const [useMultiReview, setUseMultiReview] = useState(false);
  const [globalAIConfig, setGlobalAIConfig] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      setLoading(true);
      const [providerList, globalConfig, projectConfig] = await Promise.all([
        aiApi.getProviders(),
        configApi.getConfig('global'),
        isProjectLevel && projectPath ? configApi.getConfig('project', projectPath) : Promise.resolve(null),
      ]);
      setProviders(providerList);

      // Extract global AI config for inheritance logic
      const globalAI = globalConfig.ai as any;
      setGlobalAIConfig(globalAI ?? null);

      // Pre-fill from existing config (project-level takes precedence)
      const configToUse = isProjectLevel && projectConfig ? projectConfig : globalConfig;
      const ai = configToUse.ai as any;

      if (isProjectLevel && globalAI && !projectConfig?.ai) {
        // Project-level with no project config - show inherited with global config
        if (globalAI.orchestrator?.provider) setOrchestrator({ provider: '', model: globalAI.orchestrator.model || '' });
        if (globalAI.coder?.provider) setCoder({ provider: '', model: globalAI.coder.model || '' });

        if (globalAI.reviewers && Array.isArray(globalAI.reviewers) && globalAI.reviewers.length > 0) {
          setUseMultiReview(true);
          setReviewers(globalAI.reviewers.map((r: any) => ({ provider: '', model: r.model || '' })));
          setReviewer({ provider: '', model: globalAI.reviewers[0].model || '' });
        } else if (globalAI.reviewer?.provider) {
          setReviewer({ provider: '', model: globalAI.reviewer.model || '' });
        }
      } else if (ai) {
        // Use project config or global config directly
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

  const handleModelChange = (role: 'orchestrator' | 'coder' | 'reviewer' | number, modelId: string) => {
    // Check if the selected model has a mappedProvider override
    const providerKey = typeof role === 'number'
      ? reviewers[role]?.provider
      : role === 'orchestrator' ? orchestrator.provider
        : role === 'coder' ? coder.provider : reviewer.provider;
    const providerModels = models[providerKey] || [];
    const selectedModel = providerModels.find((m) => m.id === modelId);
    const mapped = selectedModel?.mappedProvider;

    // For hf/ollama, keep the UI provider unchanged — mappedProvider is used at save time only
    const isModelSource = providerKey === 'hf' || providerKey === 'ollama';
    const effectiveProvider = isModelSource ? undefined : mapped;

    if (typeof role === 'number') {
      const next = [...reviewers];
      next[role] = { provider: effectiveProvider || next[role].provider, model: modelId };
      setReviewers(next);
    } else if (role === 'orchestrator') {
      setOrchestrator({ provider: effectiveProvider || orchestrator.provider, model: modelId });
    } else if (role === 'coder') {
      setCoder({ provider: effectiveProvider || coder.provider, model: modelId });
    } else {
      setReviewer({ provider: effectiveProvider || reviewer.provider, model: modelId });
    }
  };

  const getInheritedValue = (role: RoleKey | number): InheritedRoleConfig | null => {
    const inheritedAi = (inheritedConfig?.ai as Record<string, unknown> | undefined)
      ?? globalAIConfig;
    if (!inheritedAi || typeof inheritedAi !== 'object') return null;

    if (typeof role === 'number') {
      const reviewersConfig = (inheritedAi as Record<string, unknown>).reviewers;
      if (Array.isArray(reviewersConfig)) {
        const reviewerConfig = reviewersConfig[role];
        if (reviewerConfig && typeof reviewerConfig === 'object') {
          return reviewerConfig as InheritedRoleConfig;
        }
      }
      // Fallback: first reviewer inherits from single reviewer config.
      if (role === 0) {
        const singleReviewer = (inheritedAi as Record<string, unknown>).reviewer;
        if (singleReviewer && typeof singleReviewer === 'object') {
          return singleReviewer as InheritedRoleConfig;
        }
      }
      return null;
    }

    const value = (inheritedAi as Record<string, unknown>)[role];
    return value && typeof value === 'object' ? (value as InheritedRoleConfig) : null;
  };

  /** Resolve the provider to save: for hf/ollama, use the model's mappedProvider (the runtime). */
  const resolveSaveProvider = (config: RoleConfig): string => {
    if (config.provider !== 'hf' && config.provider !== 'ollama') return config.provider;
    const providerModels = models[config.provider] || [];
    const selected = providerModels.find((m) => m.id === config.model);
    return selected?.mappedProvider || config.provider;
  };

  const normalizeRoleConfig = (config: RoleConfig, role: RoleKey | number) => {
    const inheritedValue = getInheritedValue(role);
    const usesInheritance = isProjectLevel && !config.provider;

    if (usesInheritance) {
      return {
        provider: '',
        model: '',
        valid: hasProviderAndModel(inheritedValue),
        inherited: true,
      };
    }

    return {
      provider: resolveSaveProvider(config),
      model: config.model,
      valid: Boolean(config.provider && config.model),
      inherited: false,
    };
  };

  const handleSave = async () => {
    const normalizedOrchestrator = normalizeRoleConfig(orchestrator, 'orchestrator');
    const normalizedCoder = normalizeRoleConfig(coder, 'coder');

    if (!normalizedOrchestrator.valid || !normalizedCoder.valid) {
      setError('Please configure orchestrator and coder roles');
      return;
    }

    const normalizedReviewers = useMultiReview
      ? reviewers.map((r, index) => normalizeRoleConfig(r, index))
      : [normalizeRoleConfig(reviewer, 'reviewer')];

    if (useMultiReview && (reviewers.length < 2 || normalizedReviewers.some((r) => !r.valid))) {
      setError('Please configure at least 2 reviewers for multi-review mode');
      return;
    }

    if (!useMultiReview && !normalizedReviewers[0].valid) {
      setError('Please configure the reviewer role');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const updates: Record<string, any> = {
        'ai.orchestrator.provider': normalizedOrchestrator.provider,
        'ai.orchestrator.model': normalizedOrchestrator.model,
        'ai.coder.provider': normalizedCoder.provider,
        'ai.coder.model': normalizedCoder.model,
      };

      if (useMultiReview) {
        const reviewerUpdates = normalizedReviewers.map((r) => ({
          provider: r.provider,
          model: r.model,
        }));
        updates['ai.reviewers'] = reviewerUpdates;
        updates['ai.reviewer.provider'] = reviewerUpdates[0].provider;
        updates['ai.reviewer.model'] = reviewerUpdates[0].model;
      } else {
        updates['ai.reviewer.provider'] = normalizedReviewers[0].provider;
        updates['ai.reviewer.model'] = normalizedReviewers[0].model;
        updates['ai.reviewers'] = [];
      }

      await configApi.setConfig(updates, isProjectLevel ? 'project' : 'global', isProjectLevel ? projectPath : undefined);

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

  const refreshModels = async (providerId: string) => {
    if (!providerId) return;
    setRefreshingProvider(providerId);
    try {
      const response = await aiApi.getModels(providerId);
      setModels(prev => ({ ...prev, [providerId]: response.models }));
      setModelSources(prev => ({ ...prev, [providerId]: response.source }));
    } catch (err) {
      console.error('Failed to refresh models:', err);
    } finally {
      setRefreshingProvider(null);
    }
  };

  // Check if all fields are complete for validation
  const isFormComplete = (() => {
    const orchestratorReady = normalizeRoleConfig(orchestrator, 'orchestrator').valid;
    const coderReady = normalizeRoleConfig(coder, 'coder').valid;
    if (!orchestratorReady || !coderReady) return false;

    if (useMultiReview) {
      return reviewers.length >= 2 && reviewers.every((r, index) => normalizeRoleConfig(r, index).valid);
    }

    return normalizeRoleConfig(reviewer, 'reviewer').valid;
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative bg-bg-shell rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-start justify-between">
            <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
              <i className="fa-solid fa-robot text-accent"></i>
              {isProjectLevel ? 'Project AI Configuration' : 'AI Configuration Required'}
            </h2>
            {onClose && (
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-danger/10 text-danger hover:text-danger/80 transition-colors" title="Close">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-1">
            {isProjectLevel
              ? 'Override global AI settings for this project'
              : 'Configure models for each role'}
          </p>
        </div>

        <div className="px-6 py-4 max-h-[65vh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-8">
              <i className="fa-solid fa-spinner fa-spin text-2xl text-accent mb-3"></i>
              <p className="text-text-muted">Loading providers...</p>
            </div>
          ) : (
            <div className="space-y-4">
              <AISetupRoleSelector
                label="Orchestrator"
                icon="fa-sitemap"
                config={orchestrator}
                providers={providers}
                modelsByProvider={models}
                modelSources={modelSources}
                copiedCommand={copiedCommand}
                refreshingProvider={refreshingProvider}
                isProjectLevel={isProjectLevel}
                isInherited={Boolean(isProjectLevel && !orchestrator.provider && hasProviderAndModel(getInheritedValue('orchestrator')))}
                inheritedModel={getInheritedValue('orchestrator')?.model}
                onProviderChange={(providerId) => handleProviderChange('orchestrator', providerId)}
                onModelChange={(m) => handleModelChange('orchestrator', m)}
                onRefreshModels={refreshModels}
                onCopyToClipboard={copyToClipboard}
              />
              <AISetupRoleSelector
                label="Coder"
                icon="fa-code"
                config={coder}
                providers={providers}
                modelsByProvider={models}
                modelSources={modelSources}
                copiedCommand={copiedCommand}
                refreshingProvider={refreshingProvider}
                isProjectLevel={isProjectLevel}
                isInherited={Boolean(isProjectLevel && !coder.provider && hasProviderAndModel(getInheritedValue('coder')))}
                inheritedModel={getInheritedValue('coder')?.model}
                onProviderChange={(providerId) => handleProviderChange('coder', providerId)}
                onModelChange={(m) => handleModelChange('coder', m)}
                onRefreshModels={refreshModels}
                onCopyToClipboard={copyToClipboard}
              />
              
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
                      <AISetupRoleSelector
                        key={i}
                        label={`Reviewer ${i + 1}`}
                        icon="fa-user-check"
                        config={r}
                        providers={providers}
                        modelsByProvider={models}
                        modelSources={modelSources}
                        copiedCommand={copiedCommand}
                        refreshingProvider={refreshingProvider}
                        isProjectLevel={isProjectLevel}
                        isInherited={Boolean(isProjectLevel && !r.provider && hasProviderAndModel(getInheritedValue(i)))}
                        inheritedModel={getInheritedValue(i)?.model}
                        onProviderChange={(providerId) => handleProviderChange(i, providerId)}
                        onModelChange={(m) => handleModelChange(i, m)}
                        onRefreshModels={refreshModels}
                        onCopyToClipboard={copyToClipboard}
                        onRemove={reviewers.length > 1 ? () => setReviewers(reviewers.filter((_, idx) => idx !== i)) : undefined}
                      />
                    ))}
                    <button 
                      onClick={() => setReviewers([...reviewers, {provider: 'claude', model: 'claude-sonnet-4'}])}
                      className="w-full py-2 border border-dashed border-border rounded-lg text-xs text-text-muted hover:text-accent hover:border-accent transition-colors"
                    >
                      <i className="fa-solid fa-plus mr-1"></i> Add Reviewer
                    </button>
                  </div>
                ) : (
                  <AISetupRoleSelector
                    label="Reviewer"
                    icon="fa-magnifying-glass"
                    config={reviewer}
                    providers={providers}
                    modelsByProvider={models}
                    modelSources={modelSources}
                    copiedCommand={copiedCommand}
                    refreshingProvider={refreshingProvider}
                    isProjectLevel={isProjectLevel}
                    isInherited={Boolean(isProjectLevel && !reviewer.provider && hasProviderAndModel(getInheritedValue('reviewer')))}
                    inheritedModel={getInheritedValue('reviewer')?.model}
                    onProviderChange={(providerId) => handleProviderChange('reviewer', providerId)}
                    onModelChange={(m) => handleModelChange('reviewer', m)}
                    onRefreshModels={refreshModels}
                    onCopyToClipboard={copyToClipboard}
                  />
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
