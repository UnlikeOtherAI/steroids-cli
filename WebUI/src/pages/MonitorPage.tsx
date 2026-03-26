import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowPathIcon,
  ShieldCheckIcon,
  PlayIcon,
  ExclamationTriangleIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import {
  monitorApi,
  aiApi,
  MonitorAgentConfig,
  MonitorResponseMode,
  AIProvider,
  AIModel,
} from '../services/api';
import { MonitorConfigSection } from './monitor-page-config';
import { MonitorRunHistorySection, MonitorStatusCard } from './monitor-page-runs';

export const MonitorPage: React.FC = () => {
  const navigate = useNavigate();

  // Config state
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Draft config (unsaved changes)
  const [enabled, setEnabled] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [agents, setAgents] = useState<MonitorAgentConfig[]>([]);
  const [responsePreset, setResponsePreset] = useState<MonitorResponseMode>('triage_only');
  const [responsePresetDeprecated, setResponsePresetDeprecated] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [minSeverity, setMinSeverity] = useState<string>('critical');

  // Provider/model data for the agent selector
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<Record<string, AIModel[]>>({});
  const [modelSources, setModelSources] = useState<Record<string, string>>({});
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

  // Run history
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof monitorApi.listRuns>>['runs']>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsPage, setRunsPage] = useState(0);
  const RUNS_PAGE_SIZE = 20;
  // Manual trigger state
  const [triggering, setTriggering] = useState(false);
  const [triggeringFix, setTriggeringFix] = useState(false);

  // UI sections — persist collapse state via cookie
  const [configOpen, setConfigOpen] = useState(() => {
    const match = document.cookie.match(/(?:^|;\s*)monitor_config_open=(\w+)/);
    return match ? match[1] === 'true' : true;
  });

  const toggleConfig = () => {
    setConfigOpen(prev => {
      const next = !prev;
      document.cookie = `monitor_config_open=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      return next;
    });
  };

  // ── Load config + providers ────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const [cfg, providerList] = await Promise.all([
        monitorApi.getConfig(),
        aiApi.getProviders(),
      ]);
      setProviders(providerList);

      if (cfg) {
        setEnabled(cfg.enabled);
        setIntervalSeconds(cfg.interval_seconds);
        setAgents(cfg.first_responder_agents.length > 0 ? cfg.first_responder_agents : []);
        setResponsePreset(cfg.canonical_response_mode);
        setResponsePresetDeprecated(cfg.response_preset_deprecated);
        setCustomPrompt(cfg.custom_prompt || '');
        setMinSeverity(cfg.escalation_rules?.min_severity || 'critical');
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
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (page = runsPage) => {
    setRunsLoading(true);
    try {
      const result = await monitorApi.listRuns(RUNS_PAGE_SIZE, page * RUNS_PAGE_SIZE);
      setRuns(result.runs);
      setRunsTotal(result.total);
    } catch {
      // Silently ignore — runs table might not exist yet
    } finally {
      setRunsLoading(false);
    }
  }, [runsPage]);

  useEffect(() => {
    loadConfig();
    loadRuns();
  }, [loadConfig, loadRuns]);

  // Poll runs every 10s
  useEffect(() => {
    const interval = setInterval(() => loadRuns(), 10_000);
    return () => clearInterval(interval);
  }, [loadRuns]);

  // ── Save config ────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      await monitorApi.updateConfig({
        enabled,
        interval_seconds: intervalSeconds,
        first_responder_agents: agents,
        response_preset: responsePreset,
        custom_prompt: responsePreset === 'custom' ? customPrompt : null,
        escalation_rules: { min_severity: minSeverity as 'info' | 'warning' | 'critical' },
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ── Agent list management ──────────────────────────────────────────────────

  const handleAgentProviderChange = async (index: number, providerId: string) => {
    const next = [...agents];
    next[index] = { ...next[index], provider: providerId, model: '' };
    setAgents(next);

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

  const handleAgentModelChange = (index: number, modelId: string) => {
    const next = [...agents];
    // Check for mappedProvider (hf/ollama models)
    const providerModels = models[next[index].provider] || [];
    const selectedModel = providerModels.find(m => m.id === modelId);
    const mapped = selectedModel?.mappedProvider;
    const isModelSource = next[index].provider === 'hf' || next[index].provider === 'ollama';
    const effectiveProvider = isModelSource ? undefined : mapped;

    next[index] = {
      provider: effectiveProvider || next[index].provider,
      model: modelId,
    };
    setAgents(next);
  };

  const addAgent = () => {
    setAgents(prev => [...prev, { provider: '', model: '' }]);
  };

  const removeAgent = (index: number) => {
    setAgents(prev => prev.filter((_, i) => i !== index));
  };

  const refreshModels = async (providerId: string) => {
    if (!providerId) return;
    setRefreshingProvider(providerId);
    try {
      const response = await aiApi.getModels(providerId);
      setModels(prev => ({ ...prev, [providerId]: response.models }));
      setModelSources(prev => ({ ...prev, [providerId]: response.source }));
    } catch {
      // ignore
    } finally {
      setRefreshingProvider(null);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  // ── Manual triggers ────────────────────────────────────────────────────────

  const handleRun = async () => {
    setTriggering(true);
    setError(null);
    try {
      const { result } = await monitorApi.triggerRun();
      if (result.runId) {
        navigate(`/monitor/run/${result.runId}`);
      } else {
        await loadRuns();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setTriggering(false);
    }
  };

  const handleTryToFix = async () => {
    setTriggeringFix(true);
    setError(null);
    try {
      const { result } = await monitorApi.triggerRun({ preset: 'fix_and_monitor', forceDispatch: true });
      if (result.runId) {
        navigate(`/monitor/run/${result.runId}`);
      } else {
        await loadRuns();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fix run failed');
    } finally {
      setTriggeringFix(false);
    }
  };

  const handleClearHistory = async () => {
    try {
      await monitorApi.clearRuns();
      setRuns([]);
      setRunsTotal(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    }
  };

  // ── Toggle enabled ─────────────────────────────────────────────────────────

  const handleToggleEnabled = async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    try {
      await monitorApi.updateConfig({ enabled: newEnabled });
    } catch (err) {
      setEnabled(!newEnabled); // revert
      setError(err instanceof Error ? err.message : 'Failed to toggle');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (configLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <ArrowPathIcon className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  const hasInvestigationInProgress = runs.some(r => r.outcome === 'first_responder_dispatched');

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldCheckIcon className="w-8 h-8 text-accent" />
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Monitor</h1>
            <p className="text-text-muted mt-1">
              Autonomous health monitoring across all projects
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Enable/Disable toggle */}
          <button
            onClick={handleToggleEnabled}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              enabled ? 'bg-accent' : 'bg-gray-400'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className="text-sm text-text-secondary">
            {enabled ? 'Enabled' : 'Disabled'}
          </span>

          {/* Run Now */}
          <button
            onClick={handleRun}
            disabled={triggering || triggeringFix || hasInvestigationInProgress}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent/90 text-sm font-medium transition-colors disabled:opacity-50"
            title={hasInvestigationInProgress ? 'First responder in progress' : 'Run full monitor cycle'}
          >
            {triggering ? (
              <ArrowPathIcon className="w-4 h-4 animate-spin" />
            ) : (
              <PlayIcon className="w-4 h-4" />
            )}
            Run Now
          </button>

          {/* Try to Fix - global action */}
          <button
            onClick={handleTryToFix}
            disabled={triggeringFix || triggering || hasInvestigationInProgress}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-600 text-white hover:bg-orange-700 text-sm font-medium transition-colors disabled:opacity-50"
            title={hasInvestigationInProgress ? 'First responder in progress' : 'Scan and fix all outstanding issues'}
          >
            {triggeringFix ? (
              <ArrowPathIcon className="w-4 h-4 animate-spin" />
            ) : (
              <WrenchScrewdriverIcon className="w-4 h-4" />
            )}
            Try to Fix
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <ExclamationTriangleIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      )}

      <MonitorConfigSection
        configOpen={configOpen}
        intervalSeconds={intervalSeconds}
        minSeverity={minSeverity}
        agents={agents}
        providers={providers}
        models={models}
        modelSources={modelSources}
        copiedCommand={copiedCommand}
        refreshingProvider={refreshingProvider}
        responsePreset={responsePreset}
        responsePresetDeprecated={responsePresetDeprecated}
        customPrompt={customPrompt}
        saveSuccess={saveSuccess}
        saving={saving}
        onToggleConfig={toggleConfig}
        onIntervalSecondsChange={setIntervalSeconds}
        onMinSeverityChange={setMinSeverity}
        onAgentProviderChange={handleAgentProviderChange}
        onAgentModelChange={handleAgentModelChange}
        onRefreshModels={refreshModels}
        onCopyToClipboard={copyToClipboard}
        onAddAgent={addAgent}
        onRemoveAgent={removeAgent}
        onResponsePresetChange={(mode) => {
          setResponsePreset(mode);
          setResponsePresetDeprecated(false);
        }}
        onCustomPromptChange={setCustomPrompt}
        onSave={handleSave}
      />

      <MonitorStatusCard
        latestRun={runs[0]}
        onOpenIssues={() => navigate('/monitor/issues')}
      />

      <MonitorRunHistorySection
        runs={runs}
        runsTotal={runsTotal}
        runsLoading={runsLoading}
        runsPage={runsPage}
        pageSize={RUNS_PAGE_SIZE}
        onClearHistory={handleClearHistory}
        onRefresh={() => loadRuns()}
        onOpenRun={(runId) => navigate(`/monitor/run/${runId}`)}
        onPreviousPage={() => {
          const page = runsPage - 1;
          setRunsPage(page);
          loadRuns(page);
        }}
        onNextPage={() => {
          const page = runsPage + 1;
          setRunsPage(page);
          loadRuns(page);
        }}
      />
    </div>
  );
};

export default MonitorPage;
