import { useEffect, useState } from 'react';
import type { OllamaInstalledModel, OllamaRuntime } from '../types';
import { ollamaApi } from '../services/ollamaApi';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function OllamaInstalledModelsPage() {
  const [models, setModels] = useState<OllamaInstalledModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ollamaApi.getInstalledModels();
      setModels(response.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load installed models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const pair = async (model: OllamaInstalledModel, runtime: OllamaRuntime) => {
    setUpdating(`${model.name}:${runtime}`);
    setError(null);
    try {
      await ollamaApi.pairInstalledModel(model.name, runtime);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pair model');
    } finally {
      setUpdating(null);
    }
  };

  const remove = async (model: OllamaInstalledModel) => {
    setUpdating(`${model.name}:delete`);
    setError(null);
    try {
      await ollamaApi.deleteInstalledModel(model.name);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete model');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Installed Models</h1>
        <p className="mt-2 text-sm text-text-muted">Models available on the connected Ollama endpoint.</p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading installed models...
        </div>
      )}

      {!loading && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Model Name</th>
                  <th className="text-left px-4 py-3">Size</th>
                  <th className="text-left px-4 py-3">Parameters</th>
                  <th className="text-left px-4 py-3">Quantization</th>
                  <th className="text-left px-4 py-3">Family</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.name} className="border-t border-bg-elevated/60">
                    <td className="px-4 py-3 font-medium text-text-primary">{model.name}</td>
                    <td className="px-4 py-3 text-text-muted">{formatBytes(model.size)}</td>
                    <td className="px-4 py-3 text-text-muted">{model.parameterSize || '—'}</td>
                    <td className="px-4 py-3 text-text-muted">{model.quantization || '—'}</td>
                    <td className="px-4 py-3 text-text-muted">{model.family || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-pill"
                          onClick={() => pair(model, 'claude-code')}
                          disabled={updating !== null}
                        >
                          {updating === `${model.name}:claude-code` ? 'Pairing...' : 'Pair Claude Code'}
                        </button>
                        <button
                          type="button"
                          className="btn-pill"
                          onClick={() => pair(model, 'opencode')}
                          disabled={updating !== null}
                        >
                          {updating === `${model.name}:opencode` ? 'Pairing...' : 'Pair OpenCode'}
                        </button>
                        <button
                          type="button"
                          className="btn-pill"
                          onClick={() => remove(model)}
                          disabled={updating !== null}
                        >
                          {updating === `${model.name}:delete` ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && models.length === 0 && (
            <div className="p-8 text-center text-text-muted">No installed Ollama models found.</div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
