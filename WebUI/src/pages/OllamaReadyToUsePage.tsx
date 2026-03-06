import { useEffect, useState } from 'react';
import type { OllamaPairedModel } from '../types';
import { ollamaApi } from '../services/ollamaApi';

function formatRuntime(runtime: string): string {
  return runtime === 'claude-code' ? 'Claude Code' : runtime === 'opencode' ? 'OpenCode' : runtime;
}

export function OllamaReadyToUsePage() {
  const [models, setModels] = useState<OllamaPairedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ollamaApi.getPairedModels();
      setModels(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load paired models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleRemove = async (model: OllamaPairedModel) => {
    setRemoving(model.id);
    setError(null);
    try {
      await ollamaApi.unpairModel(model.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove pairing');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="card p-6">
        <h1 className="text-3xl font-bold text-text-primary">Ollama Ready to Use</h1>
        <p className="mt-2 text-sm text-text-muted">
          Ollama models paired with a runtime for use in Steroids tasks.
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
                  <th className="text-left px-4 py-3">Model</th>
                  <th className="text-left px-4 py-3">Runtime</th>
                  <th className="text-left px-4 py-3">Endpoint</th>
                  <th className="text-left px-4 py-3">Tool Support</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id} className="border-t border-bg-elevated/60">
                    <td className="px-4 py-3 font-medium text-text-primary">{model.model_name}</td>
                    <td className="px-4 py-3 text-text-muted">{formatRuntime(model.runtime)}</td>
                    <td className="px-4 py-3 text-text-muted truncate max-w-[200px]" title={model.endpoint}>
                      {model.endpoint}
                    </td>
                    <td className="px-4 py-3">
                      {model.supports_tools
                        ? <span className="badge-success">Yes</span>
                        : <span className="badge-warning">No</span>}
                    </td>
                    <td className="px-4 py-3">
                      {model.available
                        ? <span className="badge-success">Available</span>
                        : <span className="badge-danger">Unavailable</span>}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="btn-pill"
                        disabled={removing === model.id}
                        onClick={() => handleRemove(model)}
                      >
                        {removing === model.id ? 'Removing...' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!loading && models.length === 0 && (
            <div className="p-8 text-center text-text-muted">No paired Ollama models yet.</div>
          )}
        </div>
      )}

      {error && <div className="text-sm text-danger">{error}</div>}
    </div>
  );
}
