import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowPathIcon,
  ShieldCheckIcon,
  TrashIcon,
  PlayIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
  MagnifyingGlassIcon,
  ClockIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import {
  monitorApi,
  aiApi,
  MonitorRun,
  MonitorScanResult,
  MonitorAgentConfig,
  AIProvider,
  AIModel,
} from '../services/api';
import { AISetupRoleSelector } from '../components/onboarding/AISetupRoleSelector';

type ResponsePreset = 'stop_on_error' | 'investigate_and_stop' | 'fix_and_monitor' | 'custom';

const PRESET_LABELS: Record<ResponsePreset, { label: string; description: string }> = {
  stop_on_error: {
    label: 'Stop on Error',
    description: 'When anomalies are detected, stop all runners and report.',
  },
  investigate_and_stop: {
    label: 'Investigate & Stop',
    description: 'Investigate what\'s happening, provide a diagnostic report, then stop runners.',
  },
  fix_and_monitor: {
    label: 'Fix & Monitor',
    description: 'Attempt to fix issues automatically (reset tasks, restart runners), keep monitoring.',
  },
  custom: {
    label: 'Custom Prompt',
    description: 'Provide your own instructions for the investigator.',
  },
};

const INTERVAL_OPTIONS = [
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
];

const SEVERITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'critical', label: 'Critical only' },
  { value: 'warning', label: 'Warning and above' },
  { value: 'info', label: 'All anomalies' },
];

function formatEpochMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function outcomeVariant(outcome: string): { color: string; icon: React.ReactNode } {
  switch (outcome) {
    case 'clean':
      return { color: 'bg-green-100 text-green-800', icon: <CheckCircleIcon className="w-4 h-4" /> };
    case 'anomalies_found':
      return { color: 'bg-yellow-100 text-yellow-800', icon: <ExclamationTriangleIcon className="w-4 h-4" /> };
    case 'investigation_dispatched':
      return { color: 'bg-blue-100 text-blue-800', icon: <MagnifyingGlassIcon className="w-4 h-4" /> };
    case 'investigation_complete':
      return { color: 'bg-purple-100 text-purple-800', icon: <CheckCircleIcon className="w-4 h-4" /> };
    case 'error':
      return { color: 'bg-red-100 text-red-800', icon: <XCircleIcon className="w-4 h-4" /> };
    default:
      return { color: 'bg-gray-100 text-gray-800', icon: <ClockIcon className="w-4 h-4" /> };
  }
}

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
  const [responsePreset, setResponsePreset] = useState<ResponsePreset>('investigate_and_stop');
  const [customPrompt, setCustomPrompt] = useState('');
  const [minSeverity, setMinSeverity] = useState<string>('critical');

  // Provider/model data for the agent selector
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<Record<string, AIModel[]>>({});
  const [modelSources, setModelSources] = useState<Record<string, string>>({});
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);

  // Run history
  const [runs, setRuns] = useState<MonitorRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsLoading, setRunsLoading] = useState(true);
  // Manual trigger state
  const [scanning, setScanning] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [scanResult, setScanResult] = useState<MonitorScanResult | null>(null);

  // UI sections — persist collapse state
  const [configOpen, setConfigOpen] = useState(() => {
    const saved = localStorage.getItem('monitor_config_open');
    return saved !== null ? saved === 'true' : true;
  });

  const toggleConfig = () => {
    setConfigOpen(prev => {
      const next = !prev;
      localStorage.setItem('monitor_config_open', String(next));
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
        setAgents(cfg.investigator_agents.length > 0 ? cfg.investigator_agents : []);
        setResponsePreset(cfg.response_preset as ResponsePreset);
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

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const result = await monitorApi.listRuns(50);
      setRuns(result.runs);
      setRunsTotal(result.total);
    } catch {
      // Silently ignore — runs table might not exist yet
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadRuns();
  }, [loadConfig, loadRuns]);

  // Poll runs every 10s
  useEffect(() => {
    const interval = setInterval(loadRuns, 10_000);
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
        investigator_agents: agents,
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

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    setScanResult(null);
    try {
      const result = await monitorApi.triggerScan();
      setScanResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const handleRun = async () => {
    setTriggering(true);
    setError(null);
    try {
      await monitorApi.triggerRun();
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setTriggering(false);
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

  const hasInvestigationInProgress = runs.some(r => r.outcome === 'investigation_dispatched');

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

          {/* Scan Only */}
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-text-secondary hover:bg-bg-surface2 text-sm transition-colors disabled:opacity-50"
          >
            {scanning ? (
              <ArrowPathIcon className="w-4 h-4 animate-spin" />
            ) : (
              <MagnifyingGlassIcon className="w-4 h-4" />
            )}
            Scan
          </button>

          {/* Run Now */}
          <button
            onClick={handleRun}
            disabled={triggering || hasInvestigationInProgress}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent/90 text-sm font-medium transition-colors disabled:opacity-50"
            title={hasInvestigationInProgress ? 'Investigation in progress' : 'Run full monitor cycle'}
          >
            {triggering ? (
              <ArrowPathIcon className="w-4 h-4 animate-spin" />
            ) : (
              <PlayIcon className="w-4 h-4" />
            )}
            Run Now
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

      {/* Scan Result */}
      {scanResult && (
        <div className="mb-6 p-4 bg-bg-surface border border-border rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Scan Results</h3>
            <button onClick={() => setScanResult(null)} className="text-text-muted hover:text-text-secondary">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
          <p className="text-sm text-text-secondary mb-2">{scanResult.summary}</p>
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <span>{scanResult.projectCount} projects scanned</span>
            <span>{scanResult.anomalies.length} anomalies found</span>
          </div>
          {scanResult.anomalies.length > 0 && (
            <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
              {scanResult.anomalies.map((a, i) => (
                <div key={i} className="flex items-start gap-2 text-sm p-2 bg-bg-base rounded">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    a.severity === 'critical' ? 'bg-red-100 text-red-800' :
                    a.severity === 'warning' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {a.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-text-primary">{a.details}</span>
                    <div className="text-xs text-text-muted mt-0.5">
                      {a.projectName} {a.taskTitle ? `/ ${a.taskTitle}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Configuration Section */}
      <div className="mb-8">
        <button
          onClick={toggleConfig}
          className="flex items-center gap-2 text-xl font-semibold text-text-primary mb-4 hover:text-text-secondary"
        >
          {configOpen ? (
            <ChevronDownIcon className="w-5 h-5" />
          ) : (
            <ChevronRightIcon className="w-5 h-5" />
          )}
          <i className="fa-solid fa-gear w-5 h-5 flex items-center justify-center text-sm"></i>
          <span>Configuration</span>
        </button>

        {configOpen && (
          <div className="bg-bg-surface rounded-lg p-6 shadow-sm border border-border space-y-6">
            {/* Interval + Severity row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-secondary mb-1 uppercase tracking-wider">
                  Check Interval
                </label>
                <select
                  value={intervalSeconds}
                  onChange={e => setIntervalSeconds(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                >
                  {INTERVAL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1 uppercase tracking-wider">
                  Escalation Threshold
                </label>
                <select
                  value={minSeverity}
                  onChange={e => setMinSeverity(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                >
                  {SEVERITY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Investigator Agents */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <i className="fa-solid fa-user-secret text-accent"></i>
                  <span className="font-medium text-text-primary text-sm uppercase tracking-wider">
                    Investigator Agents
                  </span>
                  <span className="text-[10px] text-text-muted">(fallback chain, first = preferred)</span>
                </div>
              </div>

              <div className="space-y-3">
                {agents.map((agent, i) => (
                  <AISetupRoleSelector
                    key={i}
                    label={`Investigator ${i + 1}`}
                    icon="fa-user-secret"
                    config={agent}
                    providers={providers}
                    modelsByProvider={models}
                    modelSources={modelSources}
                    copiedCommand={copiedCommand}
                    refreshingProvider={refreshingProvider}
                    isProjectLevel={false}
                    isInherited={false}
                    onProviderChange={providerId => handleAgentProviderChange(i, providerId)}
                    onModelChange={modelId => handleAgentModelChange(i, modelId)}
                    onRefreshModels={refreshModels}
                    onCopyToClipboard={copyToClipboard}
                    onRemove={agents.length > 1 ? () => removeAgent(i) : undefined}
                  />
                ))}
                <button
                  onClick={addAgent}
                  className="w-full py-2 border border-dashed border-border rounded-lg text-xs text-text-muted hover:text-accent hover:border-accent transition-colors flex items-center justify-center gap-1"
                >
                  <PlusIcon className="w-3 h-3" />
                  Add Investigator (Fallback)
                </button>
              </div>
            </div>

            {/* Response Preset */}
            <div>
              <label className="block text-xs text-text-secondary mb-2 uppercase tracking-wider">
                Response Strategy
              </label>
              <div className="grid grid-cols-2 gap-3">
                {(Object.entries(PRESET_LABELS) as [ResponsePreset, typeof PRESET_LABELS[ResponsePreset]][]).map(
                  ([key, { label, description }]) => (
                    <label
                      key={key}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        responsePreset === key
                          ? 'border-accent bg-accent/5'
                          : 'border-border bg-bg-base hover:border-accent/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="preset"
                        value={key}
                        checked={responsePreset === key}
                        onChange={() => setResponsePreset(key)}
                        className="mt-1 w-4 h-4 text-accent border-border focus:ring-accent"
                      />
                      <div>
                        <div className="font-medium text-text-primary text-sm">{label}</div>
                        <div className="text-xs text-text-muted mt-0.5">{description}</div>
                      </div>
                    </label>
                  )
                )}
              </div>

              {responsePreset === 'custom' && (
                <textarea
                  value={customPrompt}
                  onChange={e => setCustomPrompt(e.target.value)}
                  placeholder="Enter custom instructions for the investigator agent..."
                  rows={4}
                  className="w-full mt-3 px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent resize-y"
                />
              )}
            </div>

            {/* Save button */}
            <div className="flex items-center justify-between pt-4 border-t border-border">
              <div>
                {saveSuccess && (
                  <span className="flex items-center gap-1 text-sm text-green-600">
                    <CheckCircleIcon className="w-4 h-4" />
                    Saved
                  </span>
                )}
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2 rounded-lg font-medium transition-colors bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <ArrowPathIcon className="w-4 h-4 animate-spin" />
                    Saving...
                  </span>
                ) : (
                  'Save Configuration'
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Run History */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-text-primary">Run History</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">{runsTotal} runs</span>
            {runs.length > 0 && (
              <button
                onClick={handleClearHistory}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-text-muted hover:text-danger hover:border-danger/50 text-xs transition-colors"
              >
                <TrashIcon className="w-3 h-3" />
                Clear
              </button>
            )}
            <button
              onClick={loadRuns}
              disabled={runsLoading}
              className="p-1.5 rounded-lg hover:bg-bg-surface2 text-text-secondary"
            >
              <ArrowPathIcon className={`w-4 h-4 ${runsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {runs.length === 0 ? (
          <div className="text-center py-12 bg-bg-surface rounded-lg border border-border">
            <ShieldCheckIcon className="w-12 h-12 text-text-muted mx-auto mb-3" />
            <p className="text-text-muted">No monitor runs yet</p>
            <p className="text-xs text-text-muted mt-1">
              Enable the monitor or click "Run Now" to start
            </p>
          </div>
        ) : (
          <div className="bg-bg-surface rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Time</th>
                  <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Outcome</th>
                  <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Anomalies</th>
                  <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Escalation</th>
                  <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Duration</th>
                  <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider w-8"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => {
                  const ov = outcomeVariant(run.outcome);
                  const anomalyCount = run.scan_results?.anomalies?.length ?? 0;

                  return (
                      <tr
                        key={run.id}
                        className="border-b border-border/50 hover:bg-bg-base cursor-pointer transition-colors"
                        onClick={() => navigate(`/monitor/run/${run.id}`)}
                      >
                        <td className="px-4 py-3 text-text-secondary">
                          {formatEpochMs(run.started_at)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${ov.color}`}>
                            {ov.icon}
                            {run.outcome.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-text-secondary">
                          {anomalyCount > 0 ? anomalyCount : '--'}
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs truncate max-w-[200px]">
                          {run.escalation_reason || (run.error ? <span className="text-red-600">{run.error}</span> : '--')}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          {formatDuration(run.duration_ms)}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          <ChevronRightIcon className="w-4 h-4" />
                        </td>
                      </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default MonitorPage;
