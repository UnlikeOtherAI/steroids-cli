import { useEffect, useState } from 'react';
import type { OllamaConnectionStatus, OllamaCachedModel } from '../types';
import { ollamaApi } from '../services/ollamaApi';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function OllamaConnectionPage() {
  const [status, setStatus] = useState<OllamaConnectionStatus | null>(null);
  const [models, setModels] = useState<OllamaCachedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [mode, setMode] = useState<'local' | 'cloud'>('local');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [configData, statusData, modelsData] = await Promise.all([
        ollamaApi.getConnection(),
        ollamaApi.testConnection(),
        ollamaApi.getModels().catch(() => [] as OllamaCachedModel[]),
      ]);
      setStatus(statusData);
      setModels(modelsData);
      setMode(configData.mode);
      setEndpoint(configData.endpoint);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connection');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await ollamaApi.setConnection({
        mode,
        endpoint: endpoint.trim() || undefined,
        apiKey: mode === 'cloud' ? apiKey.trim() : undefined,
      });
      setApiKey('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connection');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await ollamaApi.testConnection();
      setStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async (name: string) => {
    setDeleting(name);
    setError(null);
    try {
      await ollamaApi.deleteModel(name);
      setModels((prev) => prev.filter((m) => m.name !== name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete model');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Connection</h1>
        <p className="mt-2 text-sm text-text-muted">
          Configure your Ollama instance (local or cloud) and manage installed models.
        </p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading connection...
        </div>
      )}

      {!loading && (
        <>
          {/* Connection Status */}
          {status && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold text-text-primary mb-3">Status</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-text-muted">Connection</p>
                  <p className={status.connected ? 'font-semibold text-success' : 'font-semibold text-danger'}>
                    {status.connected ? 'Connected' : 'Disconnected'}
                  </p>
                </div>
                <div>
                  <p className="text-text-muted">Mode</p>
                  <p className="font-semibold text-text-primary">{status.mode === 'cloud' ? 'Cloud' : 'Local'}</p>
                </div>
                <div>
                  <p className="text-text-muted">Endpoint</p>
                  <p className="font-semibold text-text-primary truncate" title={status.endpoint}>{status.endpoint}</p>
                </div>
                {status.version && (
                  <div>
                    <p className="text-text-muted">Version</p>
                    <p className="font-semibold text-text-primary">
                      {status.version}
                      {status.minimumVersionMet === false && (
                        <span className="ml-2 text-warning text-xs">(below minimum)</span>
                      )}
                    </p>
                  </div>
                )}
                {status.loadedModels !== undefined && (
                  <div>
                    <p className="text-text-muted">Loaded Models</p>
                    <p className="font-semibold text-text-primary">{status.loadedModels}</p>
                  </div>
                )}
                {status.error && (
                  <div className="sm:col-span-2">
                    <p className="text-sm text-danger">{status.error}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Connection Configuration */}
          <div className="card p-6 space-y-4">
            <h2 className="text-lg font-semibold text-text-primary">Configuration</h2>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'local'}
                  onChange={() => setMode('local')}
                  className="accent-accent"
                />
                <span className="text-sm text-text-primary">Local</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === 'cloud'}
                  onChange={() => setMode('cloud')}
                  className="accent-accent"
                />
                <span className="text-sm text-text-primary">Cloud</span>
              </label>
            </div>

            <label className="block">
              <span className="text-sm text-text-muted">Endpoint</span>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={mode === 'cloud' ? 'https://ollama.com' : 'http://localhost:11434'}
                className="mt-2 w-full bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </label>

            {mode === 'cloud' && (
              <label className="block">
                <span className="text-sm text-text-muted">API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter cloud API key..."
                  className="mt-2 w-full bg-bg-elevated rounded-full px-5 py-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                />
              </label>
            )}

            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn-accent" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Connection'}
              </button>
              <button type="button" className="btn-pill" onClick={handleTest} disabled={testing}>
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
          </div>

          {/* Installed Models */}
          <div className="card overflow-hidden">
            <div className="p-6 pb-3">
              <h2 className="text-lg font-semibold text-text-primary">Installed Models</h2>
              <p className="text-sm text-text-muted mt-1">{models.length} model(s) found on this endpoint.</p>
            </div>
            {models.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-bg-elevated text-text-primary">
                    <tr>
                      <th className="text-left px-4 py-3">Name</th>
                      <th className="text-left px-4 py-3">Family</th>
                      <th className="text-left px-4 py-3">Parameters</th>
                      <th className="text-left px-4 py-3">Quantization</th>
                      <th className="text-left px-4 py-3">Size</th>
                      <th className="text-left px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((model) => (
                      <tr key={model.digest} className="border-t border-bg-elevated/60">
                        <td className="px-4 py-3 font-medium text-text-primary">{model.name}</td>
                        <td className="px-4 py-3 text-text-muted">{model.family || '—'}</td>
                        <td className="px-4 py-3 text-text-muted">{model.parameterSize || '—'}</td>
                        <td className="px-4 py-3 text-text-muted">{model.quantization || '—'}</td>
                        <td className="px-4 py-3 text-text-muted">{formatBytes(model.size)}</td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="btn-pill"
                            disabled={deleting === model.name}
                            onClick={() => handleDelete(model.name)}
                          >
                            {deleting === model.name ? 'Deleting...' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {models.length === 0 && (
              <div className="p-8 text-center text-text-muted">No installed models found.</div>
            )}
          </div>
        </>
      )}

      {error && <div className="text-sm text-danger">{error}</div>}
    </div>
  );
}
