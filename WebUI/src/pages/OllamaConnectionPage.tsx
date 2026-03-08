import { useEffect, useMemo, useState } from 'react';
import type { OllamaConnectionMode, OllamaConnectionStatus } from '../types';
import { ollamaApi } from '../services/ollamaApi';

const DEFAULT_ENDPOINTS: Record<OllamaConnectionMode, string> = {
  local: 'http://localhost:11434',
  cloud: 'https://ollama.com',
};

interface FormState {
  mode: OllamaConnectionMode;
  endpoint: string;
  apiKey: string;
}

function formatMode(mode: OllamaConnectionMode): string {
  return mode === 'cloud' ? 'Cloud' : 'Local';
}

function formatVramGb(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0.0 GB';
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function OllamaConnectionPage() {
  const [connection, setConnection] = useState<OllamaConnectionStatus | null>(null);
  const [form, setForm] = useState<FormState>({
    mode: 'local',
    endpoint: DEFAULT_ENDPOINTS.local,
    apiKey: '',
  });
  const [endpointByMode, setEndpointByMode] = useState<Record<OllamaConnectionMode, string>>({
    local: DEFAULT_ENDPOINTS.local,
    cloud: DEFAULT_ENDPOINTS.cloud,
  });
  const [overrideByMode, setOverrideByMode] = useState<Record<OllamaConnectionMode, boolean>>({
    local: false,
    cloud: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadedModelsCount = useMemo(() => connection?.loadedModels?.length ?? 0, [connection?.loadedModels?.length]);

  const syncFromConnection = (data: OllamaConnectionStatus) => {
    const mode = data.mode ?? 'local';
    const endpoint = data.endpoint?.trim() || DEFAULT_ENDPOINTS[mode];
    const localOverride = mode === 'local' && endpoint !== DEFAULT_ENDPOINTS.local;
    const cloudOverride = mode === 'cloud' && endpoint !== DEFAULT_ENDPOINTS.cloud;

    setConnection(data);
    setForm({ mode, endpoint, apiKey: '' });
    setEndpointByMode({
      local: localOverride ? endpoint : DEFAULT_ENDPOINTS.local,
      cloud: cloudOverride ? endpoint : DEFAULT_ENDPOINTS.cloud,
    });
    setOverrideByMode({
      local: localOverride,
      cloud: cloudOverride,
    });
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ollamaApi.getConnection();
      syncFromConnection(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connection');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectMode = (mode: OllamaConnectionMode) => {
    setForm((prev) => ({
      ...prev,
      mode,
      endpoint: overrideByMode[mode] ? endpointByMode[mode] : DEFAULT_ENDPOINTS[mode],
    }));
    setMessage(null);
    setError(null);
  };

  const setEndpoint = (endpoint: string) => {
    const trimmed = endpoint.trim();
    const mode = form.mode;
    setForm((prev) => ({ ...prev, endpoint }));
    setEndpointByMode((prev) => ({ ...prev, [mode]: endpoint }));
    setOverrideByMode((prev) => ({ ...prev, [mode]: trimmed !== DEFAULT_ENDPOINTS[mode] }));
    setMessage(null);
    setError(null);
  };

  const buildPayload = () => {
    const endpoint = (overrideByMode[form.mode] ? form.endpoint : DEFAULT_ENDPOINTS[form.mode]).trim();
    return {
      mode: form.mode,
      endpoint,
      apiKey: form.mode === 'cloud' ? form.apiKey.trim() || undefined : undefined,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await ollamaApi.updateConnection(buildPayload());
      syncFromConnection(response);
      setMessage('Connection settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connection');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await ollamaApi.testConnection(buildPayload());
      setConnection(response);
      setMessage(response.connected ? 'Connection test succeeded.' : 'Connection test failed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Connection</h1>
        <p className="mt-2 text-sm text-text-muted">
          Configure local or cloud mode, then test and save endpoint settings.
        </p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading connection...
        </div>
      )}

      {!loading && (
        <div className="card p-6 space-y-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => selectMode('local')}
              className={form.mode === 'local' ? 'btn-accent' : 'btn-pill'}
            >
              Local
            </button>
            <button
              type="button"
              onClick={() => selectMode('cloud')}
              className={form.mode === 'cloud' ? 'btn-accent' : 'btn-pill'}
            >
              Cloud
            </button>
          </div>

          <label className="block">
            <span className="text-sm text-text-muted">Endpoint</span>
            <input
              aria-label="Endpoint"
              value={form.endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              className="mt-2 w-full bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
          </label>

          {form.mode === 'cloud' && (
            <label className="block">
              <span className="text-sm text-text-muted">API Key (optional)</span>
              <input
                aria-label="API Key"
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                placeholder="ollama_api_..."
                className="mt-2 w-full bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </label>
          )}

          <div className="flex items-center gap-3">
            <button type="button" className="btn-pill" onClick={handleTest} disabled={testing || saving}>
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button type="button" className="btn-accent" onClick={handleSave} disabled={saving || testing}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {message && <p className="text-sm text-success">{message}</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {connection && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-text-primary">Current Status</h2>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-muted">Mode</p>
              <p className="font-semibold text-text-primary">{formatMode(connection.mode)}</p>
            </div>
            <div>
              <p className="text-text-muted">Status</p>
              <p className={connection.connected ? 'font-semibold text-success' : 'font-semibold text-danger'}>
                {connection.connected ? 'Connected' : 'Disconnected'}
              </p>
            </div>
            <div>
              <p className="text-text-muted">Version</p>
              <p className="font-semibold text-text-primary">{connection.version || 'Unknown'}</p>
            </div>
            <div>
              <p className="text-text-muted">Loaded Models</p>
              <p className="font-semibold text-text-primary">{loadedModelsCount}</p>
              {(connection.loadedModels?.length ?? 0) > 0 ? (
                <ul className="mt-2 space-y-1">
                  {connection.loadedModels?.map((model) => (
                    <li key={model.name} className="text-xs text-text-muted">
                      {model.name} • VRAM {formatVramGb(model.sizeVram)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-text-muted">No models currently loaded in memory.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
