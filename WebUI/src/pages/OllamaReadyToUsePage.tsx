import { useEffect, useState } from 'react';
import type { OllamaReadyModel, OllamaRuntime } from '../types';
import { ollamaApi } from '../services/ollamaApi';

function formatRuntime(runtime: OllamaRuntime): string {
  return runtime === 'claude-code' ? 'Claude Code' : 'OpenCode';
}

function formatEndpoint(endpoint: string): string {
  return endpoint.includes('ollama.com') ? 'Cloud' : 'Local';
}

export function OllamaReadyToUsePage() {
  const [models, setModels] = useState<OllamaReadyModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ollamaApi.getReadyModels();
      setModels(response.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ready models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (model: OllamaReadyModel) => {
    const key = `${model.modelName}:${model.runtime}`;
    setUpdating(key);
    setError(null);
    try {
      await ollamaApi.removeReadyModel(model.modelName, model.runtime);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove model');
    } finally {
      setUpdating(null);
    }
  };

  const changeRuntime = async (model: OllamaReadyModel, nextRuntime: OllamaRuntime) => {
    if (model.runtime === nextRuntime) return;
    const key = `${model.modelName}:${model.runtime}`;
    setUpdating(key);
    setError(null);
    try {
      await ollamaApi.changeRuntime(model.modelName, model.runtime, nextRuntime);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change runtime');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Ready to Use</h1>
        <p className="mt-2 text-sm text-text-muted">
          Models paired to runtimes and ready for orchestrator/coder/reviewer selection.
        </p>
      </div>

      {loading && (
        <div className="text-center py-4 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin mr-2" />
          Loading paired models...
        </div>
      )}

      {!loading && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-primary">
                <tr>
                  <th className="text-left px-4 py-3">Model Name</th>
                  <th className="text-left px-4 py-3">Runtime</th>
                  <th className="text-left px-4 py-3">Endpoint</th>
                  <th className="text-left px-4 py-3">Tool Support</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => {
                  const key = `${model.modelName}:${model.runtime}`;
                  const isUpdating = updating === key;
                  return (
                    <tr key={key} className="border-t border-bg-elevated/60">
                      <td className="px-4 py-3 font-medium text-text-primary">{model.modelName}</td>
                      <td className="px-4 py-3 text-text-muted">{formatRuntime(model.runtime)}</td>
                      <td className="px-4 py-3 text-text-muted">{formatEndpoint(model.endpoint)}</td>
                      <td className="px-4 py-3">
                        {model.supportsTools ? (
                          <span className="badge-success">Supports tools</span>
                        ) : (
                          <span className="badge-warning">No tools</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {model.available ? (
                          <span className="badge-success">Available</span>
                        ) : (
                          <span className="badge-danger">Unavailable</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <select
                            className="bg-bg-elevated rounded-full px-4 py-2"
                            value={model.runtime}
                            disabled={isUpdating}
                            onChange={(event) => changeRuntime(model, event.target.value as OllamaRuntime)}
                          >
                            <option value="claude-code">Claude Code</option>
                            <option value="opencode">OpenCode</option>
                          </select>
                          <button
                            type="button"
                            className="btn-pill"
                            disabled={isUpdating}
                            onClick={() => remove(model)}
                          >
                            {isUpdating ? 'Working...' : 'Remove'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!loading && models.length === 0 && (
            <div className="p-8 text-center text-text-muted">No paired Ollama models yet.</div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
